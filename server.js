/* ============================================================
   HoYoGuess 猜歌游戏 —— 后端服务器（入口文件）

   运行方式：
   - 本地开发：npm start（打开 http://localhost:3000）
   - Vercel 部署：本文件导出 Express 应用，由 Vercel 自动调用；
     app.listen 只在本地运行时才执行，部署时不会启动端口

   歌曲与背景音乐来源：缤纷云 S4 云存储（S3 兼容、私有桶）
   - 配置优先读取环境变量（Vercel 上必须配置）：
       S3_ENDPOINT     = https://s3.bitiful.net
       S3_REGION       = cn-east-1
       S3_ACCESS_KEY   = 你的 Access Key
       S3_SECRET_KEY   = 你的 Secret Key
       S3_BUCKET_NAME  = 你的桶名（例如 hoyo-music）
       可选 CDN_BASE   = https://audio.hoyoguess.com（配置后音频走 Cloudflare CDN）
   - 本地开发时也支持读取 config.js（含密钥，请勿外传）
   ============================================================ */

const express = require('express');   // Express 框架：用来创建网站服务器
const path = require('path');         // path：用来拼接文件路径（跨系统通用）

// AWS 官方 S3 SDK：缤纷云兼容 S3 协议，所以可以直接用同一套 SDK
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();                // 创建服务器对象
const PORT = 3000;                    // 本地开发时监听的端口号

// 读取本地配置文件（仅供本地开发；Vercel 上用环境变量，config.js 不会被上传）
let localConfig = null;
try {
  localConfig = require('./config.js');
} catch (err) {
  localConfig = null;
}

// 获取缤纷云配置：环境变量优先，其次使用 config.js 里的值
function getS3Config() {
  const c = localConfig || {};
  return {
    endpoint: process.env.S3_ENDPOINT || c.s3Endpoint || 'https://s3.bitiful.net',
    region: process.env.S3_REGION || c.s3Region || 'cn-east-1',
    accessKey: process.env.S3_ACCESS_KEY || c.s3AccessKey || '',
    secretKey: process.env.S3_SECRET_KEY || c.s3SecretKey || '',
    bucketName: process.env.S3_BUCKET_NAME || c.s3BucketName || '',
    // 可选：音频 CDN 地址（例如 https://audio.hoyoguess.com），配置后音频改走 CDN
    cdnBase: process.env.CDN_BASE || c.cdnBase || ''
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

/* ================= 缤纷云（S3）相关 ================= */

let s3Client = null;         // S3 客户端（全局复用同一个实例）
let songListCache = null;    // 文件列表缓存（60 秒）
let songListCacheTime = 0;

// 创建并复用 S3 客户端（包含密钥信息）
function getS3Client() {
  if (s3Client) return s3Client;
  const cfg = getS3Config();
  if (!cfg.accessKey || !cfg.secretKey) {
    throw new Error('缺少缤纷云配置：请在 Vercel 环境变量中设置 S3_ACCESS_KEY 和 S3_SECRET_KEY');
  }
  s3Client = new S3Client({
    region: cfg.region,                    // 区域：cn-east-1
    endpoint: cfg.endpoint,                // 缤纷云 S3 接口地址
    credentials: {
      accessKeyId: cfg.accessKey,          // Access Key
      secretAccessKey: cfg.secretKey       // Secret Key
    }
  });
  return s3Client;
}

// 列出桶里所有文件（完整路径，例如 "原神/战斗音乐/歌.mp3"）
async function listAllFiles() {
  const cfg = getS3Config();
  const files = [];
  let token = undefined;

  // S3 一次最多返回 1000 个文件，用 ContinuationToken 翻页直到取完
  do {
    const command = new ListObjectsV2Command({
      Bucket: cfg.bucketName,
      ContinuationToken: token
    });
    const data = await getS3Client().send(command);
    for (const obj of data.Contents || []) {
      files.push(obj.Key);
    }
    token = data.IsTruncated ? data.NextContinuationToken : undefined;
  } while (token);

  return files;
}

// 带 10 分钟缓存的文件列表（避免每次请求都去云存储翻一遍）
async function getFileListCached() {
  if (songListCache && Date.now() - songListCacheTime < 10 * 60 * 1000) {
    return songListCache;
  }
  const files = await listAllFiles();
  songListCache = files;
  songListCacheTime = Date.now();
  return files;
}

// 生成某个文件的播放地址：
// - 配置了 CDN 时，直接使用 CDN 地址（令牌由 CDN Worker 自己处理，浏览器 URL 里不含密钥）
// - 未配置 CDN 时，生成缤纷云的临时签名链接（1 小时有效，到期自动失效）
async function getAuthorizedUrl(fileName) {
  const cfg = getS3Config();
  const pathPart = fileName.split('/').map(encodeURIComponent).join('/');
  if (cfg.cdnBase) {
    return cfg.cdnBase + '/' + pathPart;
  }
  const command = new GetObjectCommand({
    Bucket: cfg.bucketName,
    Key: fileName
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: 3600 });
}

/* ---------- API 1：获取歌单（缤纷云） ----------
   返回桶里除 BGMusic/ 文件夹以外的所有 .mp3，
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

/* ---------- API 2：获取背景音乐列表（桶中的 BGMusic/ 文件夹） ---------- */
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
   服务器生成一个临时播放地址，然后 302 跳转，
   浏览器直接播放（走 CDN 或直接连缤纷云，不经过服务器转发） */
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
    console.log('  歌曲来源：缤纷云 S4（S3 兼容）');
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
