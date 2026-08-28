// POST /api/auth/setup -> 首次初始化管理员账号（仅在尚未设置密码时可用）
import { loadConfig, saveConfig, sendJSON, readBody, issueToken } from '../../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const cfg = await loadConfig(env);
  if (cfg.ADMIN_PASSWORD) {
    return sendJSON({ error: '管理员账号已初始化，请直接登录' }, 409);
  }

  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  const user = String((body && body.user) || '').trim();
  const pwd = String((body && body.password) || '');
  if (user.length < 2) return sendJSON({ error: '账号至少 2 个字符' }, 400);
  if (pwd.length < 6) return sendJSON({ error: '密码至少 6 位' }, 400);

  cfg.ADMIN_USER = user;
  cfg.ADMIN_PASSWORD = pwd;
  cfg.ADMIN_REQUIRED = true;
  await saveConfig(env, cfg);

  const t = await issueToken(env, user, true);
  return sendJSON({ ok: true, ...t, required: true });
}
