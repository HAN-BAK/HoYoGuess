/* ============================================================
   Cloudflare Worker —— HoYoGuess 音频加速代理

   作用：浏览器请求 audio.hoyoguess.com/歌曲路径 时，
   由 Worker 从缤纷云 S4 拉取音频并返回，
   同时在 Cloudflare 边缘缓存一天，重复播放几乎秒开。
   缤纷云每月只有 10G 流量，走 Cloudflare 缓存可以大幅省流量。

   需要配置的 Worker 密钥（Settings -> Variables and Secrets）：
   - S3_ACCESS_KEY   （缤纷云 Access Key）
   - S3_SECRET_KEY   （缤纷云 Secret Key）
   - S3_BUCKET_NAME  （桶名，例如 hoyo-music）
   - S3_REGION       （区域，填 cn-east-1）
   ============================================================ */

const S3_HOST = 's3.bitiful.net';   // 缤纷云 S3 接口域名

/* ---------- 以下是从零实现 AWS S3 签名（SigV4）----------
   缤纷云是私有桶，直接请求会返回 403，
   所以 Worker 要自己给每个请求“签名”，证明有权限读取。
   AWS S3 的签名算法是公开标准，不需要第三方库。 */

// 把字节数组转成十六进制字符串（签名结果就是十六进制）
function toHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map(function (b) { return b.toString(16).padStart(2, '0'); })
    .join('');
}

// HMAC-SHA256 计算（Web Crypto 标准接口，Worker 自带）
async function hmac(key, data) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, dataBytes));
}

// SHA-256 哈希，结果转十六进制
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest);
}

// 根据桶内文件路径，生成一个带 AWS 签名的下载地址和请求头
async function buildSignedRequest(env, fileName) {
  // 缤纷云桶的访问地址格式：https://桶名.s3.bitiful.net/文件路径
  const host = env.S3_BUCKET_NAME + '.' + S3_HOST;
  // 把路径的每一段都做 URL 编码（中文文件名也能正确处理）
  const canonicalUri = '/' + fileName.split('/').map(encodeURIComponent).join('/');

  // 当前时间（AWS 格式，例如 20260806T123456Z）
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // 空内容的 SHA-256（GET 请求没有请求体，固定用这个值）
  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  // 参与签名的请求头（按字母顺序排列）
  const canonicalHeaders =
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  // 规范请求（AWS 签名算法的固定格式）
  const canonicalRequest =
    'GET\n' + canonicalUri + '\n\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;

  // 签名范围：日期/区域/s3/aws4_request
  const scope = dateStamp + '/' + env.S3_REGION + '/s3/aws4_request';
  const stringToSign =
    'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + await sha256Hex(canonicalRequest);

  // 用 Secret Key 逐级算出签名密钥
  const kDate = await hmac('AWS4' + env.S3_SECRET_KEY, dateStamp);
  const kRegion = await hmac(kDate, env.S3_REGION);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  // 拼出 Authorization 请求头
  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + env.S3_ACCESS_KEY + '/' + scope +
    ', SignedHeaders=' + signedHeaders +
    ', Signature=' + signature;

  return {
    url: 'https://' + host + canonicalUri,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': authorization
    }
  };
}

export default {
  async fetch(request, env) {
    // 防止没有配置密钥时直接报错，先做检查
    if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY || !env.S3_BUCKET_NAME || !env.S3_REGION) {
      return new Response('Worker 缺少 S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET_NAME / S3_REGION 配置', { status: 500 });
    }

    const url = new URL(request.url);
    // URL 路径就是桶内的文件路径，例如 /原神/歌.mp3
    const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(fileName)) {
      return new Response('不支持的音频格式', { status: 400 });
    }

    // 生成带签名的缤纷云请求
    const signed = await buildSignedRequest(env, fileName);
    const headers = { ...signed.headers };
    const range = request.headers.get('range');
    if (range) {
      headers.Range = range;   // 支持进度条拖动（分段请求）
    }

    // 从缤纷云拉取音频；cf.cacheTtl 让 Cloudflare 按文件路径缓存一天
    const upstream = await fetch(signed.url, {
      headers,
      cf: {
        cacheTtl: 86400,
        cacheKey: url.origin + url.pathname
      }
    });

    const resp = new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers
    });
    resp.headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    resp.headers.set('Access-Control-Allow-Origin', '*');
    return resp;
  }
};
