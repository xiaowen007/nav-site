// GET  /api/sites  -> 读取导航数据（KV，空则播种种子）
// POST /api/sites  -> 全量覆盖（管理控制台整体保存，需管理员密码）
import { loadData, saveData, sendJSON, requireAuth, slug, readBody } from '../_lib.js';

export async function onRequestGet({ env }) {
  const data = await loadData(env);
  return sendJSON(data);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '请先登录后台', needAuth: true }, 401);
  }
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  if (!body || !Array.isArray(body.categories)) {
    return sendJSON({ error: '数据格式错误：缺少 categories 数组' }, 400);
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
  await saveData(env, body);
  return sendJSON({
    ok: true,
    categories: body.categories.length,
    links: body.categories.reduce((a, c) => a + c.links.length, 0)
  });
}
