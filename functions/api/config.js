// GET  /api/config -> 返回当前 AI/鉴权配置（不含密钥明文，需登录）
// POST /api/config -> 更新配置并写入 KV（需登录）
import { loadConfig, saveConfig, sendJSON, requireAuth, readBody, bindingErrorResponse } from '../_lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  // 配置含 AI 接口地址等敏感信息，仅登录后可读取
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '请先登录后台', needAuth: true }, 401);
  }
  const cfg = await loadConfig(env);
  return sendJSON({
    aiEnabled: !!cfg.AI_API_KEY,
    model: cfg.AI_API_KEY ? cfg.AI_MODEL : null,
    base: cfg.AI_API_BASE,
    apiKeySet: !!cfg.AI_API_KEY,
    protected: !!cfg.ADMIN_PASSWORD,
    required: !!cfg.ADMIN_REQUIRED,
    user: cfg.ADMIN_USER || 'admin'
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '请先登录后台', needAuth: true }, 401);
  }
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  const cfg = await loadConfig(env);
  if (body.AI_API_BASE) cfg.AI_API_BASE = body.AI_API_BASE;
  if (body.AI_MODEL) cfg.AI_MODEL = body.AI_MODEL;
  if (typeof body.AI_API_KEY === 'string') cfg.AI_API_KEY = body.AI_API_KEY;
  if (body.ADMIN_USER !== undefined && String(body.ADMIN_USER).trim().length >= 2) {
    cfg.ADMIN_USER = String(body.ADMIN_USER).trim();
  }
  if (body.ADMIN_REQUIRED !== undefined) cfg.ADMIN_REQUIRED = !!body.ADMIN_REQUIRED;
  // 修改密码必须校验原密码，防止借道本接口越权改密
  if (typeof body.ADMIN_PASSWORD === 'string' && body.ADMIN_PASSWORD) {
    if (body.oldPassword !== cfg.ADMIN_PASSWORD) {
      return sendJSON({ error: '原密码不正确，无法修改密码' }, 403);
    }
    if (body.ADMIN_PASSWORD.length < 6) return sendJSON({ error: '新密码至少 6 位' }, 400);
    cfg.ADMIN_PASSWORD = body.ADMIN_PASSWORD;
  }
  try {
    await saveConfig(env, cfg);
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    throw e;
  }
  return sendJSON({
    ok: true,
    aiEnabled: !!cfg.AI_API_KEY,
    model: cfg.AI_API_KEY ? cfg.AI_MODEL : null,
    protected: !!cfg.ADMIN_PASSWORD,
    required: !!cfg.ADMIN_REQUIRED,
    user: cfg.ADMIN_USER
  });
}
