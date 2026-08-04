/* ============================================================
   HoYoGuess 猜歌游戏 —— 后端服务器（入口文件）

   运行方式：
   - 本地开发：npm start（打开 http://localhost:3000）
   - Vercel 部署：本文件导出 Express 应用，由 Vercel 自动调用；
     app.listen 只在本地运行时才执行，部署时不会启动端口

   歌曲与背景音乐来源：Backblaze B2 云存储（私有桶）
   - 配置优先读取环境变量（Vercel 上必须配置）：
       B2_KEY_ID / B2_APPLICATION_KEY / B2_BUCKET_NAME / B2_ENDPOINT
   - 本地开发时也支持读取 config.js（含密钥，请勿外传）
   ============================================================ */

const express = require('express');   // Express 框架：用来创建网站服务器
const path = require('path');         // path：用来拼接文件路径（跨系统通用）

const app = express();                // 创建服务器对象
const PORT = 3000;                    // 本地开发时监听的端口号

// 读取本地配置文件（仅供本地开发；Vercel 上用环境变量，config.js 不会被上传）
let localConfig = null;
try {
  localConfig = require('./config.js');
} catch (err) {
  localConfig = null;
}

// 获取 B2 配置：环境变量优先，其次使用 config.js 里的值
function getB2Config() {
  const c = localConfig || {};
  return {
    endpoint: process.env.B2_ENDPOINT || c.b2Endpoint || 'https://api.backblazeb2.com',
    keyId: process.env.B2_KEY_ID || c.b2KeyId || '',
    applicationKey: process.env.B2_APPLICATION_KEY || c.b2ApplicationKey || '',
    bucketName: process.env.B2_BUCKET_NAME || c.b2BucketName || ''
  };
}

// 把 public 文件夹托管成网页根目录
// 浏览器访问网站根路径时会自动打开 public/index.html
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 网站图标 ----------
   浏览器标签页上的小图标，直接读取项目里的 icon.png */
app.get('/icon.png', function (req, res) {
  res.sendFile('icon.png', { root: __dirname }, function (err) {
    if (err) {
      res.status(404).send('图标不存在');
    }
  });
});

/* ================= B2 云存储相关 ================= */

let b2AuthCache = null;         // B2 登录令牌缓存（24 小时有效，提前 1 小时刷新）
let downloadAuthCache = null;   // 下载授权令牌缓存（1 小时有效）
let songListCache = null;       // 文件列表缓存（60 秒）
let songListCacheTime = 0;

// 向 B2 申请授权，拿到 apiUrl、downloadUrl 和登录令牌
async function getB2Auth() {
  const cfg = getB2Config();
  if (!cfg.keyId || !cfg.applicationKey) {
    throw new Error('缺少 B2 配置：请在 Vercel 环境变量中设置 B2_KEY_ID 和 B2_APPLICATION_KEY');
  }
  if (b2AuthCache && Date.now() < b2AuthCache.expiresAt) {
    return b2AuthCache;
  }

  // B2 的授权方式：用 密钥ID:密钥 做 Basic 认证
  const basic = Buffer.from(cfg.keyId + ':' + cfg.applicationKey).toString('base64');
  const res = await fetch(cfg.endpoint + '/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + basic }
  });
  if (!res.ok) {
    throw new Error('B2 授权失败（状态码 ' + res.status + '），请检查密钥是否正确');
  }
  const data = await res.json();

  b2AuthCache = {
    apiUrl: data.apiUrl,                     // 列表等操作使用的地址
    downloadUrl: data.downloadUrl,           // 下载地址
    token: data.authorizationToken,          // 登录令牌
    accountId: data.accountId,
    bucketId: data.allowed ? data.allowed.bucketId : null,  // 密钥若已绑定桶，直接得到桶 ID
    expiresAt: Date.now() + 23 * 60 * 60 * 1000
  };
  return b2AuthCache;
}

// 根据桶名找到 bucketId（密钥没绑定固定桶时才需要）
async function getBucketId(auth) {
  if (auth.bucketId) {
    return auth.bucketId;
  }
  const cfg = getB2Config();
  const res = await fetch(auth.apiUrl + '/b2api/v2/b2_list_buckets', {
    method: 'POST',
    headers: { Authorization: auth.token },
    body: JSON.stringify({ accountId: auth.accountId })
  });
  if (!res.ok) {
    throw new Error('B2 获取桶列表失败（状态码 ' + res.status + '）');
  }
  const data = await res.json();
  const bucket = (data.buckets || []).find(function (b) {
    return b.bucketName === cfg.bucketName;
  });
  if (!bucket) {
    throw new Error('找不到名为 ' + cfg.bucketName + ' 的桶');
  }
  return bucket.bucketId;
}

// 列出桶里所有文件（完整路径，例如 "原神/战斗音乐/歌.mp3"）
async function listAllFiles() {
  const auth = await getB2Auth();
  const bucketId = await getBucketId(auth);
  const files = [];
  let nextFileName = null;

  // B2 一次最多返回 10000 个文件，用 startFileName 翻页直到取完
  do {
    const body = { bucketId: bucketId, maxFileCount: 10000 };
    if (nextFileName) {
      body.startFileName = nextFileName;
    }
    const res = await fetch(auth.apiUrl + '/b2api/v2/b2_list_file_names', {
      method: 'POST',
      headers: { Authorization: auth.token },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error('B2 读取文件列表失败（状态码 ' + res.status + '）');
    }
    const data = await res.json();
    for (const f of data.files || []) {
      files.push(f.fileName);
    }
    nextFileName = data.nextFileName || null;
  } while (nextFileName);

  return files;
}

// 带 60 秒缓存的文件列表
async function getFileListCached() {
  if (songListCache && Date.now() - songListCacheTime < 60 * 1000) {
    return songListCache;
  }
  const files = await listAllFiles();
  songListCache = files;
  songListCacheTime = Date.now();
  return files;
}

// 生成一个可复用的“下载授权令牌”（1 小时有效，到期自动重新生成）
async function getDownloadToken(auth) {
  if (downloadAuthCache && Date.now() < downloadAuthCache.expiresAt) {
    return downloadAuthCache.token;
  }
  const bucketId = await getBucketId(auth);
  const res = await fetch(auth.apiUrl + '/b2api/v2/b2_get_download_authorization', {
    method: 'POST',
    headers: { Authorization: auth.token },
    body: JSON.stringify({
      bucketId: bucketId,
      fileNamePrefix: '',        // 空前缀 = 允许下载桶里所有文件
      validDurationInSeconds: 3600
    })
  });
  if (!res.ok) {
    throw new Error('B2 生成下载授权失败（状态码 ' + res.status + '）');
  }
  const data = await res.json();
  downloadAuthCache = {
    token: data.authorizationToken,
    expiresAt: Date.now() + 55 * 60 * 1000   // 提前 5 分钟刷新
  };
  return downloadAuthCache.token;
}

// 生成某个文件的临时授权下载链接（浏览器拿到后可直接播放）
async function getAuthorizedUrl(fileName) {
  const auth = await getB2Auth();
  const token = await getDownloadToken(auth);
  const cfg = getB2Config();
  return auth.downloadUrl + '/file/' + encodeURIComponent(cfg.bucketName) + '/' +
    fileName.split('/').map(encodeURIComponent).join('/') +
    '?Authorization=' + encodeURIComponent(token);
}

/* ---------- API 1：获取歌单（B2） ----------
   返回 B2 桶里除 BGMusic/ 文件夹以外的所有 .mp3，
   格式和原来一样：["原神/歌1", "歌2"] */
app.get('/api/songs', async function (req, res) {
  try {
    const all = await getFileListCached();
    const songNames = all
      .filter(function (f) {
        // 只保留 mp3，并且排除背景音乐文件夹里的文件
        return f.toLowerCase().endsWith('.mp3') && !f.startsWith('BGMusic/');
      })
      .map(function (f) { return f.replace(/\\/g, '/').replace(/\.mp3$/i, ''); });
    res.json(songNames);
  } catch (err) {
    console.log('获取歌单出错：', err.message);
    res.json([]);                  // 出错时返回空列表，前端会给出提示
  }
});

/* ---------- API 2：获取背景音乐列表（B2 桶中的 BGMusic/ 文件夹） ---------- */
app.get('/api/bgmusic', async function (req, res) {
  try {
    const all = await getFileListCached();
    const bgmFiles = all.filter(function (f) {
      return f.startsWith('BGMusic/') && /\.(mp3|wav|ogg|m4a|flac)$/i.test(f);
    });
    res.json(bgmFiles);
  } catch (err) {
    console.log('获取背景音乐列表出错：', err.message);
    res.json([]);
  }
});

/* ---------- 歌曲播放接口：/audio/路径/歌名.mp3 ----------
   服务器生成一个临时授权下载链接，然后 302 跳转，
   浏览器直接从 B2 播放（不再经过服务器转发，节省流量也没有时长限制） */
app.get('/audio/*', async function (req, res) {
  try {
    const relPath = decodeURIComponent(req.params[0]);
    if (!relPath.toLowerCase().endsWith('.mp3')) {
      return res.status(400).send('只支持 mp3 格式');
    }
    const url = await getAuthorizedUrl(relPath);
    res.redirect(302, url);
  } catch (err) {
    console.log('歌曲地址生成出错：', err.message);
    if (!res.headersSent) {
      res.status(500).send('歌曲加载失败：' + err.message);
    }
  }
});

/* ---------- 背景音乐播放接口：/bgmusic/路径/文件 ---------- */
app.get('/bgmusic/*', async function (req, res) {
  try {
    const relPath = decodeURIComponent(req.params[0]);
    if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(relPath)) {
      return res.status(400).send('不支持的音频格式');
    }
    const url = await getAuthorizedUrl(relPath);
    res.redirect(302, url);
  } catch (err) {
    console.log('背景音乐地址生成出错：', err.message);
    if (!res.headersSent) {
      res.status(500).send('背景音乐加载失败：' + err.message);
    }
  }
});

/* ---------- 导出 + 本地启动 ---------- */
// Vercel 部署：导出 Express 应用，由 Vercel 的 Node 运行时调用
module.exports = app;

// 本地开发：只有直接运行 node server.js 时才启动监听端口
if (require.main === module) {
  const server = app.listen(PORT, function () {
    console.log('========================================');
    console.log('  HoYoGuess 已启动！');
    console.log('  歌曲来源：Backblaze B2');
    console.log('  请用浏览器打开: http://localhost:' + PORT);
    console.log('========================================');
  });

  // 如果端口被占用，给用户一个友好的提示
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.log('端口 ' + PORT + ' 已被占用，请关闭占用该端口的程序后重试。');
    } else {
      console.log('服务器启动出错：', err.message);
    }
  });
}
