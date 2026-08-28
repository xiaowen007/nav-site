// POST /api/auth/logout -> 登出（服务端无状态，前端清除本地 token 即可）
import { sendJSON } from '../../../_lib.js';

export async function onRequestPost() {
  return sendJSON({ ok: true });
}
