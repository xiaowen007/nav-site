// GET /uploads/[name] -> 从 R2 读取已上传图片并返回（前台/后台通过 /uploads/xxx 引用）
import { hasR2 } from '../_lib.js';

export async function onRequestGet({ env, params }) {
  const name = String(params.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!name) return new Response('Not Found', { status: 404 });
  if (!hasR2(env)) {
    return new Response('Storage binding NAV_R2 not configured', { status: 503 });
  }
  const obj = await env.NAV_R2.get(name);
  if (!obj) return new Response('Not Found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400'
    }
  });
}
