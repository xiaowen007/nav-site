// POST /api/auth/register -> 访问者自助注册（注册后为「待审核」，需管理员批准才能登录）
import { sendJSON, readBody, loadConfig, hasKV, bindingErrorResponse } from '../../_lib.js';
import {
  loadAccounts, saveAccounts, hashPassword, validateUsername, validatePassword,
  ST_PENDING, ROLE_USER
} from '../../_accounts.js';

const MAX_ACCOUNTS = 500; // 防止被脚本刷出天量待审账户

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));
    const cfg = await loadConfig(env);
    if (!cfg.ADMIN_REQUIRED) {
      return sendJSON({ error: '本站未开启登录保护，无需注册' }, 409);
    }

    let body;
    try { body = await readBody(request); }
    catch (e) { return sendJSON({ error: e.message }, 400); }

    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    const nickname = String((body && body.nickname) || '').trim().slice(0, 20);
    const reason = String((body && body.reason) || '').trim().slice(0, 100); // 申请理由，供管理员参考

    const uErr = validateUsername(username);
    if (uErr) return sendJSON({ error: uErr }, 400);
    const pErr = validatePassword(password);
    if (pErr) return sendJSON({ error: pErr }, 400);
    // 不允许占用超级管理员的名字，否则会造成身份歧义
    if (cfg.ADMIN_USER && username.toLowerCase() === String(cfg.ADMIN_USER).toLowerCase()) {
      return sendJSON({ error: '该账号名不可用，请换一个' }, 400);
    }

    const list = await loadAccounts(env);
    if (list.length >= MAX_ACCOUNTS) {
      return sendJSON({ error: '注册人数已达上限，请联系管理员' }, 429);
    }
    if (list.some((a) => String(a.username).toLowerCase() === username.toLowerCase())) {
      return sendJSON({ error: '该账号已被注册' }, 409);
    }

    const { salt, iter, passHash } = await hashPassword(password);
    const acc = {
      id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      username,
      nickname: nickname || username,
      salt, iter, passHash,
      role: ROLE_USER,          // 注册一律是普通用户，提权只能由管理员操作
      status: ST_PENDING,       // 待管理员审核后方可登录
      reason,
      createdAt: Date.now(),
      reviewedAt: 0, reviewedBy: '', note: ''
    };
    list.push(acc);
    await saveAccounts(env, list);

    return sendJSON({
      ok: true,
      pending: true,
      message: '注册成功，请等待管理员审核通过后即可登录'
    });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '注册失败' }, 500);
  }
}
