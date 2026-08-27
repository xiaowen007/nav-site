// POST /api/visit -> 按 url 累加访问次数（前台点击上报，匿名、无需密码）
import { loadData, saveData, sendJSON, readBody } from '../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  const target = (body && body.url || '').trim();
  if (!target) return sendJSON({ error: '缺少 url' }, 400);
  const data = await loadData(env);
  let found = null;
  for (const c of (data.categories || [])) {
    const l = (c.links || []).find((x) => x.url === target);
    if (l) { l.visits = (l.visits || 0) + 1; found = l; break; }
  }
  if (!found) return sendJSON({ error: '未找到该链接' }, 404);
  await saveData(env, data);
  return sendJSON({ ok: true, visits: found.visits });
}
