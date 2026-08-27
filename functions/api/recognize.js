// POST /api/recognize -> 抓取目标网址并识别为导航卡片（AI 或启发式，需管理员密码）
import { loadData, sendJSON, requireAuth, fetchMeta, aiRecognize, heuristicRecognize, loadConfig, readBody } from '../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '需要管理员密码', needAuth: true }, 401);
  }
  let body;
  try { body = await readBody(request); }
  catch (e) { return sendJSON({ error: e.message }, 400); }

  const target = (body.url || '').trim();
  if (!target || !/^https?:\/\//i.test(target)) {
    return sendJSON({ error: '请提供合法的 http(s) 网址' }, 400);
  }
  let meta;
  try { meta = await fetchMeta(target); }
  catch (e) { return sendJSON({ error: '抓取网页失败：' + e.message }, 502); }

  const cfg = await loadConfig(env);
  const data = await loadData(env);
  let card, source;
  if (cfg.AI_API_KEY) {
    try { card = await aiRecognize(cfg, meta, data.categories); source = 'ai'; }
    catch (e) {
      card = heuristicRecognize(meta, data.categories);
      source = 'heuristic-fallback';
    }
  } else {
    card = heuristicRecognize(meta, data.categories);
    source = 'heuristic';
  }
  card.url = target;
  return sendJSON({ source, ...card });
}
