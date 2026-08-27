// GET  /api/config -> 返回当前 AI/鉴权配置（不含密钥明文）
// POST /api/config -> 更新配置并写入 KV（需管理员密码）
import { loadConfig, saveConfig, sendJSON, requireAuth, readBody } from '../_lib.js';

export async function onRequestGet({ env }) {
  const cfg = await loadConfig(env);
  return sendJSON({
    aiEnabled: !!cfg.AI_API_KEY,
    model: cfg.AI_API_KEY ? cfg.AI_MODEL : null,
    base: cfg.AI_API_BASE,
    apiKeySet: !!cfg.AI_API_KEY,
    protected: !!cfg.ADMIN_PASSWORD
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '需要管理员密码', needAuth: true }, 401);
  }
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  const cfg = await loadConfig(env);
  if (body.AI_API_BASE) cfg.AI_API_BASE = body.AI_API_BASE;
  if (body.AI_MODEL) cfg.AI_MODEL = body.AI_MODEL;
  if (typeof body.AI_API_KEY === 'string') cfg.AI_API_KEY = body.AI_API_KEY;
  if (body.ADMIN_PASSWORD !== undefined) cfg.ADMIN_PASSWORD = body.ADMIN_PASSWORD; // 显式空串=关闭保护
  await saveConfig(env, cfg);
  return sendJSON({
    ok: true,
    aiEnabled: !!cfg.AI_API_KEY,
    model: cfg.AI_API_KEY ? cfg.AI_MODEL : null,
    protected: !!cfg.ADMIN_PASSWORD
  });
}
