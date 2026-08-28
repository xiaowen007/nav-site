// POST /api/save -> 单条链接 upsert（管理后台“保存此卡片”，需管理员密码）
import { loadData, saveData, sendJSON, requireAuth, upsertCard, readBody } from '../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '请先登录后台', needAuth: true }, 401);
  }
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  if (!body || !body.url) return sendJSON({ error: '缺少 url' }, 400);
  const data = await loadData(env);
  const result = upsertCard(data, body);
  await saveData(env, data);
  return sendJSON({ ok: true, ...result });
}
