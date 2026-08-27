/* 科技共享导航 - 零依赖后端
 * 功能：静态文件服务 + AI 自动识别写入（/api/recognize、/api/save）
 * 运行：node server.js   （默认端口 8787，可用 PORT 环境变量覆盖）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

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
  ADMIN_PASSWORD: ''                                 // 后台管理密码（留空=不保护写接口）
};

function loadConfig() {
  let cfg = { ...DEFAULT_CFG };
  const cfgPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; }
    catch (e) { console.warn('[config] 读取 config.json 失败，使用默认值'); }
  }
  // 环境变量优先
  cfg.AI_API_BASE = process.env.AI_API_BASE || cfg.AI_API_BASE;
  cfg.AI_API_KEY = process.env.AI_API_KEY || cfg.AI_API_KEY;
  cfg.AI_MODEL = process.env.AI_MODEL || cfg.AI_MODEL;
  cfg.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || cfg.ADMIN_PASSWORD;
  return cfg;
}
const CFG = loadConfig();
const AI_ENABLED = !!CFG.AI_API_KEY;
CFG.AI_ENABLED = AI_ENABLED;

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
  let category = '常用推荐';
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
    // 写接口鉴权：设置 ADMIN_PASSWORD 后，写操作需带 X-Admin-Password 头
    const PROTECTED = ['/api/sites', '/api/save', '/api/recognize', '/api/config', '/api/upload'];
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && PROTECTED.includes(pathname)) {
      if (CFG.ADMIN_PASSWORD && req.headers['x-admin-password'] !== CFG.ADMIN_PASSWORD) {
        return sendJSON(res, 401, { error: '需要管理员密码', needAuth: true });
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
      return sendJSON(res, 200, {
        aiEnabled: CFG.AI_ENABLED,
        model: CFG.AI_ENABLED ? CFG.AI_MODEL : null,
        base: CFG.AI_API_BASE,
        apiKeySet: CFG.AI_ENABLED,
        protected: !!CFG.ADMIN_PASSWORD
      });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.AI_API_BASE) CFG.AI_API_BASE = body.AI_API_BASE;
      if (body.AI_MODEL) CFG.AI_MODEL = body.AI_MODEL;
      if (typeof body.AI_API_KEY === 'string') CFG.AI_API_KEY = body.AI_API_KEY;
      if (body.ADMIN_PASSWORD !== undefined) CFG.ADMIN_PASSWORD = body.ADMIN_PASSWORD; // 显式空串=关闭保护
      CFG.AI_ENABLED = !!CFG.AI_API_KEY;
      const cfgPath = path.join(ROOT, 'config.json');
      try {
        const persist = {
          AI_API_BASE: CFG.AI_API_BASE,
          AI_API_KEY: CFG.AI_API_KEY,
          AI_MODEL: CFG.AI_MODEL,
          ADMIN_PASSWORD: CFG.ADMIN_PASSWORD
        };
        fs.writeFileSync(cfgPath, JSON.stringify(persist, null, 2) + '\n', 'utf8');
      } catch (e) { return sendJSON(res, 500, { error: '写入 config.json 失败：' + e.message }); }
      return sendJSON(res, 200, { ok: true, aiEnabled: CFG.AI_ENABLED, model: CFG.AI_MODEL, protected: !!CFG.ADMIN_PASSWORD });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('────────────────────────────────────────');
  console.log(' 科技共享导航 已启动');
  console.log(' 浏览：  http://localhost:' + PORT);
  console.log(' 管理：  http://localhost:' + PORT + '/admin.html');
  console.log(' AI 识别：' + (AI_ENABLED ? ('已开启（' + CFG.AI_MODEL + '）') : '未开启（使用启发式识别，配置 config.json 的 AI_API_KEY 可启用免费大模型）'));
  console.log('────────────────────────────────────────');
});
