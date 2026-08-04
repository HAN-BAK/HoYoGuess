/* ============================================================
   Cloudflare Worker —— HoYoGuess 音频加速代理

   作用：浏览器请求 audio.mihoyo.cards/歌曲路径 时，
   由 Worker 从 Backblaze B2 拉取音频并返回，
   同时在 Cloudflare 边缘缓存一天，重复播放几乎秒开。

   需要配置的 Worker 密钥（Settings -> Variables and Secrets）：
   - B2_KEY_ID
   - B2_APPLICATION_KEY
   - B2_BUCKET_NAME
   ============================================================ */

const B2_ENDPOINT = 'https://api.backblazeb2.com';

// 缓存 B2 授权信息（Worker 实例级，令牌 24 小时有效，提前 1 小时刷新）
let AUTH = null;

async function getAuth(env) {
  if (AUTH && AUTH.expiresAt > Date.now() + 60 * 60 * 1000) {
    return AUTH;
  }
  const basic = btoa(env.B2_KEY_ID + ':' + env.B2_APPLICATION_KEY);
  const res = await fetch(B2_ENDPOINT + '/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + basic }
  });
  if (!res.ok) {
    throw new Error('B2 授权失败：' + res.status);
  }
  const data = await res.json();
  AUTH = {
    downloadUrl: data.downloadUrl,
    token: data.authorizationToken,
    expiresAt: Date.now() + 23 * 60 * 60 * 1000
  };
  return AUTH;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // URL 路径就是 B2 桶内的文件路径，例如 /原神/歌.mp3
    const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(fileName)) {
      return new Response('不支持的音频格式', { status: 400 });
    }

    const auth = await getAuth(env);
    // 拼出 B2 的下载地址（带授权令牌，令牌只存在于 Worker 内部）
    const target = auth.downloadUrl + '/file/' + env.B2_BUCKET_NAME + '/' +
      fileName.split('/').map(encodeURIComponent).join('/') +
      '?Authorization=' + encodeURIComponent(auth.token);

    const headers = { Authorization: auth.token };
    if (request.headers.get('range')) {
      headers.Range = request.headers.get('range');   // 支持进度条拖动
    }

    // 从 B2 拉取音频；cf.cacheTtl 让 Cloudflare 按文件路径缓存一天
    const upstream = await fetch(target, {
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
