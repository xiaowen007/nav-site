// GET  /api/applications -> 管理员看全部申请；普通用户只看自己的
// POST /api/applications -> 普通用户提交「添加网站」申请（需登录）
import {
  sendJSON, readBody, hasKV, bindingErrorResponse, loadData, fetchMeta
} from '../../_lib.js';
import {
  requireLogin, requireAdmin, resolveIdentity, loadApps, saveApps, publicApp,
  normalizeUrl, ROLE_ADMIN, ST_PENDING, ST_ACTIVE, ST_REJECTED, ST_DISABLED
} from '../../_accounts.js';

const MAX_PENDING_PER_USER = 5; // 每人最多同时挂 5 条待审申请

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));
    const id = await resolveIdentity(request, env);
    if (!id) return sendJSON({ error: '请先登录', needLogin: true }, 401);

    const list = await loadApps(env);
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const isAdmin = id.role === ROLE_ADMIN;
    // 普通用户只能看到自己的申请，避免互相看到提交内容
    const visible = isAdmin ? list : list.filter((a) => a.username === id.user);

    return sendJSON({
      ok: true,
      applications: visible.map(publicApp),
      total: visible.length,
      pending: visible.filter((a) => a.status === ST_PENDING).length,
      isAdmin
    });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '读取申请失败' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));
    const id = await resolveIdentity(request, env);
    if (!id) return sendJSON({ error: '请先登录后再提交申请', needLogin: true }, 401);
    if (id.status === ST_DISABLED) return sendJSON({ error: '账号已被禁用' }, 403);

    let body;
    try { body = await readBody(request); }
    catch (e) { return sendJSON({ error: e.message }, 400); }

    const url = normalizeUrl(body && body.url);
    if (!url) return sendJSON({ error: '请填写合法的网址（如 https://example.com）' }, 400);

    const list = await loadApps(env);
    const mine = list.filter((a) => a.username === id.user && a.status === ST_PENDING);
    if (mine.length >= MAX_PENDING_PER_USER) {
      return sendJSON({ error: '你还有 ' + mine.length + ' 条申请在等待审核，请等管理员处理后再提交' }, 429);
    }
    if (mine.some((a) => a.url === url)) {
      return sendJSON({ error: '这个网址你已经提交过了，正在等待审核' }, 409);
    }

    // 未填名称时自动抓取网页标题与简介，减轻审核负担；抓取失败不阻断提交
    let name = String((body && body.name) || '').trim().slice(0, 40);
    let desc = String((body && body.desc) || '').trim().slice(0, 80);
    let icon = String((body && body.icon) || '').trim().slice(0, 300);
    if (!name || !desc) {
      try {
        const meta = await fetchMeta(url);
        if (!name) name = (meta.title || '').slice(0, 40);
        if (!desc) desc = (meta.desc || '').slice(0, 80);
        if (!icon) icon = meta.icon || '';
      } catch (e) { /* 抓不到就让管理员审核时自己补 */ }
    }
    if (!name) {
      try { name = new URL(url).hostname; } catch { name = url.slice(0, 40); }
    }

    // 建议分类：必须落在现有分类里，避免用户凭空造分类
    const data = await loadData(env);
    const catNames = (data.categories || []).map((c) => c.name);
    let category = String((body && body.category) || '').trim();
    if (category && !catNames.includes(category)) category = '';

    const app = {
      id: 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      kind: 'link',
      username: id.user,
      nickname: (id.account && id.account.nickname) || id.user,
      name, url, desc, icon, category,
      status: ST_PENDING,
      createdAt: Date.now(),
      reviewedAt: 0, reviewer: '', note: ''
    };
    list.push(app);
    await saveApps(env, list);

    return sendJSON({ ok: true, pending: true, application: publicApp(app), message: '已提交，等待管理员审核' });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '提交失败' }, 500);
  }
}
