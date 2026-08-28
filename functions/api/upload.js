// POST /api/upload -> 接收 base64 图片，写入 R2，返回 /uploads/xxx 访问地址（需管理员密码）
import { sendJSON, requireAuth, readBody, b64ToArrayBuffer, UPLOAD_MIME } from '../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '请先登录后台', needAuth: true }, 401);
  }
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  if (!body || !body.data || !body.filename) return sendJSON({ error: '缺少文件数据' }, 400);
  const ext = (String(body.filename).split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ALLOW = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  if (!ALLOW.includes(ext)) return sendJSON({ error: '不支持的图片格式（仅 png/jpg/gif/webp/svg）' }, 400);

  let buf;
  try { buf = b64ToArrayBuffer(body.data); }
  catch (e) { return sendJSON({ error: '图片数据解析失败' }, 400); }
  if (buf.byteLength > 2 * 1024 * 1024) return sendJSON({ error: '图片超过 2MB' }, 400);

  const safeName = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  await env.NAV_R2.put(safeName, buf, { httpMetadata: { contentType: UPLOAD_MIME[ext] || 'application/octet-stream' } });
  return sendJSON({ ok: true, url: '/uploads/' + safeName });
}
