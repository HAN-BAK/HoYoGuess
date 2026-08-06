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

// 拉取音频：遇到 Cloudflare 回源超时（522）等 5xx 错误时自动重试，
// 避免偶发的网络抖动导致歌曲加载失败（第一次失败，第二次往往就成功了）
async function fetchWithRetry(target, init, attempts) {
  let lastRes = null;
  for (let i = 0; i < attempts; i++) {
    lastRes = await fetch(target, init);
    if (lastRes.status < 500) {
      return lastRes;   // 正常响应（200 / 206 / 404 等），直接返回
    }
    // 5xx 错误：稍等片刻再试一次（400ms、800ms 递增）
    await new Promise(function (resolve) { setTimeout(resolve, 400 * (i + 1)); });
  }
  return lastRes;   // 重试完仍然失败，返回最后一次结果
}

/* ---------- 歌单 / 背景音乐列表接口 ----------
   Vercel 服务器在美国，直接访问中国的缤纷云列列表又慢又不稳定，
   所以列表也改由 Cloudflare Worker 读取，并在边缘缓存 10 分钟，
   全球访问都快，也不会频繁消耗缤纷云的请求次数 */

// 简单解码 XML 里转义的特殊字符（歌名里可能含有 & < > 等）
function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

// 分页列出桶里所有文件（每页 1000 个，最多 10 页）
async function listAllKeys(env) {
  const host = env.S3_BUCKET_NAME + '.' + S3_HOST;
  const keys = [];
  let token = '';
  let truncated = true;
  let pages = 0;
  while (truncated && pages < 10) {
    pages++;
    const params = [['list-type', '2'], ['max-keys', '1000']];
    if (token) params.push(['continuation-token', token]);
    // 查询参数必须按名字排序并编码（AWS 签名要求）
    const qs = params
      .sort(function (a, b) { return a[0] < b[0] ? -1 : 1; })
      .map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); })
      .join('&');

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const canonicalHeaders =
      'host:' + host + '\n' +
      'x-amz-content-sha256:' + payloadHash + '\n' +
      'x-amz-date:' + amzDate + '\n';
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = 'GET\n/\n' + qs + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + payloadHash;
    const scope = dateStamp + '/' + env.S3_REGION + '/s3/aws4_request';
    const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + await sha256Hex(canonicalRequest);
    const kDate = await hmac('AWS4' + env.S3_SECRET_KEY, dateStamp);
    const kRegion = await hmac(kDate, env.S3_REGION);
    const kService = await hmac(kRegion, 's3');
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = toHex(await hmac(kSigning, stringToSign));
    const headers = {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Authorization': 'AWS4-HMAC-SHA256 Credential=' + env.S3_ACCESS_KEY + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
    };
    const res = await fetchWithRetry('https://' + host + '/?' + qs, { headers }, 3);
    if (!res.ok) throw new Error('列表请求失败: ' + res.status);
    const xml = await res.text();
    const pageKeys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)]
      .map(function (m) { return decodeXml(m[1]); });
    keys.push(...pageKeys);
    truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const m = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    token = m ? decodeXml(m[1]) : '';
  }
  return keys;
}

// 处理 /api/songs 和 /api/bgmusic（结果在 Cloudflare 边缘缓存 10 分钟）
async function handleList(request, env, isBgm) {
  const cached = await caches.default.match(request);
  if (cached) return cached;   // 边缘已有缓存，直接返回（又快又不消耗缤纷云请求）

  const keys = await listAllKeys(env);
  let result;
  if (isBgm) {
    result = keys.filter(function (k) {
      return k.startsWith('BGMusic/') && /\.(mp3|wav|ogg|m4a|flac)$/i.test(k);
    });
  } else {
    result = keys
      .filter(function (k) { return k.toLowerCase().endsWith('.mp3') && !k.startsWith('BGMusic/'); })
      .map(function (k) { return k.replace(/\\/g, '/').replace(/\.mp3$/i, ''); });
  }
  const resp = new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=600',
      'Access-Control-Allow-Origin': '*'
    }
  });
  // 写入边缘缓存（10 分钟），缓存键就是请求地址
  try { await caches.default.put(request, resp.clone()); } catch (e) {}
  return resp;
}

export default {
  async fetch(request, env) {
    // 防止没有配置密钥时直接报错，先做检查
    if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY || !env.S3_BUCKET_NAME || !env.S3_REGION) {
      return new Response('Worker 缺少 S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET_NAME / S3_REGION 配置', { status: 500 });
    }

    const url = new URL(request.url);
    // 列表接口：/api/songs、/api/bgmusic 由 Worker 读取并缓存
    if (url.pathname === '/api/songs') return handleList(request, env, false);
    if (url.pathname === '/api/bgmusic') return handleList(request, env, true);
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
    const upstream = await fetchWithRetry(signed.url, {
      headers,
      cf: {
        cacheTtl: 86400,
        cacheKey: url.origin + url.pathname
      }
    }, 3);

    const resp = new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers
    });
    resp.headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    resp.headers.set('Access-Control-Allow-Origin', '*');
    return resp;
  }
};
