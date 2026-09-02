/* 共享导航 - 零依赖后端
 * 功能：静态文件服务 + AI 自动识别写入（/api/recognize、/api/save）
 * 运行：node server.js   （默认端口 8787，可用 PORT 环境变量覆盖）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = process.env.PORT || 8787;
const DATA_FILE = path.join(ROOT, 'data', 'sites.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- AI 配置（可在 config.json 或环境变量中设置） ---------- */
const DEFAULT_CFG = {
  AI_API_BASE: 'https://api.siliconflow.cn/v1',     // OpenAI 兼容接口，可换 DeepSeek / OpenRouter / Groq 等
  AI_API_KEY: '',                                    // 免费大模型 Key（留空则走“无 AI 启发式识别”）
  AI_MODEL: 'Qwen/Qwen2.5-7B-Instruct',              // 免费模型示例
  AI_TIMEOUT: 15000,
  ADMIN_USER: 'admin',                               // 后台管理员账号
  ADMIN_PASSWORD: '',                                // 后台管理员密码（留空=尚未初始化）
  ADMIN_REQUIRED: true,                              // 是否强制登录（true=关闭开放进入后台）
  SESSION_SECRET: ''                                 // 会话签名密钥（首次运行自动生成）
};

const CONFIG_FILE = path.join(ROOT, 'config.json');

function loadConfig() {
  let cfg = { ...DEFAULT_CFG };
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
    catch (e) { console.warn('[config] 读取 config.json 失败，使用默认值'); }
  }
  // 环境变量优先
  cfg.AI_API_BASE = process.env.AI_API_BASE || cfg.AI_API_BASE;
  cfg.AI_API_KEY = process.env.AI_API_KEY || cfg.AI_API_KEY;
  cfg.AI_MODEL = process.env.AI_MODEL || cfg.AI_MODEL;
  cfg.ADMIN_USER = process.env.ADMIN_USER || cfg.ADMIN_USER;
  cfg.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || cfg.ADMIN_PASSWORD;
  if (process.env.ADMIN_REQUIRED === 'false' || process.env.ADMIN_REQUIRED === '0') cfg.ADMIN_REQUIRED = false;
  if (process.env.ADMIN_REQUIRED === 'true' || process.env.ADMIN_REQUIRED === '1') cfg.ADMIN_REQUIRED = true;
  // 会话签名密钥：缺失则生成并持久化，避免每次重启后所有登录态失效
  if (!cfg.SESSION_SECRET) {
    cfg.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    persistConfig(cfg);
  }
  return cfg;
}

// 持久化配置：保留文件中已有的其他键，避免覆盖未知字段
function persistConfig(cfg) {
  let existing = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch (e) { existing = {}; }
  }
  const merged = { ...existing, ...cfg };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

const CFG = loadConfig();
const AI_ENABLED = !!CFG.AI_API_KEY;
CFG.AI_ENABLED = AI_ENABLED;

/* ---------- 登录会话（HMAC 签名 token，不使用明文密码传输） ---------- */
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 勾选“记住登录”时的有效期：30 天
const SESSION_TTL_SHORT = 12 * 3600 * 1000; // 未勾选时：12 小时

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function signPayload(payload) {
  return crypto.createHmac('sha256', CFG.SESSION_SECRET).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function issueToken(user, ttlMs, remember) {
  const exp = Date.now() + (ttlMs || (remember ? TOKEN_TTL : 12 * 3600 * 1000));
  const payload = b64url(JSON.stringify({ u: user, exp }));
  return { token: payload + '.' + signPayload(payload), exp, user };
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx), sig = token.slice(idx + 1);
  if (!payload || !sig) return null;
  const expect = signPayload(payload);
  // 定长比较，防止时序侧信道
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const obj = JSON.parse(b64urlDecode(payload));
    if (!obj || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    return obj;
  } catch (e) { return null; }
}
function tokenFromReq(req) {
  const auth = String(req.headers['authorization'] || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-admin-token'] ? String(req.headers['x-admin-token']) : '';
}
// 是否已登录：支持 Bearer token；兼容旧的 X-Admin-Password 明文头
function isAuthed(req) {
  if (!CFG.ADMIN_REQUIRED) return true;
  if (verifyToken(tokenFromReq(req))) return true;
  const pwd = req.headers['x-admin-password'];
  return !!(pwd && CFG.ADMIN_PASSWORD && pwd === CFG.ADMIN_PASSWORD);
}
function authUser(req) {
  const s = verifyToken(tokenFromReq(req));
  return s ? s.u : null;
}

/* 登录暴力破解防护：同一来源连续失败 8 次后冷却 5 分钟（进程内存，重启即清） */
const LOGIN_ATTEMPTS = new Map();
const MAX_ATTEMPTS = 8;
const COOLDOWN_MS = 5 * 60 * 1000;
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}
function throttleCheck(ip) {
  const rec = LOGIN_ATTEMPTS.get(ip);
  if (!rec || !rec.until) return 0;
  if (Date.now() > rec.until) { LOGIN_ATTEMPTS.delete(ip); return 0; }
  return rec.until - Date.now();
}
function throttleFail(ip) {
  const rec = LOGIN_ATTEMPTS.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= MAX_ATTEMPTS) { rec.until = Date.now() + COOLDOWN_MS; rec.n = 0; }
  LOGIN_ATTEMPTS.set(ip, rec);
  return rec.n;
}
function throttleReset(ip) { LOGIN_ATTEMPTS.delete(ip); }

/* ---------- 工具 ---------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5e6) { reject(new Error('请求体过大')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'cat';
}

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  syncDataJs(data);
}

/* 同步生成 data/sites.js：以 file:// 直接打开页面时浏览器会拦截 fetch，
 * 前端会退回用 <script> 标签读取该文件（脚本标签不受 file:// 限制）。 */
function syncDataJs(data) {
  try {
    const js = '/* 自动生成，请勿手工修改：由 data/sites.json 同步而来。\n' +
      ' * 供以 file:// 方式直接打开 index.html 时兜底读取。\n */\n' +
      'window.__NAV_DATA__ = ' + JSON.stringify(data) + ';\n';
    fs.writeFileSync(path.join(ROOT, 'data', 'sites.js'), js, 'utf8');
  } catch (e) {
    console.warn('[data] 生成 data/sites.js 失败：' + e.message);
  }
}

/* ---------- 网页抓取与元信息提取 ---------- */
async function fetchMeta(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NavBot/1.0; +https://example.com/bot)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    // 只读取前 256KB，避免大页面
    const buf = await resp.arrayBuffer();
    const html = Buffer.from(buf.slice(0, 256 * 1024)).toString('utf8');
    return extractMeta(html, targetUrl);
  } finally {
    clearTimeout(timer);
  }
}

function extractMeta(html, targetUrl) {
  const get = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1].trim()) : '';
  };
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const desc = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const ogImage = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  let hostname = '';
  try { hostname = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
  return { title, desc, ogImage, hostname, url: targetUrl };
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/* ---------- 调用免费大模型 ---------- */
async function aiRecognize(meta, categories) {
  const catList = categories.map((c) => c.name).join('、');
  const prompt = `你是一个网址导航站的内容收录助手。根据用户提供的网页信息，输出该网站的标准导航卡片，必须只返回 JSON（不要任何解释、不要 markdown 代码块），字段如下：
{
  "name": "站点简称（简洁，中文或英文，不超过 12 字）",
  "desc": "一句话中文简介（不超过 30 字）",
  "category": "从已有分类中选择最合适的一个，若都不合适可给出新分类名",
  "icon": "站点图标 URL（优先用 favicon，例如 https://${meta.hostname}/favicon.ico；如果没有就留空字符串）"
}
已有分类：${catList}
网页信息：
- 标题：${meta.title || '(无)'}
- 描述：${meta.desc || '(无)'}
- 网址：${meta.url}
- 域名：${meta.hostname}
请直接输出 JSON。`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.AI_TIMEOUT);
  try {
    const resp = await fetch(CFG.AI_API_BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + CFG.AI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: CFG.AI_MODEL,
        temperature: 0.3,
        messages: [
          { role: 'system', content: '你是导航站收录助手，只输出 JSON。' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('AI 接口错误 ' + resp.status + ' ' + txt.slice(0, 200));
    }
    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content || '{}';
    return parseJSONCard(content, meta);
  } finally {
    clearTimeout(timer);
  }
}

function parseJSONCard(content, meta) {
  let txt = content.trim();
  // 去掉 ```json ... ``` 包裹
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  const obj = JSON.parse(txt);
  return {
    name: (obj.name || meta.title || meta.hostname || '未命名').toString().slice(0, 40),
    desc: (obj.desc || meta.desc || '').toString().slice(0, 60),
    category: (obj.category || '').toString().trim(),
    icon: (obj.icon || '').toString().trim()
  };
}

/* 无 AI 时的启发式识别 */
function heuristicRecognize(meta, categories) {
  // 默认落到现有第一个分类（「常用推荐」已移除，此处若写死旧名会自动把分类重建回来）
  let category = (Array.isArray(categories) && categories[0] && categories[0].name) || '未分类';
  const pool = (meta.title + ' ' + meta.hostname + ' ' + meta.desc).toLowerCase();
  const kwMap = {
    '社区咨询': ['社区', '论坛', 'news', '社区', 'bbs'],
    '图标素材': ['icon', '图标'],
    '字体资源': ['font', '字体'],
    '摄影图库': ['photo', 'image', '图库', '摄影'],
    '在线工具': ['tool', '工具', 'convert', '压缩'],
    '在线配色': ['color', '配色'],
    'UI资源': ['ui', 'sketch', 'figma'],
    '视频教程': ['video', '教程', 'course']
  };
  for (const [cat, kws] of Object.entries(kwMap)) {
    if (kws.some((k) => pool.includes(k))) { category = cat; break; }
  }
  const icon = `https://icons.duckduckgo.com/ip3/${meta.hostname}.ico`;
  return {
    name: (meta.title || meta.hostname || '未命名').split(/[|—\-·]/)[0].trim().slice(0, 20) || meta.hostname,
    desc: (meta.desc || meta.hostname).slice(0, 50),
    category,
    icon
  };
}

/* ---------- 写入数据 ---------- */
function upsertCard(card) {
  const data = loadData();
  const cats = data.categories || (data.categories = []);
  let cat = null;
  // 按分类名查找（兼容 AI 给的新分类名）
  cat = cats.find((c) => c.name === card.category);
  if (!cat && card.category) {
    cat = { id: slug(card.category), name: card.category, icon: '🆕', links: [] };
    cats.push(cat);
  }
  if (!cat) cat = cats[0]; // 兜底
  cat.links = cat.links || [];

  const link = {
    name: card.name,
    url: card.url,
    desc: card.desc || '',
    icon: card.icon || ''
  };
  // 去重：同 url 则更新
  const idx = cat.links.findIndex((l) => l.url === card.url);
  if (idx >= 0) cat.links[idx] = { ...cat.links[idx], ...link };
  else cat.links.push(link);

  saveData(data);
  return { category: cat.name, link };
}

/* ---------- 路由 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

/* ---------- 在线壁纸库数据源 ---------- */
async function fetchJSON(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    if (!r.ok) throw new Error('上游返回 HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function fetchWallpapers(source, page, q) {
  if (source === 'bing') {
    // Bing 每日壁纸：idx 为偏移量，n 为数量
    const n = 8;
    const idx = (page - 1) * n;
    const j = await fetchJSON(`https://cn.bing.com/HPImageArchive.aspx?format=js&idx=${idx}&n=${n}&mkt=zh-CN`);
    return (j.images || []).map((im) => ({
      url: 'https://cn.bing.com' + (im.url || ''),
      thumb: 'https://cn.bing.com' + (im.urlbase || '') + '_400x240.jpg',
      title: (im.copyright || im.title || 'Bing 每日壁纸').toString()
    })).filter((x) => x.url && x.url !== 'https://cn.bing.com');
  }

  if (source === '360') {
    // 360 壁纸：cid 为分类 id，q 可传入分类 id
    const start = (page - 1) * 20;
    const cid = String(q || 1).replace(/\D/g, '') || '1';
    const j = await fetchJSON(`https://wallpaper.apc.360.cn/index.php?c=WallPaperAndroid&a=getAppsByCategory&cid=${cid}&start=${start}&count=20`);
    const arr = (j && j.data) || [];
    return arr.map((it) => ({
      url: it.url || it.img || '',
      thumb: it.thumb || it.small || it.url || '',
      title: (it.name || it.title || '360 壁纸').toString()
    })).filter((x) => x.url);
  }

  if (source === 'wallhaven') {
    const p = Math.max(1, page);
    const query = encodeURIComponent(q || 'landscape');
    const j = await fetchJSON(`https://wallhaven.cc/api/v1/search?q=${query}&sorting=relevance&page=${p}&categories=111&purity=100`);
    return (j.data || []).map((it) => ({
      url: it.path || '',
      thumb: (it.thumbs && (it.thumbs.small || it.thumbs.large)) || it.path || '',
      title: 'Wallhaven #' + it.id
    })).filter((x) => x.url);
  }

  throw new Error('不支持的壁纸源：' + source);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { // 防目录穿越
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // 写接口鉴权：开启登录保护后，写操作需带 Bearer 会话 token
    const PROTECTED = ['/api/sites', '/api/save', '/api/recognize', '/api/config', '/api/upload'];
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && PROTECTED.includes(pathname)) {
      if (!isAuthed(req)) {
        return sendJSON(res, 401, { error: '请先登录后台', needAuth: true });
      }
    }

    if (pathname === '/api/sites' && req.method === 'GET') {
      const data = loadData();
      return sendJSON(res, 200, data);
    }

    if (pathname === '/api/recognize' && req.method === 'POST') {
      const body = await readBody(req);
      const target = (body.url || '').trim();
      if (!target || !/^https?:\/\//i.test(target)) {
        return sendJSON(res, 400, { error: '请提供合法的 http(s) 网址' });
      }
      let meta;
      try { meta = await fetchMeta(target); }
      catch (e) { return sendJSON(res, 502, { error: '抓取网页失败：' + e.message }); }

      const data = loadData();
      let card;
      let source = 'heuristic';
      if (CFG.AI_ENABLED) {
        try { card = await aiRecognize(meta, data.categories); source = 'ai'; }
        catch (e) {
          console.warn('[ai] 识别失败，回退启发式：', e.message);
          card = heuristicRecognize(meta, data.categories);
          source = 'heuristic-fallback';
        }
      } else {
        card = heuristicRecognize(meta, data.categories);
      }
      card.url = target;
      return sendJSON(res, 200, { source, ...card });
    }

    if (pathname === '/api/save' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.url) return sendJSON(res, 400, { error: '缺少 url' });
      const result = upsertCard(body);
      return sendJSON(res, 200, { ok: true, ...result });
    }

    /* 全量保存：管理控制台整体覆盖 data/sites.json（用于增删改/排序/分类管理） */
    if (pathname === '/api/sites' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.categories)) {
        return sendJSON(res, 400, { error: '数据格式错误：缺少 categories 数组' });
      }
      body.site = body.site || {};
      const seen = new Set();
      body.categories.forEach((c) => {
        if (!c.id) c.id = slug(c.name || 'cat');
        if (seen.has(c.id)) c.id = c.id + '-' + Math.random().toString(36).slice(2, 6);
        seen.add(c.id);
        c.name = c.name || c.id;
        c.links = Array.isArray(c.links) ? c.links : [];
        c.links.forEach((l) => { if (!l.url) l.url = ''; });
      });
      saveData(body);
      return sendJSON(res, 200, { ok: true, categories: body.categories.length, links: body.categories.reduce((a, c) => a + c.links.length, 0) });
    }

    /* 图标上传：前端以 base64 提交图片，服务端写入 uploads/ 并返回访问 URL（需管理员密码） */
    if (pathname === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.data || !body.filename) return sendJSON(res, 400, { error: '缺少文件数据' });
      const ext = (String(body.filename).split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const ALLOW = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
      if (!ALLOW.includes(ext)) return sendJSON(res, 400, { error: '不支持的图片格式（仅 png/jpg/gif/webp/svg）' });
      const safeName = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
      const b64 = String(body.data).replace(/^data:.*?;base64,/, '');
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch (e) { return sendJSON(res, 400, { error: '图片数据解析失败' }); }
      if (buf.length > 2 * 1024 * 1024) return sendJSON(res, 400, { error: '图片超过 2MB' });
      fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
      return sendJSON(res, 200, { ok: true, url: '/uploads/' + safeName });
    }

    /* 在线壁纸库：服务端代理抓取，规避浏览器 CORS（需登录） */
    if (pathname === '/api/wallpapers' && req.method === 'GET') {
      if (!isAuthed(req)) return sendJSON(res, 401, { error: '请先登录后台', needAuth: true });
      const source = String(parsed.query.source || 'bing');
      const page = Math.max(1, parseInt(parsed.query.page, 10) || 1);
      const q = String(parsed.query.q || '');
      try {
        const list = await fetchWallpapers(source, page, q);
        return sendJSON(res, 200, { ok: true, source, page, list });
      } catch (e) {
        return sendJSON(res, 502, { error: '获取壁纸失败：' + e.message });
      }
    }

    /* 链接访问统计：按 url 累加 visits 并写回 sites.json（前台点击时上报，匿名、无需密码） */
    if (pathname === '/api/visit' && req.method === 'POST') {
      const body = await readBody(req);
      const target = (body && body.url || '').trim();
      if (!target) return sendJSON(res, 400, { error: '缺少 url' });
      const data = loadData();
      let found = null;
      for (const c of (data.categories || [])) {
        const l = (c.links || []).find((x) => x.url === target);
        if (l) { l.visits = (l.visits || 0) + 1; found = l; break; }
      }
      if (!found) return sendJSON(res, 404, { error: '未找到该链接' });
      saveData(data);
      return sendJSON(res, 200, { ok: true, visits: found.visits });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      if (!isAuthed(req)) return sendJSON(res, 401, { error: '请先登录后台', needAuth: true });
      return sendJSON(res, 200, {
        aiEnabled: CFG.AI_ENABLED,
        model: CFG.AI_ENABLED ? CFG.AI_MODEL : null,
        base: CFG.AI_API_BASE,
        apiKeySet: CFG.AI_ENABLED,
        protected: !!CFG.ADMIN_PASSWORD,
        required: !!CFG.ADMIN_REQUIRED,
        user: CFG.ADMIN_USER || 'admin'
      });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.AI_API_BASE) CFG.AI_API_BASE = body.AI_API_BASE;
      if (body.AI_MODEL) CFG.AI_MODEL = body.AI_MODEL;
      if (typeof body.AI_API_KEY === 'string') CFG.AI_API_KEY = body.AI_API_KEY;
      if (body.ADMIN_USER !== undefined && String(body.ADMIN_USER).trim().length >= 2) {
        CFG.ADMIN_USER = String(body.ADMIN_USER).trim();
      }
      if (body.ADMIN_REQUIRED !== undefined) CFG.ADMIN_REQUIRED = !!body.ADMIN_REQUIRED;
      // 修改密码需校验原密码，防止借道本接口越权改密
      if (typeof body.ADMIN_PASSWORD === 'string' && body.ADMIN_PASSWORD) {
        if (body.oldPassword !== CFG.ADMIN_PASSWORD) {
          return sendJSON(res, 403, { error: '原密码不正确，无法修改密码' });
        }
        if (body.ADMIN_PASSWORD.length < 6) return sendJSON(res, 400, { error: '新密码至少 6 位' });
        CFG.ADMIN_PASSWORD = body.ADMIN_PASSWORD;
      }
      CFG.AI_ENABLED = !!CFG.AI_API_KEY;
      try { persistConfig(CFG); }
      catch (e) { return sendJSON(res, 500, { error: '写入 config.json 失败：' + e.message }); }
      return sendJSON(res, 200, {
        ok: true, aiEnabled: CFG.AI_ENABLED, model: CFG.AI_MODEL,
        protected: !!CFG.ADMIN_PASSWORD, required: CFG.ADMIN_REQUIRED, user: CFG.ADMIN_USER
      });
    }

    /* ---------- 登录 / 鉴权 ---------- */
    // GET /api/auth -> 登录状态（公开，不含敏感信息）
    if (pathname === '/api/auth' && req.method === 'GET') {
      const s = verifyToken(tokenFromReq(req));
      return sendJSON(res, 200, {
        required: !!CFG.ADMIN_REQUIRED,
        configured: !!CFG.ADMIN_PASSWORD,
        user: CFG.ADMIN_USER || 'admin',
        loggedIn: !!s,
        loginUser: s ? s.u : null
      });
    }

    // POST /api/auth/setup -> 首次初始化管理员账号（仅在尚未设置密码时可用）
    if (pathname === '/api/auth/setup' && req.method === 'POST') {
      const body = await readBody(req);
      const user = String((body && body.user) || '').trim();
      const pwd = String((body && body.password) || '');
      if (CFG.ADMIN_PASSWORD) return sendJSON(res, 409, { error: '管理员账号已初始化，请直接登录' });
      if (user.length < 2) return sendJSON(res, 400, { error: '账号至少 2 个字符' });
      if (pwd.length < 6) return sendJSON(res, 400, { error: '密码至少 6 位' });
      CFG.ADMIN_USER = user; CFG.ADMIN_PASSWORD = pwd; CFG.ADMIN_REQUIRED = true;
      persistConfig(CFG);
      const t = issueToken(user, TOKEN_TTL, true);
      return sendJSON(res, 200, { ok: true, ...t, required: true });
    }

    // POST /api/auth/login -> 账号密码登录，返回会话 token
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const wait = throttleCheck(ip);
      if (wait > 0) {
        return sendJSON(res, 429, { error: '尝试过于频繁，请 ' + Math.ceil(wait / 1000) + ' 秒后重试' });
      }
      const body = await readBody(req);
      const user = String((body && body.user) || '').trim();
      const pwd = String((body && body.password) || '');
      if (!CFG.ADMIN_PASSWORD) return sendJSON(res, 409, { error: '尚未初始化管理员账号', needSetup: true });
      if (user !== CFG.ADMIN_USER || pwd !== CFG.ADMIN_PASSWORD) {
        const left = 8 - throttleFail(ip);
        return sendJSON(res, 401, {
          error: '账号或密码不正确' + (left > 0 && left <= 5 ? `（还可尝试 ${left} 次）` : '')
        });
      }
      throttleReset(ip);
      const t = issueToken(user, body.remember ? TOKEN_TTL : SESSION_TTL_SHORT, !!body.remember);
      return sendJSON(res, 200, { ok: true, ...t });
    }

    // POST /api/auth/logout -> 登出（服务端无状态，前端清除 token 即可）
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      return sendJSON(res, 200, { ok: true });
    }

    // GET /api/auth/verify -> 校验当前 token 是否有效
    if (pathname === '/api/auth/verify' && req.method === 'GET') {
      const s = verifyToken(tokenFromReq(req));
      if (!s) return sendJSON(res, 401, { error: '登录已失效，请重新登录', needAuth: true });
      return sendJSON(res, 200, { ok: true, user: s.u, exp: s.exp });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('────────────────────────────────────────');
  console.log(' 共享导航 已启动');
  console.log(' 浏览：  http://localhost:' + PORT);
  console.log(' 管理：  http://localhost:' + PORT + '/admin.html');
  console.log(' AI 识别：' + (AI_ENABLED ? ('已开启（' + CFG.AI_MODEL + '）') : '未开启（使用启发式识别，配置 config.json 的 AI_API_KEY 可启用免费大模型）'));
  console.log('────────────────────────────────────────');
});
