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
    // 侧栏一个、顶栏一个（分类在顶部时只有顶栏那个可见，见 buildTopNav），两处都要同步。
    // 注意：.fav-count 的样式表默认是 display:none，清成 '' 会回落到 display:none（角标永远不显示），
    // 必须显式写成 inline-block，否则「收藏数量」永远看不见。
    ['favCount', 'favCountTop'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = n; el.style.display = n ? 'inline-block' : 'none'; }
    });
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

  /* ⛔ 不要再往这里加「按名称屏蔽分类」之类的硬编码（2026-10-07 移除）。
   *
   * 曾经有一份 `HIDDEN_CATEGORY_NAMES = ['常用推荐']`，在渲染前按名称把同名分类
   * 连同子级一起 filter 掉。当时的理由是：数据层（data/sites.json、functions/_seed.js）
   * 已删除「常用推荐」，但线上数据在 Cloudflare KV 里，仅改文件部署去不掉旧副本，
   * 所以在前端兜一道。
   *
   * 代价是**用户永远建不出叫这个名字的分类**：他后来在后台重建了「常用推荐」，
   * 后台看得见、主页却死活不显示，排查半天才发现是被这段硬编码吃掉的。
   * 结论：数据层要删分类就删数据本身；前端按名字拦截会把数据问题和显示问题
   * 混成一团，且用户完全没有自服务的余地。
   */

  async function loadData() {
    // 后台「首页预览」：优先用后台推来的「尚未保存」的数据，改完即见。
    // 没有预览数据（第一次打开后台）时照常走下面的在线加载。
    if (PREVIEW_MODE) {
      const pv = readPreviewData();
      if (pv) { state.data = pv; return; }
    }
    let fresh;
    try {
      fresh = await fetchSiteData();
    } catch (e) {
      const snap = readDataCache();
      if (!snap) throw new Error(e.message || '无法加载导航数据');
      state.data = snap; // 离线兜底：用上次快照渲染
      return;
    }
    state.data = fresh;
    // 缓存开关：开启才保留快照；关闭则清掉，保证每次都拿最新数据
    if (fresh.site && fresh.site.cacheEnabled === true) writeDataCache(fresh);
    else clearDataCache();
  }

  /* ===== 页面版本号 =====
   * 直接取本页 app.js 的 ?v= 戳：构建时 scripts/version.js 会把
   * index.html / admin.html 里所有 `?v=` 统一拨成构建时间戳 YYYYMMDDHHmm，
   * 所以这个值与「本次部署」严格一致。不再另设一份版本常量 ——
   * 常量早晚会忘了同步，那时左下角就成了假信息，比不显示更糟。
   *
   * 显示它的意义很实在：改完代码看不出效果时，低头看一眼版本号有没有变，
   * 就能分清是「代码没生效」还是「浏览器还吃着旧缓存」，不用反复猜。
   */
  function readBuildVersion() {
    try {
      const tag = document.querySelector('script[src*="app.js"]');
      const m = tag && tag.src ? String(tag.src).match(/[?&]v=(\d{8,14})/) : null;
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  // 202609241448 → "v2026.09.24 14:48"（只有 8 位日期戳时就不带时分）
  function formatVersion(raw) {
    if (!raw || raw.length < 8) return '';
    const y = raw.slice(0, 4), mo = raw.slice(4, 6), d = raw.slice(6, 8);
    const hh = raw.slice(8, 10), mi = raw.slice(10, 12);
    return (hh && mi) ? `v${y}.${mo}.${d} ${hh}:${mi}` : `v${y}.${mo}.${d}`;
  }

  /* 侧栏底部（页面左下角）：副标题 / 数据来源 / 版本号，逐行 <div>。
   * 不拼 '\n' 的原因见 css/style.css 里 .side-foot 那段的注释（HTML 会把换行折掉）。
   * 副标题为空时整行不输出，免得留一行空白。 */
  function renderSideFoot(s) {
    const foot = $('#sideFoot');
    if (!foot) return;
    foot.textContent = '';
    const line = (txt, cls) => {
      const t = String(txt == null ? '' : txt).trim();
      if (!t) return null;
      const d = document.createElement('div');
      if (cls) d.className = cls;
      d.textContent = t;          // 一律用 textContent：副标题来自配置，不走 innerHTML
      foot.appendChild(d);
      return d;
    };
    line(s.subtitle);
    line('数据：data/sites.json');
    const raw = readBuildVersion();
    const ver = formatVersion(raw);
    if (ver) {
      const el = line(ver, 'sf-ver');   // 字号与上面两行一致，见 .side-foot .sf-ver
      if (el) el.title = '当前部署版本 ' + raw + '（构建时自动生成，与静态资源缓存戳同源）';
    }
  }

  function renderHead() {
    const s = state.data.site || {};
    // 站点图标交给 js/logos.js 统一渲染：内置光伏图标 → 内联 SVG，
    // emoji / 短文字 → 文本，图片地址 → <img>（三种值都兼容，详见 logos.js 顶部说明）。
    // 空值交给 markup() 回落到默认图标 —— 后台把图标清空 = 恢复默认，而不是留个空位。
    // logos.js 万一没加载（理论上不会，index.html / admin.html 都已引入）就退回纯文本，
    // 行为与旧版一致，不至于把图标整个丢掉。
    const logoEl = $('#siteLogo');
    if (logoEl) {
      if (window.NAV_LOGOS) logoEl.innerHTML = window.NAV_LOGOS.markup(s.logo);
      else if (s.logo) logoEl.textContent = s.logo;
    }
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
    renderSideFoot(s);
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
  /* 分类排序。⭐ 2026-10-07 关键修正：**默认不再排序，原样保留数组顺序**。
   *
   * 起因：用户在后台拖动主分类排序，正文区块的顺序变了，左侧分类栏却纹丝不动 ——
   * 因为这里无条件按 `name` 的 zh-Hans-CN（拼音）重排了一遍，把拖动结果覆盖掉。
   * 而 `order` 字段后台没有任何入口可以设置（数据里也一个都没有），所以那段
   * cmp 永远走"两侧都没 order"的分支，等价于「永远按拼音排」。
   *
   * 现在的规则：**只有当这一层里真的存在 order 时，才按 order 排**。
   * 数组顺序本身就是用户拖出来的顺序，不该被二次排序推翻。
   * （order 的支持保留着，是为了兼容早期手写 order 的数据，不识别它反而会让那些站点的顺序变乱。）
   */
  function sortCats(list) {
    const arr = Array.isArray(list) ? list : [];
    const mapped = (src) => src.map((c) => {
      const nc = Object.assign({}, c);
      if (c.children && c.children.length) nc.children = sortCats(c.children);
      return nc;
    });
    const usesOrder = arr.some((c) => c && c.order != null && c.order !== '');
    if (!usesOrder) return mapped(arr);
    const cmp = (a, b) => {
      const oa = a.order, ob = b.order;
      const ha = oa != null && oa !== '', hb = ob != null && ob !== '';
      if (ha && hb) return (oa - ob) || String(a.name||'').localeCompare(String(b.name||''), 'zh-Hans-CN', { numeric: true });
      if (ha) return -1;
      if (hb) return 1;
      return String(a.name||'').localeCompare(String(b.name||''), 'zh-Hans-CN', { numeric: true });
    };
    return mapped([...arr].sort(cmp));
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
    /* 「常用收藏」入口（2026-10-07 补）：
     * 分类在顶部时**侧栏整个不显示**，而顶栏原先只有「全部 + 各分类」——
     * 于是用户没有任何路径进入收藏视图（顶部区块只展示前 12 个，「查看全部」够不着）。
     * 这里放在「全部」之后、第一个分类之前，位置与侧栏那份对称。
     * 带 .fav-entry 类是为了复用 applySettings() 里那套「后台开关控制显隐」的逻辑，
     * 不要再写一套自己的显隐判断。 */
    const favItem = '<a class="' + allCls + ' fav-entry" data-target="__fav" href="#__fav">⭐ 常用收藏' +
      '<span class="fav-count" id="favCountTop">0</span></a>';
    nav.innerHTML = '<a class="' + allCls + '" data-target="all" href="#all">🏠 全部</a>' +
      favItem + navItems.join('');
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
        // 收藏入口：行为与侧栏那份保持一致（再点一次返回全部分类，收藏视图不是死胡同）。
        // 不能落到下面的分类分支 —— 那里会去找 #sec-__fav，找不到就什么都发生，
        // 表现成「点了没反应」。
        if (t === '__fav') {
          if (state.view === 'fav') { showAllSections(); return; }
          openFavoritesView();
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
    // 图片地址要先解析成绝对 URL 再交给 CSS：
    // background 这条声明写在 css/style.css 里，CSS 中的相对 URL 是**相对于该样式表**
    // 解析的 —— 直接写 assets/wallpapers/a.jpg 会变成 /css/assets/wallpapers/a.jpg（404）。
    // 按 document.baseURI 解析，站点部署在根路径或子路径（如 GitHub Pages 的 /repo/）都对。
    let bgVal = val;
    if (type === 'image') {
      try {
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(val)) bgVal = new URL(val, document.baseURI).href;
      } catch (e) { bgVal = val; }   // 解析失败就原样用，交给浏览器去试
    }
    const bg = type === 'image' ? 'url("' + bgVal.replace(/"/g, '\\"') + '")' : val;
    document.body.style.setProperty('--wp-bg', bg);
    document.body.style.setProperty('--wp-opacity', s.wallpaperOpacity != null ? s.wallpaperOpacity : 0.08);
    document.body.style.setProperty('--wp-blur', (s.wallpaperBlur || 0) + 'px');
  }

  /* 集中应用所有设置（在数据加载完成后调用） */
  function applySettings() {
    const s = state.data.site || {};
    // 分类位置：顶部
    // ⚠️ 必须排在下面「同步收藏入口显隐」之前：buildTopNav() 会**新插入**一个 .fav-entry，
    // 晚于那次 forEach 才出现的节点不会被同步到。分类在顶部时侧栏整个不显示，
    // 顶栏那一个就是唯一入口，漏同步会直接表现成「找不到常用收藏」（2026-10-07 修）。
    if (s.categoryPosition === 'top') {
      document.documentElement.classList.add('layout-top');
      buildTopNav();
    }
    // 隐藏常用收藏
    // 注意：这里写的是行内样式。若只处理 === false 分支，在后台把开关重新打开后
    // 行内 display:none 会一直残留在节点上，导致「常用收藏」再也点不出来。两个分支都要处理。
    const hideFav = s.showFavorites === false;
    document.querySelectorAll('.fav-entry').forEach((e) => { e.style.display = hideFav ? 'none' : ''; });
    if (hideFav) {
      // 若在收藏视图，自动退回全部
      if (state.active === '__fav') state.active = 'all';
      if (state.view === 'fav') showAllSections();
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
    // 顶部「常用收藏」：开关可能刚从 false 改回 true（hideFav 分支已把视图退回全部），
    // 这里必须重渲染一次，否则行内 display:none 撤了、区块却还停在空状态
    renderTopFavorites();
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
        '<span class="sec-name">' + escapeHtml(c.name) + '</span>' +
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

    // ⭐ 顺序的唯一来源就是 sortCats（它默认保留数组顺序，只有存在 order 时才按 order 排）。
    // 侧栏 / 顶部导航走的是同一个函数 —— 三处必须用同一份顺序，否则「侧栏一个排法、
    // 正文另一个排法」，用户拖动后就会发现两边对不上（2026-10-07）。
    sortCats(state.data.categories).forEach((c) => {
      const node = buildCatNode(c, 1);
      if (node) { wrap.appendChild(node.el); anyVisible = true; }
    });

    if (!anyVisible) {
      wrap.innerHTML = '<div class="empty">没有找到匹配的站点 🔍</div>';
    }
    // 顶部「常用收藏」跟着分类视图一起刷新（搜索词变化时同样要按关键词过滤）
    renderTopFavorites();
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
      // 顶部区块里的卡片也可能正被点，重建一次同步（取消收藏后那张卡片就该消失）
      renderTopFavorites();
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
    renderTopFavorites(); // 收藏视图已整块占用正文，把顶部区块撤掉，否则同一批卡片会出现两遍
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

  /* ===== 顶部「常用收藏」区块（常驻在 hero 与第一个分类之间） =====
   * 与侧栏的收藏视图（renderFavorites）是**两套**，分工不同，别互相替代：
   *   · 这里   = 快捷浏览。一进首页就看得见，限 FAV_TOP_LIMIT 个，超出给「查看全部」入口；
   *   · 侧栏视图 = 完整列表 + 拖拽排序（点侧栏「⭐ 常用收藏」或本区块的「查看全部」进入）。
   * 两者共用 localStorage.nav_favorites 与 buildCard()，所以星标一点、两边同步。
   * 「始终显示」的取舍：点某个分类、甚至正在搜索时都保留本区块 —— 只有两种情况撤掉：
   *   ① 后台把「显示常用收藏」关了；② 正文已被收藏视图整块占用（再来一份就是重复）。
   * 搜索时若收藏里一条都没命中，也让位给搜索结果 —— 否则结果上方杵一个空区块很怪。
   */
  const FAV_TOP_LIMIT = 12;

  function renderTopFavorites() {
    const box = $('#favTop');
    if (!box) return;
    const s = state.data.site || {};

    if (s.showFavorites === false || state.view === 'fav') {
      box.innerHTML = '';
      box.hidden = true;
      return;
    }

    const kw = state.keyword.trim().toLowerCase();
    const list = getFavorites().filter((f) =>
      !kw || (f.name + ' ' + (f.desc || '') + ' ' + f.url).toLowerCase().includes(kw));
    if (kw && list.length === 0) { box.innerHTML = ''; box.hidden = true; return; }

    box.hidden = false;
    box.innerHTML = '';

    const sec = document.createElement('section');
    sec.className = 'section fav-top-sec';

    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = '<span class="sec-icon">⭐</span>' +
      '<span class="sec-name">常用收藏</span>' +
      '<span class="sec-count">' + list.length + '</span>';
    sec.appendChild(head);

    // 一条收藏都没有：区块是常驻的，空着会让人以为坏了 —— 给一句怎么收藏的说明
    if (list.length === 0) {
      head.innerHTML += '<span class="fav-hint">点任意卡片右上角的 ☆ 即可收藏</span>';
      const p = document.createElement('p');
      p.className = 'fav-top-empty';
      p.textContent = '还没有收藏的站点。把鼠标移到下面任意卡片的右上角，点一下 ☆，' +
        '它就会固定到这里，方便随时打开。';
      sec.appendChild(p);
      box.appendChild(sec);
      return;
    }

    const shown = list.slice(0, FAV_TOP_LIMIT);
    const rest = list.length - shown.length;
    if (rest > 0) {
      head.innerHTML += '<span class="fav-hint">仅显示前 ' + FAV_TOP_LIMIT + ' 个</span>';
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'fav-back fav-top-more';
      more.textContent = '查看全部 ' + list.length + ' 个 →';
      more.addEventListener('click', openFavoritesView);
      head.appendChild(more);
    } else {
      const hint = document.createElement('span');
      hint.className = 'fav-hint';
      hint.textContent = kw ? '已按搜索词筛选' : '点卡片右上角的 ☆ 可取消收藏';
      head.appendChild(hint);
    }

    const cards = document.createElement('div');
    cards.className = 'cards ' + cardClasses(s);
    cards.style.setProperty('--card-radius', (s.cardRadius != null ? s.cardRadius : 14) + 'px');
    shown.forEach((f) => cards.appendChild(buildCard(f)));
    sec.appendChild(cards);
    box.appendChild(sec);
  }

  /* 「查看全部」→ 走侧栏那条同样的路径，进完整收藏视图（可拖拽排序） */
  function openFavoritesView() {
    if (state.keyword) clearSearch();   // 带着搜索词进收藏视图会只剩筛过的几条，容易误以为丢了数据
    state.view = 'fav';
    setActive('__fav');
    renderFavorites();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
