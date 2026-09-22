/* 共享导航 - 前端逻辑
 * 数据来源：在线优先读后端 /api/sites（与后台管理同源，保证实时同步；
 *          Cloudflare 走 KV、本地 server.js 走 data/sites.json）；
 *          file:// 直接打开或后端不可用时，回落 data/sites.json → data/sites.js 兜底。
 */
(() => {
  'use strict';

  const state = {
    data: null,
    active: 'all',
    view: 'sections',
    keyword: '',
    catCollapsed: {}   // 侧栏树形：已折叠的分类 id
  };

  const $ = (sel) => document.querySelector(sel);

  // 颜色池：用于无图标时的字母头像
  const COLORS = ['#2f6fed','#e8543f','#1aa179','#f0a020','#8b5cf6','#0ea5e9','#ef5da8','#14b8a6'];
  const colorFor = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

  /* ===== 常用收藏（localStorage，按浏览器保存） ===== */
  const FAV_KEY = 'nav_favorites';
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch { return []; }
  }
  function saveFavorites(arr) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function isFav(url) { return getFavorites().some((f) => f.url === url); }
  function toggleFav(link) {
    const favs = getFavorites();
    const i = favs.findIndex((f) => f.url === link.url);
    if (i >= 0) favs.splice(i, 1);
    else favs.unshift(link); // 新收藏置顶
    saveFavorites(favs);
  }
  function updateFavCount() {
    const n = getFavorites().length;
    const el = document.getElementById('favCount');
    // 注意：.fav-count 的样式表默认是 display:none，清成 '' 会回落到 display:none（角标永远不显示），
    // 必须显式写成 inline-block，否则「收藏数量」永远看不见。
    if (el) { el.textContent = n; el.style.display = n ? 'inline-block' : 'none'; }
  }
  function reorderFavorites(fromUrl, toUrl) {
    const favs = getFavorites();
    const fromIdx = favs.findIndex((f) => f.url === fromUrl);
    if (fromIdx < 0) return;
    const [item] = favs.splice(fromIdx, 1);
    const toIdx = favs.findIndex((f) => f.url === toUrl);
    if (toIdx < 0) favs.push(item);
    else favs.splice(toIdx, 0, item);
    saveFavorites(favs);
    renderFavorites();
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }

  function faviconUrl(link, site) {
    if (link.icon) return link.icon;
    const h = hostnameOf(link.url);
    if (!h) return '';
    const base = (site && site.faviconService) || 'https://icons.duckduckgo.com/ip3/';
    return base + h + '.ico';
  }

  /* ===== 数据加载：三级兜底 =====
   * 1) fetch data/sites.json —— http(s) 访问时的正常路径
   * 2) <script src="data/sites.js"> —— 以 file:// 直接打开时 fetch 会被浏览器拦截
   *    （报 Failed to fetch），改用脚本标签读取由 sites.json 同步生成的同名 .js，
   *    脚本标签不受 file:// 限制
   * 3) 本机快照 —— 前两者都不可用时的最后兜底（需后台开启缓存）
   */
  const DATA_CACHE_KEY = 'nav_data_cache';
  const DATA_CACHE_TTL = 12 * 60 * 60 * 1000; // 快照有效期 12 小时，仅作兜底

  function readDataCache() {
    try {
      const raw = localStorage.getItem(DATA_CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.data || !o.ts) return null;
      if (Date.now() - o.ts > DATA_CACHE_TTL) return null;
      return o.data;
    } catch (e) { return null; }
  }
  function writeDataCache(data) {
    try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
  }
  function clearDataCache() {
    try { localStorage.removeItem(DATA_CACHE_KEY); } catch (e) {}
  }

  /* ===== 后台「首页预览」数据通道 =====
   * 后台（admin.html）的右侧设置面板会把「内存中尚未保存」的整份数据通过
   * localStorage + postMessage 送到这里，让后台左侧的实时预览能立刻反映改动。
   * 只在 URL 带 preview=1 时生效 —— 正常访问首页完全不受影响。
   */
  const PREVIEW_MODE = /[?&]preview=1/.test(location.search);
  const PREVIEW_DATA_KEY = 'nav_preview_data';

  function readPreviewData() {
    try {
      const raw = localStorage.getItem(PREVIEW_DATA_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return (d && Array.isArray(d.categories)) ? d : null;
    } catch (e) { return null; }
  }

  // 用后台推来的数据在这里就地重渲染整页（顶栏 / 侧栏 / 分类 / 卡片 / 壁纸 / 字体）
  function applyPreviewData(data) {
    if (!data || !Array.isArray(data.categories)) return;
    state.data = data;
    dropHiddenCategories(state.data);
    // layout-top / search-above 是「只加不减」的全局 class，顶部导航也是插入式节点：
    // 必须先把上一次的布局痕迹清干净，否则从「顶部」切回「左侧」时布局回不去。
    document.documentElement.classList.remove('layout-top', 'search-above');
    const topNav = document.getElementById('topNav');
    if (topNav) topNav.remove();
    buildSidebar();
    renderHead();
    renderWebSearch();
    renderSections();
    applySettings();
    updateFavCount();
  }

  if (PREVIEW_MODE) {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin) return;   // 只认同源后台推来的数据
      const d = e.data;
      if (!d || d.type !== 'nav-preview-data') return;
      try { applyPreviewData(d.data); } catch (err) {}
    });
  }

  // 经 <script> 标签读取数据（file:// 兜底）
  function loadDataViaScript() {
    return new Promise((resolve, reject) => {
      if (window.__NAV_DATA__) return resolve(window.__NAV_DATA__);
      const s = document.createElement('script');
      // 注意：file:// 下带查询串会被当成文件名的一部分导致 404，故不加缓存戳
      s.src = 'data/sites.js';
      s.onload = () => {
        if (window.__NAV_DATA__) resolve(window.__NAV_DATA__);
        else reject(new Error('data/sites.js 未返回数据'));
      };
      s.onerror = () => reject(new Error('data/sites.js 读取失败'));
      document.head.appendChild(s);
    });
  }

  async function fetchSiteData() {
    const isOnline = location.protocol === 'http:' || location.protocol === 'https:';
    // 在线环境优先读后端 /api/sites（Cloudflare 走 KV、本地 server.js 走 data/sites.json），
    // 与后台管理写入的是同一份数据，保证前台展示与后台修改实时同步。
    if (isOnline) {
      try {
        const res = await fetch('/api/sites?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch (e) {
        // /api/sites 不可用（如未部署 Functions）→ 落到下方静态兜底
      }
    }
    // file:// 直接打开，或 /api/sites 不可用时，读静态文件兜底
    try {
      const res = await fetch('data/sites.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      // fetch 被拦截（file://）→ 退回脚本标签读取
    }
    return await loadDataViaScript();
  }

  /* 需要彻底移除的分类（按名称匹配，含子级）。
   * 背景：数据层（data/sites.json、functions/_seed.js）已删除「常用推荐」，
   * 但线上数据存在 Cloudflare KV 中，若 KV 里仍留有旧副本，仅改文件部署后不会生效。
   * 这里在渲染前统一屏蔽，保证线上一定能去掉；日后若想恢复，清空此数组即可。
   */
  const HIDDEN_CATEGORY_NAMES = ['常用推荐'];
  function dropHiddenCategories(data) {
    if (!data || !Array.isArray(data.categories)) return;
    const hide = (c) => HIDDEN_CATEGORY_NAMES.indexOf(c && c.name) >= 0;
    const walk = (list) => list.filter((c) => {
      if (!c || hide(c)) return false;
      if (Array.isArray(c.children)) c.children = walk(c.children);
      return true;
    });
    data.categories = walk(data.categories);
  }

  async function loadData() {
    // 后台「首页预览」：优先用后台推来的「尚未保存」的数据，改完即见。
    // 没有预览数据（第一次打开后台）时照常走下面的在线加载。
    if (PREVIEW_MODE) {
      const pv = readPreviewData();
      if (pv) { state.data = pv; dropHiddenCategories(state.data); return; }
    }
    let fresh;
    try {
      fresh = await fetchSiteData();
    } catch (e) {
      const snap = readDataCache();
      if (!snap) throw new Error(e.message || '无法加载导航数据');
      state.data = snap; // 离线兜底：用上次快照渲染
      dropHiddenCategories(state.data);
      return;
    }
    state.data = fresh;
    dropHiddenCategories(state.data);
    // 缓存开关：开启才保留快照；关闭则清掉，保证每次都拿最新数据
    if (fresh.site && fresh.site.cacheEnabled === true) writeDataCache(fresh);
    else clearDataCache();
  }

  function renderHead() {
    const s = state.data.site || {};
    if (s.logo) $('#siteLogo').textContent = s.logo;
    if (s.title) {
      $('#siteTitle').textContent = s.title;
      document.title = s.title;
    }
    // 站点描述显示在顶栏品牌块的第二行
    if (s.subtitle) $('#siteDesc').textContent = s.subtitle;
    // 主页中心模块（正文顶部的 .hero）：与顶栏那份是**两套独立内容**。
    // 中心名称 / 中心描述留空时回落到站点名称 / 站点描述 —— 默认两块一致，
    // 只填一边就只改一边（这是"可分开设置文字"的交互约定）。
    const heroT = s.heroTitle || s.title;
    const heroS = s.heroSub || s.subtitle;
    if (heroT) $('#heroTitle').textContent = heroT;
    if (heroS) $('#heroSub').textContent = heroS;
    if (s.footer) $('#footer').textContent = s.footer;
    $('#sideFoot').textContent = (s.subtitle || '') + '\n数据：data/sites.json';
  }

  /* 顶栏高度是动态的：站点名称 / 描述的字号可在后台调大，顶栏会跟着变高，
     而侧栏 sticky top、锚点 scroll-margin 都按 --top-h 算 —— 不回写就会出现
     「侧栏顶部被变高的顶栏压住」。这里量一次实测高度写回变量即可。
     jsdom 下 getBoundingClientRect 恒为 0，用 > 0 兜住，避免把 --top-h 写成 0。 */
  function syncTopHeight() {
    const tb = document.querySelector('.topbar');
    if (!tb) return;
    const root = document.documentElement;
    // 必须先摘掉行内值再量：.topbar 有 min-height: var(--top-h)，
    // 留着上次写的值就形成"棘轮" —— 窗口从窄变宽时顶栏永远回不到矮的那一档。
    root.style.removeProperty('--top-h');
    const h = Math.round(tb.getBoundingClientRect().height);
    if (h > 0) root.style.setProperty('--top-h', h + 'px');
  }
  function scheduleSyncTopHeight() {
    const run = () => { try { syncTopHeight(); } catch (e) {} };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /* ---------- 分类层级（支持 1~3 级） ---------- */
  function kids(c) { return Array.isArray(c && c.children) ? c.children : []; }
  function walkCats(list, fn, depth) {
    (list || []).forEach((c) => {
      fn(c, depth || 1);
      if (kids(c).length) walkCats(kids(c), fn, (depth || 1) + 1);
    });
  }

  /* 分类排序：同级别按 order 升序（缺省按 name，中文 localeCompare）。
     返回浅拷贝新树（递归排序 children），不修改原 state.data。
     给某个分类加 "order": 数字（越小越前）即可手动置顶，缺省按 name 排。 */
  function sortCats(list) {
    const cmp = (a, b) => {
      const oa = a.order, ob = b.order;
      const ha = oa != null && oa !== '', hb = ob != null && ob !== '';
      if (ha && hb) return (oa - ob) || String(a.name||'').localeCompare(String(b.name||''), 'zh-Hans-CN', { numeric: true });
      if (ha) return -1;
      if (hb) return 1;
      return String(a.name||'').localeCompare(String(b.name||''), 'zh-Hans-CN', { numeric: true });
    };
    return [...list].sort(cmp).map(c => {
      const nc = Object.assign({}, c);
      if (c.children && c.children.length) nc.children = sortCats(c.children);
      return nc;
    });
  }

  function buildSidebar() {
    const nav = $('#sideNav');
    // 保留“全部”按钮，注入分类
    nav.querySelectorAll('.side-item.cat').forEach((n) => n.remove());
    // 递归构建可折叠树形：父级带展开/收起箭头，子级按层级缩进
    (function buildLevel(list, depth) {
      list.forEach((c) => {
        const children = kids(c);
        const a = document.createElement('a');
        a.className = 'side-item cat lv' + depth + (children.length ? ' has-child' : '');
        a.dataset.target = c.id;
        a.href = '#' + c.id;
        if (children.length) {
          const collapsed = !!state.catCollapsed[c.id];
          a.classList.toggle('collapsed', collapsed);
          const arrow = document.createElement('span');
          arrow.className = 'nav-arrow';
          arrow.textContent = '▾';
          arrow.title = '展开 / 收起子分类';
          arrow.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            state.catCollapsed[c.id] = !state.catCollapsed[c.id];
            buildSidebar();
          });
          a.appendChild(arrow);
        }
        const ico = document.createElement('span');
        ico.innerHTML = catIconHtml(c.icon, 16);
        a.appendChild(ico);
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = c.name; // textContent 自动转义，避免注入
        a.appendChild(lbl);
        nav.appendChild(a);
        if (children.length && !state.catCollapsed[c.id]) buildLevel(children, depth + 1);
      });
    })(sortCats(state.data.categories), 1);
    nav.querySelectorAll('.side-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        const t = item.dataset.target;
        if (t === 'all') {
          e.preventDefault();
          if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
          setActive('all');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        if (t === '__fav') {
          e.preventDefault();
          // 再点一次「常用收藏」= 返回全部分类（收藏视图不是死胡同）
          if (state.view === 'fav') {
            showAllSections();
            closeSidebar();
            return;
          }
          if (state.keyword) clearSearch();
          state.view = 'fav';
          setActive('__fav');
          renderFavorites();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          closeSidebar();
          return;
        }
        // 分类点击：若正在搜索则先清除搜索，再跳转
        if (state.keyword) { clearSearch(); }
        if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
        setActive(t);
        const sec = document.getElementById('sec-' + t);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        closeSidebar();
      });
    });
    // 展开/收起会重建整棵树，需恢复当前高亮
    setActive(state.active || 'all');
  }

  /* 顶部导航模式（替代侧栏） */
  function buildTopNav() {
    const layout = document.querySelector('.layout');
    if (!layout || document.getElementById('topNav')) return;
    const s = state.data.site || {};
    const nav = document.createElement('nav');
    nav.className = 'top-nav' + (s.categoryArrangement === 'multi' ? ' multi' : '');
    nav.id = 'topNav';
    const allCls = 'top-nav-item';
    // 递归列出所有层级：1 级为主项，2/3 级缩进并略缩字号
    const navItems = [];
    walkCats(sortCats(state.data.categories), (c, depth) => {
      navItems.push('<a class="' + allCls + ' lv' + depth + '" data-target="' + escapeHtml(c.id) + '" href="#' + escapeHtml(c.id) + '">' +
        catIconHtml(c.icon, depth === 1 ? 16 : 14) + ' ' + escapeHtml(c.name) + '</a>');
    });
    nav.innerHTML = '<a class="' + allCls + '" data-target="all" href="#all">🏠 全部</a>' + navItems.join('');
    layout.insertBefore(nav, layout.querySelector('.content'));
    nav.querySelectorAll('.' + allCls).forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const t = a.dataset.target;
        if (t === 'all') {
          if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
          setActive('all');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        if (state.keyword) clearSearch();
        if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
        setActive(t);
        const sec = document.getElementById('sec-' + t);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function isImgIcon(icon) {
    if (!icon) return false;
    const v = String(icon).trim();
    if (/^(https?:\/\/|\/uploads\/|\/api\/uploads\/|data:image\/|\.?\/?uploads\/)/i.test(v)) return true;
    // 兜底：形如 cat-abc.png 的文件名（无空白、无查询串），避免 emoji/文字被误判
    return /^[^\s?]+\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(v);
  }
  // 分类/区块图标统一渲染：图片地址输出 <img>，emoji 或文字按文本输出
  function catIconHtml(icon, px) {
    const size = px || 16;
    if (isImgIcon(icon)) {
      return '<img class="cat-icon-img" src="' + escapeHtml(icon) + '" alt="" ' +
        'style="width:' + size + 'px;height:' + size + 'px;object-fit:contain;border-radius:4px;vertical-align:middle" ' +
        // 图片取不到（如线上未绑定 R2、文件已被清理）时回退为默认图标，避免留白
        "onerror=\"this.outerHTML='&#128279;'\" />";
    }
    return escapeHtml(icon || '🔗');
  }

  /* ===== 搜索引擎快速入口 ===== */
  // 默认引擎：可用 data/sites.json 的 site.searchEngines 覆盖（[{id,name,url}]，url 需以查询参数结尾）
  const DEFAULT_ENGINES = [
    { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' },
    { id: 'bing', name: '必应', url: 'https://www.bing.com/search?q=' },
    { id: 'google', name: '谷歌', url: 'https://www.google.com/search?q=' },
    { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query=' },
    { id: 'so360', name: '360', url: 'https://www.so.com/s?q=' },
    { id: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=' },
    { id: 'bilibili', name: 'B站', url: 'https://search.bilibili.com/all?keyword=' },
    { id: 'taobao', name: '淘宝', url: 'https://s.taobao.com/search?q=' },
    { id: 'jd', name: '京东', url: 'https://search.jd.com/Search?keyword=' }
  ];
  const WS_KEY = 'nav_search_engine';

  function getEngines() {
    const s = state.data && state.data.site;
    if (s && Array.isArray(s.searchEngines)) {
      // enabled 缺省视为启用（兼容旧数据）；全部停用则回退内置默认引擎，避免搜索栏空白
      const custom = s.searchEngines.filter((e) => e && e.name && e.url && e.enabled !== false);
      if (custom.length) return custom;
    }
    return DEFAULT_ENGINES;
  }
  function currentEngine() {
    const list = getEngines();
    let id = null;
    try { id = localStorage.getItem(WS_KEY); } catch (e) {}
    return list.find((e) => e.id === id) || list[0];
  }
  function syncEngineBadge() {
    const e = currentEngine();
    const badge = $('#wsBadge');
    if (!e || !badge) return;
    badge.textContent = Array.from(e.name)[0] || '搜';
    badge.style.background = colorFor(e.name);
    const input = $('#wsInput');
    if (input) input.placeholder = '用' + e.name + '搜索…';
  }
  function renderWebSearch() {
    const wrap = $('#wsEngines');
    if (!wrap) return;
    const list = getEngines();
    const cur = currentEngine();
    wrap.innerHTML = '';
    list.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-engine' + (cur && e.id === cur.id ? ' on' : '');
      b.textContent = e.name;
      b.title = '使用「' + e.name + '」搜索';
      b.addEventListener('click', () => {
        try { localStorage.setItem(WS_KEY, e.id); } catch (err) {}
        wrap.querySelectorAll('.ws-engine').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        wrap.classList.remove('open'); // 手机端选完即收起下拉
        syncEngineBadge();
        const input = $('#wsInput');
        if (input) input.focus();
      });
      wrap.appendChild(b);
    });
    syncEngineBadge();
  }

  // 看起来像网址时直接跳转，否则交给搜索引擎
  const URL_LIKE = /^(https?:\/\/)?([\w-]+\.)+(com|cn|net|org|io|dev|co|me|info|edu|gov|xyz|top|site|online|cc|tv|app|ai|tech|store|blog|wiki)([/?#].*)?$/i;
  function doWebSearch() {
    const input = $('#wsInput');
    if (!input) return;
    const q = (input.value || '').trim();
    if (!q) { input.focus(); return; }
    let target;
    if (/^https?:\/\//i.test(q)) target = q;
    else if (URL_LIKE.test(q)) target = 'https://' + q.replace(/^https?:\/\//i, '');
    else target = currentEngine().url + encodeURIComponent(q);
    window.open(target, '_blank', 'noopener');
  }

  /* ===== 字体（后台「首页设置 → 字体」可调） ===== */
  const FONT_FAMILIES = {
    default: '',
    sans: '"PingFang SC","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif',
    serif: '"Songti SC","SimSun","Source Han Serif SC","Noto Serif CJK SC",Georgia,serif',
    rounded: '"PingFang SC","Hiragino Maru Gothic ProN","Yuanti SC","YouYuan","Microsoft YaHei",sans-serif',
    kai: '"Kaiti SC","KaiTi","STKaiti",serif',
    mono: '"SF Mono",SFMono-Regular,Menlo,Consolas,"Courier New",monospace'
  };
  function applyTypography() {
    const s = state.data.site || {};
    const root = document.documentElement;
    if (s.fontSize) root.style.setProperty('--font-size', s.fontSize + 'px');
    // 顶栏「站点名称 / 站点描述」的独立字号（后台两个滑块）。未设置时回退 :root 默认值。
    if (s.titleSize) root.style.setProperty('--title-size', s.titleSize + 'px');
    else root.style.removeProperty('--title-size');
    if (s.subtitleSize) root.style.setProperty('--subtitle-size', s.subtitleSize + 'px');
    else root.style.removeProperty('--subtitle-size');
    // 主页中心模块「中心名称 / 中心描述」的独立字号（另两个滑块）。
    // 与顶栏那对完全独立：这里写 --hero-* 变量，改不到顶栏。
    if (s.heroTitleSize) root.style.setProperty('--hero-title-size', s.heroTitleSize + 'px');
    else root.style.removeProperty('--hero-title-size');
    if (s.heroSubSize) root.style.setProperty('--hero-sub-size', s.heroSubSize + 'px');
    else root.style.removeProperty('--hero-sub-size');

    let stack = '';
    if (s.fontFamily && s.fontFamily !== 'default') {
      if (FONT_FAMILIES[s.fontFamily] !== undefined) {
        stack = FONT_FAMILIES[s.fontFamily];
      } else {
        // 自定义字体：按 id 或名称匹配 site.fonts
        const custom = (s.fonts || []).find((f) => f && (f.id === s.fontFamily || f.name === s.fontFamily));
        stack = custom && custom.stack ? custom.stack : '';
      }
    }
    // 未设置 / 系统默认 / 字体已被删除 → 清掉行内变量，回退 :root 里的设计字体栈
    if (stack) root.style.setProperty('--font-family', stack);
    else root.style.removeProperty('--font-family');
  }


  /* 壁纸 */
  // 兼容早期只填了壁纸值、没选类型的数据：按内容推断类型
  function guessWallpaperType(v) {
    if (!v) return 'none';
    if (/gradient\(/i.test(v)) return 'gradient';
    if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v)) return 'color';
    return 'image';
  }
  function applyWallpaper() {
    const s = state.data.site || {};
    const val = (s.wallpaperValue || '').trim();
    let type = s.wallpaperType || '';
    if (!type && val) type = guessWallpaperType(val);
    if (type === 'none' || !val) {
      // 关闭/清空壁纸时主动清理，否则会残留上一次的壁纸
      document.body.classList.remove('wallpaper');
      ['--wp-bg', '--wp-opacity', '--wp-blur'].forEach((k) => document.body.style.removeProperty(k));
      return;
    }
    document.body.classList.add('wallpaper');
    const bg = type === 'image' ? 'url("' + val.replace(/"/g, '\\"') + '")' : val;
    document.body.style.setProperty('--wp-bg', bg);
    document.body.style.setProperty('--wp-opacity', s.wallpaperOpacity != null ? s.wallpaperOpacity : 0.08);
    document.body.style.setProperty('--wp-blur', (s.wallpaperBlur || 0) + 'px');
  }

  /* 集中应用所有设置（在数据加载完成后调用） */
  function applySettings() {
    const s = state.data.site || {};
    // 隐藏常用收藏
    // 注意：这里写的是行内样式。若只处理 === false 分支，在后台把开关重新打开后
    // 行内 display:none 会一直残留在节点上，导致「常用收藏」再也点不出来。两个分支都要处理。
    const hideFav = s.showFavorites === false;
    document.querySelectorAll('.fav-entry').forEach((e) => { e.style.display = hideFav ? 'none' : ''; });
    if (hideFav) {
      // 若当前在收藏视图，自动退回全部
      if (state.active === '__fav') state.active = 'all';
      if (state.view === 'fav') showAllSections();
    }
    // 分类位置：顶部
    if (s.categoryPosition === 'top') {
      document.documentElement.classList.add('layout-top');
      buildTopNav();
    }
    // 搜索框位置：上方
    if (s.searchPosition === 'above') {
      document.documentElement.classList.add('search-above');
    }
    // 字体
    applyTypography();
    // 字号变了顶栏高度也会变，量一次回写 --top-h（侧栏 sticky / 锚点偏移都依赖它）
    scheduleSyncTopHeight();
    // 壁纸
    applyWallpaper();
    // 默认 / 记住分类
    const remembered = (s.rememberCategory && sessionStorage.getItem('nav_active')) || s.defaultCategory || 'all';
    state.active = remembered;
    setActive(remembered);
    if (remembered !== 'all' && remembered !== '__fav') {
      // 首次进入直接滚动到目标分类
      setTimeout(() => {
        const sec = document.getElementById('sec-' + remembered);
        if (sec) window.scrollTo({ top: sec.offsetTop - topOffset() - 10, behavior: 'auto' });
      }, 50);
    }
  }

  function renderSections() {
    state.view = 'sections';
    const wrap = $('#sections');
    wrap.innerHTML = '';
    const s = state.data.site || {};
    const kw = state.keyword.trim().toLowerCase();
    let anyVisible = false;

    // 递归构建：1 级分类是独立区块，2/3 级作为父区块内的子分组（各级都能有自己的链接）
    function buildCatNode(c, depth) {
      const links = (c.links || []).filter((l) => {
        if (!kw) return true;
        return (l.name + ' ' + (l.desc || '') + ' ' + l.url + ' ' + c.name)
          .toLowerCase().includes(kw);
      });
      const subNodes = [];
      let subCount = 0;
      kids(c).forEach((k) => {
        const node = buildCatNode(k, depth + 1);
        if (node) { subNodes.push(node); subCount += node.count; }
      });
      // 自身与子孙都没有内容时整支隐藏（搜索无匹配同理）
      if (links.length === 0 && subNodes.length === 0) return null;

      const total = links.length + subCount;
      const box = document.createElement(depth === 1 ? 'section' : 'div');
      box.className = depth === 1 ? 'section' : ('subsection lv' + depth);
      box.id = 'sec-' + c.id;

      const head = document.createElement('div');
      head.className = depth === 1 ? 'section-head' : ('sub-head lv' + depth);
      head.innerHTML = '<span class="sec-icon">' + catIconHtml(c.icon, depth === 1 ? 20 : (depth === 2 ? 18 : 16)) + '</span>' +
        '<span>' + escapeHtml(c.name) + '</span>' +
        '<span class="sec-count">' + total + '</span>';
      box.appendChild(head);

      if (links.length) {
        const cards = document.createElement('div');
        cards.className = 'cards ' + cardClasses(s);
        cards.style.setProperty('--card-radius', (s.cardRadius != null ? s.cardRadius : 14) + 'px');
        links.forEach((l) => cards.appendChild(buildCard(l)));
        box.appendChild(cards);
      }
      subNodes.forEach((n) => box.appendChild(n.el));
      return { el: box, count: total };
    }

    state.data.categories.forEach((c) => {
      const node = buildCatNode(c, 1);
      if (node) { wrap.appendChild(node.el); anyVisible = true; }
    });

    if (!anyVisible) {
      wrap.innerHTML = '<div class="empty">没有找到匹配的站点 🔍</div>';
    }
    initScrollSpy();
  }

  /* 卡片大小档位：1 极小 / 2 小号 / 3 中号 / 4 大号 / 5 超大。
     中号就是原来的「紧凑」，所以老数据里的 small 映射到 3（medium→4、large→5），
     否则升级后老站点会掉到默认档、看起来像"设置被重置"。
     无值 / 非法值一律按 3（中号）处理，与后台滑块的默认位置保持一致。 */
  const CARD_SIZE_LEGACY = { small: 3, medium: 4, large: 5 };
  function cardSizeLevel(v) {
    const n = Math.round(+v);
    if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
    return CARD_SIZE_LEGACY[v] || 3;
  }

  function cardClasses(s) {
    const cls = ['size-' + cardSizeLevel(s.cardSize)];
    if (s.cardColumns && s.cardColumns >= 2 && s.cardColumns <= 6) cls.push('cols-' + s.cardColumns);
    if (s.cardShadow === false) cls.push('no-shadow');
    return cls.join(' ');
  }

  function buildCard(link) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = link.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const fu = faviconUrl(link, state.data.site);
    if (fu) {
      const img = document.createElement('img');
      img.src = fu;
      img.alt = link.name;
      img.onerror = () => {
        thumb.style.background = colorFor(link.name);
        thumb.textContent = link.name.charAt(0).toUpperCase();
      };
      thumb.appendChild(img);
    } else {
      thumb.style.background = colorFor(link.name);
      thumb.textContent = link.name.charAt(0).toUpperCase();
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <div class="name">${escapeHtml(link.name)}</div>
      <div class="desc">${escapeHtml(link.desc || hostnameOf(link.url))}</div>`;

    card.appendChild(thumb);
    card.appendChild(meta);

    // 显示访问量
    if ((state.data.site || {}).showVisits && link.visits) {
      const tag = document.createElement('span');
      tag.className = 'visits-tag';
      tag.textContent = '🔥 ' + link.visits;
      card.appendChild(tag);
    }

    // 收藏按钮（⭐ 常用收藏）
    const star = document.createElement('span');
    star.className = 'fav-star' + (isFav(link.url) ? ' on' : '');
    star.setAttribute('role', 'button');
    star.title = isFav(link.url) ? '取消收藏' : '加入常用收藏';
    star.textContent = isFav(link.url) ? '★' : '☆';
    star.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(link);
      const on = isFav(link.url);
      star.classList.toggle('on', on);
      star.textContent = on ? '★' : '☆';
      star.title = on ? '取消收藏' : '加入常用收藏';
      updateFavCount();
      if (state.view === 'fav') renderFavorites();
    });
    card.appendChild(star);

    // 访问统计：点击时上报（不阻塞跳转，keepalive 保证请求完成）
    card.addEventListener('click', () => {
      try {
        fetch('api/visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: link.url }),
          keepalive: true
        });
      } catch (e) { /* 上报失败不影响使用 */ }
    });
    return card;
  }

  /* 从收藏视图回到「全部分类」浏览。
   * 收藏视图是个独立视图（正文整体替换），必须给一个显式出口 ——
   * 否则用户一旦点进「常用收藏」，正文就只剩收藏区块，看起来像「分类全没了」。
   */
  function showAllSections() {
    state.keyword = '';
    const si = $('#searchInput'); if (si) si.value = '';
    const sc = $('#searchClear'); if (sc) sc.classList.remove('show');
    state.view = 'sections';
    renderSections();
    setActive('all');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* 常用收藏视图：渲染收藏卡片 + 拖拽排序 */
  function renderFavorites() {
    state.view = 'fav';   // 与 renderSections 对称，避免 state.view 与真实渲染不一致
    const wrap = $('#sections');
    wrap.innerHTML = '';
    const favs = getFavorites();
    const kw = state.keyword.trim().toLowerCase();
    const list = favs.filter((f) =>
      !kw || (f.name + ' ' + (f.desc || '') + ' ' + f.url).toLowerCase().includes(kw));

    const bindBack = () => wrap.querySelectorAll('[data-fav-back]').forEach((b) => {
      b.addEventListener('click', showAllSections);
    });

    if (list.length === 0) {
      wrap.innerHTML = '<div class="empty">还没有收藏的站点 ⭐<br/>' +
        '浏览任意分类，点击卡片右上角的 ☆ 即可加入常用收藏' +
        '<div class="empty-actions"><button type="button" class="btn primary" data-fav-back>' +
        '← 返回全部浏览</button></div></div>';
      bindBack();
      return;
    }

    const sec = document.createElement('section');
    sec.className = 'section';
    sec.innerHTML = `
      <div class="section-head">
        <span class="sec-icon">⭐</span>
        <span>常用收藏</span>
        <span class="sec-count">${list.length}</span>
        <span class="fav-hint">拖动卡片可调整顺序</span>
        <button type="button" class="fav-back" data-fav-back>← 返回全部</button>
      </div>
      <div class="cards"></div>`;
    const cards = sec.querySelector('.cards');
    list.forEach((f) => {
      const card = buildCard(f);
      card.draggable = true;
      bindFavDrag(card, f);
      cards.appendChild(card);
    });
    wrap.appendChild(sec);
    bindBack();
  }

  function bindFavDrag(card, fav) {
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', fav.url);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drop-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop-over');
      const fromUrl = e.dataTransfer.getData('text/plain');
      if (fromUrl && fromUrl !== fav.url) reorderFavorites(fromUrl, fav.url);
    });
  }

  function setActive(id) {
    state.active = id;
    document.querySelectorAll('.side-item, .top-nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.target === id);
    });
    // 记住分类
    const s = state.data && state.data.site;
    if (s && s.rememberCategory && id !== 'all' && id !== '__fav') {
      try { sessionStorage.setItem('nav_active', id); } catch (e) {}
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 滚动高亮（scrollspy） */
  // 吸顶元素总高度（顶栏 + 搜索引擎条），用于锚点偏移与滚动监听
  function topOffset() {
    // 搜索引擎搜索已并入顶栏，吸顶高度 = 顶栏实测高度（手机端顶栏为两行）
    const topbar = document.querySelector('.topbar');
    return topbar ? topbar.offsetHeight : 60;
  }
  let spyObserver = null;
  function initScrollSpy() {
    if (spyObserver) spyObserver.disconnect();
    // 浏览器不支持 IntersectionObserver 时直接跳过：仅失去滚动高亮联动，
    // 不能让它抛错中断 init()，否则天气/日期/侧栏都不会渲染
    if (typeof IntersectionObserver === 'undefined') return;
    spyObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting && !state.keyword && state.view === 'sections') {
          const id = en.target.id.replace('sec-', '');
          setActive(id);
        }
      });
    // 顶部偏移 = 顶栏 + 搜索引擎条，避免分类被吸顶元素盖住
    }, { rootMargin: '-' + (topOffset() + 20) + 'px 0px -70% 0px' });
    // 1 级是 .section，2/3 级是 .subsection，两者都带 sec- 前缀 id，需一并监听
    document.querySelectorAll('[id^="sec-"]').forEach((el) => spyObserver.observe(el));
  }

  /* 搜索 */
  function onSearch(v) {
    state.keyword = v;
    $('#searchClear').classList.toggle('show', !!v);
    if (state.view === 'fav') renderFavorites();
    else renderSections();
    if (v && state.view !== 'fav') setActive('all');
  }
  function clearSearch() {
    $('#searchInput').value = '';
    onSearch('');
  }

  /* ===== 自动填充守卫 =====
     Chrome / Edge 的密码管理器会无视 autocomplete="off"，把保存的账号名
     （如 "admin"）直接写进页面顶部的文本框。更麻烦的是它**会触发 input 事件**，
     于是页面一打开就真的执行了一次"搜索 admin"，正文只剩一条匹配结果 ——
     看起来像是程序自己乱搜，其实是浏览器填充的（2026-09 线上实际反馈）。

     治本手段在 index.html：搜索框改用 type="search"，不会被当作凭据字段。
     这里再加一层兜底，防止别的浏览器 / 别的路径仍然填进来。

     判据：autofill 只设值、**不会触发 focus / keydown / pointerdown 等真实交互**，
     所以「有值 + 全程无交互痕迹」即可判定为浏览器填充。只在初始化后的短窗口内
     检查（浏览器填充都发生在这个阶段），窗口期一过立即收手，绝不干预用户输入。
     若代码里没有这个守卫，用户手动输入的值也不会被误清——因为那时一定有交互痕迹。 */
  function guardAutofill() {
    const boxes = [$('#searchInput'), $('#wsInput')].filter(Boolean);
    if (!boxes.length) return;

    const touched = new WeakSet();
    boxes.forEach((el) => {
      ['focus', 'keydown', 'pointerdown', 'touchstart'].forEach((ev) =>
        el.addEventListener(ev, () => touched.add(el), { once: true, passive: true }));
    });

    const deadline = Date.now() + 2500;
    (function check() {
      let cleaned = false;
      boxes.forEach((el) => {
        if (el.value && !touched.has(el)) { el.value = ''; cleaned = true; }
      });
      // 清掉被填充的搜索词后，视图必须退回「全部分类」，
      // 否则正文仍停在那个"自动搜索"的结果上，跟没清一样。
      if (cleaned) {
        const sc = $('#searchClear');
        if (sc) sc.classList.remove('show');
        const wc = $('#wsClear');
        if (wc) wc.classList.remove('show');
        if (state.keyword) {
          state.keyword = '';
          if (state.view === 'fav') renderFavorites(); else renderSections();
          setActive('all');
        }
      }
      if (Date.now() < deadline) setTimeout(check, 150);
    })();
  }

  /* 移动端侧栏 */
  function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebarMask').classList.add('show'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebarMask').classList.remove('show'); }

  function bindUI() {
    $('#searchInput').addEventListener('input', (e) => onSearch(e.target.value));
    $('#searchClear').addEventListener('click', clearSearch);

    // 搜索引擎快速入口
    const wsForm = $('#wsForm');
    if (wsForm) {
      wsForm.addEventListener('submit', (e) => { e.preventDefault(); doWebSearch(); });
      $('#wsInput').addEventListener('input', (e) => {
        $('#wsClear').classList.toggle('show', !!e.target.value);
      });
      $('#wsClear').addEventListener('click', () => {
        $('#wsInput').value = '';
        $('#wsClear').classList.remove('show');
        $('#wsInput').focus();
      });
      // 手机端：点击引擎徽标展开 / 收起引擎列表
      $('#wsBadge').addEventListener('click', (e) => {
        e.preventDefault();
        $('#wsEngines').classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        const eng = $('#wsEngines');
        if (!eng || !eng.classList.contains('open')) return;
        if (eng.contains(e.target) || e.target.closest('#wsBadge')) return;
        eng.classList.remove('open');
      });
    }
    $('#menuToggle').addEventListener('click', openSidebar);
    $('#sidebarMask').addEventListener('click', closeSidebar);
    $('#themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('theme', cur); } catch (e) {}
    });

    // 拦住浏览器密码管理器往搜索框里灌账号名（详见 guardAutofill 注释）
    guardAutofill();
  }

  /* ===== 账户体系：登录 / 注册 / 用户中心（提交「添加网站」申请） =====
   * 与后台 admin.html 共用同一个 token 存储键，登录一次两处通用。
   * 普通用户登录后能提交申请、查看审核进度；改动导航数据仍只允许管理员。
   */
  const TOKEN_KEY = 'navAdminToken';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { return ''; }
  }
  function setToken(tok, remember) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      if (!tok) return;
      if (remember) localStorage.setItem(TOKEN_KEY, tok);
      else sessionStorage.setItem(TOKEN_KEY, tok);
    } catch (e) {}
  }
  // 带鉴权的请求：非 2xx 一律抛错，调用方按 e.status / e.message 决定提示
  async function apiAuth(path, method, body) {
    const opt = { method: method || 'GET', headers: { 'Content-Type': 'application/json' } };
    const t = getToken();
    if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    if (body) opt.body = JSON.stringify(body);
    const res = await fetch(path, opt);
    let j = null;
    try { j = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((j && j.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      err.data = j || {};
      throw err;
    }
    return j || {};
  }

  let acct = { loggedIn: false, user: null, role: null, isAdmin: false };
  function openMask(el) { if (el) el.hidden = false; }
  function closeMask(el) { if (el) el.hidden = true; }
  function maskMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'modal-msg' + (kind ? ' ' + kind : '');
  }

  async function initAccount() {
    bindAccountUI();
    try { acct = await apiAuth('/api/auth/me'); }
    catch (e) { /* 离线 / 未部署 Functions：按未登录处理，不影响浏览 */ }
    renderAcctBtn();
    fillApplyCategories();
  }
  function renderAcctBtn() {
    const btn = $('#acctBtn'), txt = $('#acctTxt'), icon = $('#acctIcon');
    if (!btn) return;
    if (acct.loggedIn) {
      btn.classList.add('logged');
      if (txt) txt.textContent = acct.nickname || acct.user;
      if (icon) icon.textContent = acct.isAdmin ? '🛡️' : '👤';
      btn.title = (acct.isAdmin ? '管理员' : '普通用户') + '：' + acct.user + '（点击打开我的账户）';
    } else {
      btn.classList.remove('logged');
      if (txt) txt.textContent = '登录';
      if (icon) icon.textContent = '👤';
      btn.title = '登录 / 注册';
    }
  }
  // 申请表单里的「建议分类」用现有分类填充，避免用户凭空造分类
  function fillApplyCategories() {
    const sel = $('#appCat');
    if (!sel) return;
    const cats = (state.data && state.data.categories) || [];
    sel.innerHTML = '<option value="">建议分类（可选）</option>' +
      cats.map((c) => '<option value="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</option>').join('');
  }

  function switchAuthTab(which) {
    const isLogin = which !== 'register';
    const tl = $('#tabLogin'), tr = $('#tabRegister');
    if (tl) tl.classList.toggle('active', isLogin);
    if (tr) tr.classList.toggle('active', !isLogin);
    const pl = $('#paneLogin'), pr = $('#paneRegister');
    if (pl) pl.classList.toggle('hidden', !isLogin);
    if (pr) pr.classList.toggle('hidden', isLogin);
  }

  function bindAccountUI() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

    on('#acctBtn', 'click', () => {
      if (acct.loggedIn) openUserCenter();
      else { switchAuthTab('login'); openMask($('#authMask')); }
    });
    on('#authX', 'click', () => closeMask($('#authMask')));
    on('#userX', 'click', () => closeMask($('#userMask')));
    // 点遮罩空白处关闭
    on('#authMask', 'click', (e) => { if (e.target === $('#authMask')) closeMask($('#authMask')); });
    on('#userMask', 'click', (e) => { if (e.target === $('#userMask')) closeMask($('#userMask')); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeMask($('#authMask')); closeMask($('#userMask'));
    });

    on('#tabLogin', 'click', () => switchAuthTab('login'));
    on('#tabRegister', 'click', () => switchAuthTab('register'));
    on('#doLogin', 'click', doLogin);
    on('#doRegister', 'click', doRegister);
    on('#doApply', 'click', doApply);
    on('#doLogout', 'click', doLogout);
    on('#goAdmin', 'click', () => { location.href = 'admin.html'; });

    // 回车提交
    ['loginUser', 'loginPwd'].forEach((id) => on('#' + id, 'keydown', (e) => { if (e.key === 'Enter') doLogin(); }));
    ['regUser', 'regNick', 'regPwd', 'regReason'].forEach((id) => on('#' + id, 'keydown', (e) => { if (e.key === 'Enter') doRegister(); }));
    on('#appUrl', 'keydown', (e) => { if (e.key === 'Enter') doApply(); });
    on('#appName', 'keydown', (e) => { if (e.key === 'Enter') doApply(); });
  }

  async function doLogin() {
    const user = ($('#loginUser') && $('#loginUser').value || '').trim();
    const password = ($('#loginPwd') && $('#loginPwd').value) || '';
    const remember = !!($('#loginRemember') && $('#loginRemember').checked);
    if (!user || !password) return maskMsg($('#loginMsg'), '请填写账号和密码', 'err');

    const btn = $('#doLogin'); if (btn) btn.disabled = true;
    maskMsg($('#loginMsg'), '登录中…');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password, remember })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return maskMsg($('#loginMsg'), j.error || '登录失败', 'err');
      setToken(j.token, remember);
      acct = { loggedIn: true, user: j.user, role: j.role, isAdmin: j.role === 'admin', nickname: j.nickname || j.user };
      renderAcctBtn();
      maskMsg($('#loginMsg'), '');
      const pw = $('#loginPwd'); if (pw) pw.value = '';
      closeMask($('#authMask'));
      // 登录会打开用户中心弹窗、正文不再是用户刚才看的东西；
      // 若此前停在收藏视图，这里统一退回「全部分类」，避免登录后正文只剩收藏区块。
      if (state.view === 'fav') showAllSections();
      openUserCenter();
    } catch (e) {
      maskMsg($('#loginMsg'), '网络错误：' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function doRegister() {
    const username = ($('#regUser') && $('#regUser').value || '').trim();
    const password = ($('#regPwd') && $('#regPwd').value) || '';
    const nickname = ($('#regNick') && $('#regNick').value || '').trim();
    const reason = ($('#regReason') && $('#regReason').value || '').trim();
    if (!username || !password) return maskMsg($('#regMsg'), '请填写账号和密码', 'err');

    const btn = $('#doRegister'); if (btn) btn.disabled = true;
    maskMsg($('#regMsg'), '提交中…');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, nickname, reason })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return maskMsg($('#regMsg'), j.error || '注册失败', 'err');
      maskMsg($('#regMsg'), j.message || '注册成功，等待管理员审核', 'ok');
      const rp = $('#regPwd'); if (rp) rp.value = '';
      // 顺手把账号填到登录框，审核通过后可直接登录
      const lu = $('#loginUser'); if (lu) lu.value = username;
    } catch (e) {
      maskMsg($('#regMsg'), '网络错误：' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function openUserCenter() {
    const who = $('#userWho');
    if (who) who.textContent = (acct.nickname || acct.user || '') + (acct.isAdmin ? '（管理员）' : '（普通用户）');
    const ga = $('#goAdmin');
    if (ga) ga.hidden = !acct.isAdmin;   // 普通用户不显示后台入口
    fillApplyCategories();
    openMask($('#userMask'));
    loadMyApps();
  }

  async function loadMyApps() {
    const box = $('#myApps');
    if (!box) return;
    box.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const r = await apiAuth('/api/applications');
      const list = r.applications || [];
      if (!list.length) { box.innerHTML = '<p class="hint">暂无申请记录</p>'; return; }
      box.innerHTML = list.map(renderAppItem).join('');
      box.querySelectorAll('[data-withdraw]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await apiAuth('/api/applications/' + encodeURIComponent(b.getAttribute('data-withdraw')), 'PATCH', { action: 'withdraw' });
            maskMsg($('#applyMsg'), '已撤回', 'ok');
            loadMyApps();
          } catch (e) {
            b.disabled = false;
            maskMsg($('#applyMsg'), e.message, 'err');
          }
        });
      });
    } catch (e) {
      box.innerHTML = '<p class="hint">' + escapeHtml(e.message) + '</p>';
    }
  }

  function renderAppItem(a) {
    const CAT_TEXT = { pending: '待审核', active: '已通过', rejected: '未通过', disabled: '已禁用' };
    const label = CAT_TEXT[a.status] || a.statusText || a.status;
    const cat = a.category ? ' → ' + escapeHtml(a.category) : '';
    const time = a.createdAt ? new Date(a.createdAt).toLocaleString('zh-CN') : '';
    const note = a.note ? '<div class="ai-note">审核意见：' + escapeHtml(a.note) + '</div>' : '';
    return '<div class="apply-item"><div class="ai-main">' +
      '<div class="ai-name">' + escapeHtml(a.name || '') + cat + '</div>' +
      '<div class="ai-url">' + escapeHtml(a.url || '') + '</div>' +
      (time ? '<div class="ai-note">' + escapeHtml(time) + '</div>' : '') + note +
      '</div><span class="badge ' + escapeHtml(a.status) + '">' + escapeHtml(label) + '</span>' +
      (a.status === 'pending'
        ? '<button class="btn sm ghost" data-withdraw="' + escapeHtml(a.id) + '">撤回</button>'
        : '') +
      '</div>';
  }

  async function doApply() {
    const url = ($('#appUrl') && $('#appUrl').value || '').trim();
    if (!url) return maskMsg($('#applyMsg'), '请填写网址', 'err');
    const body = {
      url,
      name: ($('#appName') && $('#appName').value || '').trim(),
      desc: ($('#appDesc') && $('#appDesc').value || '').trim(),
      category: ($('#appCat') && $('#appCat').value) || ''
    };
    const btn = $('#doApply'); if (btn) btn.disabled = true;
    maskMsg($('#applyMsg'), '提交中…');
    try {
      const r = await apiAuth('/api/applications', 'POST', body);
      maskMsg($('#applyMsg'), r.message || '已提交，等待管理员审核', 'ok');
      ['#appUrl', '#appName', '#appDesc'].forEach((s) => { const el = $(s); if (el) el.value = ''; });
      loadMyApps();
    } catch (e) {
      if (e.status === 401) {
        maskMsg($('#applyMsg'), '登录已失效，请重新登录', 'err');
        setToken(''); acct = { loggedIn: false }; renderAcctBtn();
      } else {
        maskMsg($('#applyMsg'), e.message, 'err');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function doLogout() {
    setToken('');
    acct = { loggedIn: false, user: null, role: null, isAdmin: false };
    renderAcctBtn();
    closeMask($('#userMask'));
    // 退出登录同样把正文还原成分类浏览，避免残留收藏视图
    if (state.view === 'fav') showAllSections();
  }

  async function init() {
    bindUI();
    try {
      await loadData();
    } catch (err) {
      $('#sections').innerHTML = '<div class="empty">加载数据失败：' + escapeHtml(err.message) +
        '<br/>推荐用 <code>node server.js</code> 启动后访问 <code>http://localhost:8787</code>。' +
        '<br/>若直接双击打开本文件（file:// 协议），需确保同目录存在 <code>data/sites.js</code> 兜底文件' +
        '（由 <code>node scripts/gen-data-js.mjs</code> 生成，保存数据时会自动同步）。</div>';
      return;
    }
    renderHead();
    renderWebSearch();
    buildSidebar();
    renderSections();
    applySettings();
    updateFavCount();
    // 账户：绑定登录/注册/用户中心交互，并读取当前身份（未登录或接口不可用都不影响浏览）
    initAccount();
    // 首次加载：立即刷新天气与日期（「跟随网页刷新」优先）
    refreshWeather(true);
    initCalendar();
    // 定时自动刷新：跨天翻页 + 天气定时更新（页面长期挂着不刷新也能自动走）
    startAutoRefresh();
    // 视口变化会让顶栏换行 / 站名描述重新排布，高度要跟着重算
    window.addEventListener('resize', scheduleSyncTopHeight);
    // 自定义字体加载完成后文字尺寸会跳一下，再量一次更稳
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(scheduleSyncTopHeight).catch(() => {});
    }
  }

  /* ===== 天气模块（主页左上角） ===== */
  const WMO = {
    0: ['☀️', '晴'], 1: ['🌤️', '晴间多云'], 2: ['⛅', '多云'], 3: ['☁️', '阴'],
    45: ['🌫️', '雾'], 48: ['🌫️', '雾'],
    51: ['🌦️', '毛毛雨'], 53: ['🌦️', '毛毛雨'], 55: ['🌦️', '毛毛雨'],
    56: ['🌧️', '冻雨'], 57: ['🌧️', '冻雨'],
    61: ['🌧️', '小雨'], 63: ['🌧️', '中雨'], 65: ['🌧️', '大雨'],
    66: ['🌧️', '冻雨'], 67: ['🌧️', '冻雨'],
    71: ['🌨️', '小雪'], 73: ['🌨️', '中雪'], 75: ['❄️', '大雪'], 77: ['❄️', '雪粒'],
    80: ['🌦️', '阵雨'], 81: ['🌦️', '阵雨'], 82: ['⛈️', '强阵雨'],
    85: ['🌨️', '阵雪'], 86: ['🌨️', '阵雪'],
    95: ['⛈️', '雷阵雨'], 96: ['⛈️', '雷阵雨伴冰雹'], 99: ['⛈️', '雷阵雨伴冰雹']
  };
  function wmoInfo(code) { return WMO[code] || ['🌡️', '未知']; }

  function renderWeather(city, temp, code) {
    const [icon, desc] = wmoInfo(code);
    const el = document.getElementById('weatherCard');
    if (!el) return;
    el.innerHTML =
      '<div class="mw-row"><span class="mw-icon">' + icon + '</span>' +
      '<span class="mw-temp">' + Math.round(temp) + '°</span></div>' +
      '<div class="mw-meta"><span class="mw-city">' + escapeHtml(city || '本地') + '</span>' +
      '<span class="mw-desc">' + desc + '</span></div>';
  }
  function renderWeatherError(msg) {
    const el = document.getElementById('weatherCard');
    if (el) el.innerHTML = '<div class="mini-loading">🌤️ ' + escapeHtml(msg || '天气获取失败') + '</div>';
  }
  async function fetchWeather(lat, lon) {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&current=temperature_2m,weather_code&timezone=auto';
    // no-store：避免浏览器/中间缓存把上一小时的温度原样返回，导致「刷新了但数字没变」
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('weather ' + r.status);
    const j = await r.json();
    const cur = j.current || {};
    return { temp: cur.temperature_2m, code: cur.weather_code };
  }
  async function fetchCityName(lat, lon) {
    try {
      const r = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=zh');
      if (r.ok) {
        const j = await r.json();
        return j.city || j.locality || j.principalSubdivision || '';
      }
    } catch (e) {}
    return '';
  }
  // 缓存只在「拉取失败」时兜底，正常情况下天气跟随页面刷新实时更新
  function readWeatherCache() {
    try {
      const o = JSON.parse(localStorage.getItem('nav_weather'));
      if (o && o.temp != null) return o;
    } catch (e) {}
    return null;
  }
  function writeWeatherCache(o) {
    try { o.ts = Date.now(); localStorage.setItem('nav_weather', JSON.stringify(o)); } catch (e) {}
  }
  // 按 IP 定位：不再使用 navigator.geolocation。
  // 它会弹授权框，用户拒绝或超时会直接抛错且不回退到 IP，
  // 导致天气长期停在旧数据或一直显示「天气不可用」。
  async function locateByIp() {
    const sources = [
      { url: 'https://ipapi.co/json/', pick: (d) => ({ lat: d.latitude, lon: d.longitude, city: d.city || '' }) },
      { url: 'https://ipwho.is/', pick: (d) => ({ lat: d.latitude, lon: d.longitude, city: d.city || '' }) }
    ];
    let lastErr = null;
    for (const s of sources) {
      try {
        const r = await fetch(s.url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        const loc = s.pick(d);
        if (typeof loc.lat === 'number' && typeof loc.lon === 'number') return loc;
        throw new Error('未返回坐标');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('定位失败');
  }
  // 返回是否拉取成功，供自动刷新判定是否需要重试
  async function initWeather() {
    // 每次页面加载都重新拉取，天气随刷新更新
    try {
      const loc = await locateByIp();
      let city = loc.city || '';
      if (!city) city = await fetchCityName(loc.lat, loc.lon).catch(() => '');
      const w = await fetchWeather(loc.lat, loc.lon);
      renderWeather(city, w.temp, w.code);
      writeWeatherCache({ city: city, temp: w.temp, code: w.code });
      return true;
    } catch (e) {
      const cached = readWeatherCache();
      if (cached) renderWeather(cached.city, cached.temp, cached.code);
      else renderWeatherError('天气不可用');
      return false;
    }
  }

  /* ===== 万年历 / 节气（主页左上角） ===== */
  function pickFestival(f) {
    if (!f) return '';
    if (Array.isArray(f)) return f.filter(Boolean).join('、');
    if (typeof f === 'object') return Object.values(f).filter(Boolean).join('、');
    return String(f);
  }
  function renderCalendar(info) {
    const el = document.getElementById('calendarCard');
    if (!el) return;
    const d = new Date();
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const solar = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wd;
    const lunar = info.lunar || '';
    const jieqi = info.jieqi || '';
    const festival = pickFestival(info.festival);
    let greet = '';
    if (festival) greet = festival + '快乐 🎉';
    else if (jieqi) greet = '今日' + jieqi;
    let sub = lunar;
    if (jieqi) sub = (lunar ? lunar + ' · ' : '') + jieqi;
    if (festival) sub = (sub ? sub + ' · ' : '') + festival;
    el.innerHTML =
      '<div class="mc-solar">' + solar + '</div>' +
      '<div class="mc-sub">' + escapeHtml(sub || '') + '</div>' +
      (greet ? '<div class="mc-greet">' + escapeHtml(greet) + '</div>' : '');
  }
  async function initCalendar() {
    try {
      // 内置农历/节气/节日计算，不依赖外部 API（离线可用、无 CORS 问题）
      const info = (window.NavLunar && window.NavLunar.info)
        ? window.NavLunar.info(new Date())
        : null;
      if (info) { renderCalendar(info); return; }
    } catch (e) { /* 落到下方兜底 */ }
    // 兜底：仅显示公历
    const el = document.getElementById('calendarCard');
    if (el) {
      const d = new Date();
      const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      el.innerHTML = '<div class="mc-solar">' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wd +
        '</div><div class="mc-sub">📅 农历获取失败</div>';
    }
  }

  /* ===== 自动刷新：日期跨天自动翻页 + 天气定时自动更新 =====
   * 问题：initWeather / initCalendar 此前只在页面加载时执行一次，页面长期挂着不刷新的话，
   *   过了零点日期不会翻页、天气也停在旧数据，看起来就是「未能自动更新」。
   * 策略（以「跟随网页刷新」优先，定时器兜底）：
   *   1. 每次页面加载/切回页面/网络恢复 → 立即或按需补刷；
   *   2. 单一 ticker 每 30s 检测一次：跨天则重渲染日历，天气过期则重新拉取。
   */
  const WEATHER_TTL_MS = 30 * 60 * 1000;        // 天气自动刷新间隔
  const WEATHER_VISIBLE_STALE_MS = 10 * 60 * 1000; // 切回页面时超过此时长才算过期、需要补刷
  const AUTO_TICK_MS = 30 * 1000;               // 检测频率（跨天 + 天气过期）
  let lastWeatherAt = 0;
  let lastDateKey = dateKey();

  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // 跨天自动重渲染日历：过了零点无需手动刷新页面
  function refreshCalendarIfDayChanged() {
    const k = dateKey();
    if (k === lastDateKey) return false;
    lastDateKey = k;
    initCalendar();
    return true;
  }

  async function refreshWeather(force) {
    const now = Date.now();
    if (!force && lastWeatherAt && now - lastWeatherAt < WEATHER_TTL_MS) return;
    lastWeatherAt = now;
    const ok = await initWeather();
    // 拉取失败时不占用刷新窗口，下一个 tick 会继续重试（网络恢复后自动补上）
    if (!ok) lastWeatherAt = 0;
  }

  function startAutoRefresh() {
    // 兜底 ticker：机器休眠醒来后 setInterval 可能漏跑，下面的 visibilitychange 会补
    setInterval(() => {
      refreshCalendarIfDayChanged();
      refreshWeather(false);
    }, AUTO_TICK_MS);

    // 切回页面：过期即补刷（含跨天翻页）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      refreshCalendarIfDayChanged();
      if (Date.now() - lastWeatherAt >= WEATHER_VISIBLE_STALE_MS) refreshWeather(true);
    });

    // 断网恢复：立即重试一次
    window.addEventListener('online', () => { refreshWeather(true); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
