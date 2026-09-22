/* 共享导航 - 内置站点图标库（光伏 / 新能源主题）
 *
 * 前台顶栏左上角那个图标（#siteLogo）与后台「站点信息 → 站点图标」选择器共用这里。
 *
 * 数据格式：site.logo 是一个普通字符串，支持三种写法（互相兼容、老数据不用迁移）：
 *   1. 内置图标 id，形如 'pv:panel'  → 渲染内联 SVG（矢量，任意字号都清晰）
 *   2. emoji 或任意短文字，如 '🌐'    → 直接显示文字（默认值就是 🌐）
 *   3. 图片地址（http(s):// 、data:image/ 、/ 或 ./ 开头）→ 渲染 <img>
 *
 * 之所以用 'pv:' 前缀而不是裸 id：老数据里 logo 就等于 emoji（例如 '🌐'），
 * 前缀能把「内置 id」和「用户随手填的文字」彻底区分开，不会误判。
 *
 * 对外只暴露 window.NAV_LOGOS：
 *   .DEFAULT           默认值（'🌐'）
 *   .PREFIX            内置 id 前缀（'pv:'）
 *   .list              [{ id, name, svg }]，后台选择器按这个顺序渲染
 *   .get(id)           取单个图标定义，没有则返回 null
 *   .markup(value)     把任意 logo 值转成可直接 innerHTML 的 HTML 片段（已转义）
 */
(() => {
  'use strict';

  const PREFIX = 'pv:';
  const DEFAULT_LOGO = '🌐';

  /* 所有图标统一 24×24 viewBox、不带 width/height（尺寸交给 CSS，跟随字号缩放）。
     尺寸细节：主体尽量占满 2~22 的范围内，保证缩到 20px 左右仍然看得清。 */
  const LIST = [
    {
      id: PREFIX + 'panel',
      name: '光伏板',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="18.4" cy="5.6" r="2.4" fill="#F5A623"/>
  <g stroke="#F5A623" stroke-width="1.3" stroke-linecap="round">
    <path d="M18.4 1.8v1.4M18.4 8v1.4M14.4 5.6h1.4M21 5.6h1.4"/>
  </g>
  <path d="M4 10.4h10.4l2.8 5.8H1.2z" fill="#2F6FED"/>
  <path d="M7.5 10.4 6.5 16.2M10.9 10.4l1 5.8M2.6 13.3h13.2"
        stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
</svg>`
    },
    {
      id: PREFIX + 'sun',
      name: '太阳',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="4.6" fill="#F5A623"/>
  <g stroke="#F5A623" stroke-width="1.7" stroke-linecap="round">
    <path d="M12 1.6v2.6M12 19.8v2.6M1.6 12h2.6M19.8 12h2.6"/>
  </g>
  <g stroke="#FBC15E" stroke-width="1.4" stroke-linecap="round">
    <path d="M5.3 5.3 7 7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7"/>
  </g>
</svg>`
    },
    {
      id: PREFIX + 'array',
      name: '光伏阵列',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M3.6 9.6h5l-1.2 6h-5z" fill="#2F6FED"/>
  <path d="M10.4 9.6h5l-1.2 6h-5z" fill="#4C9AFF"/>
  <path d="M17.2 9.6h5l-1.2 6h-5z" fill="#2F6FED"/>
</svg>`
    },
    {
      id: PREFIX + 'house',
      name: '户用光伏',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="20.8" cy="4.6" r="2" fill="#F5A623"/>
  <path d="M5.4 12.6h13.2v7.2H5.4z" fill="#E8EDF7"/>
  <path d="M5.4 12.6v7.2h13.2v-7.2" fill="none" stroke="#8896AB"
        stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M12 4.6 21.8 12.6H2.2z" fill="#2F6FED"/>
  <path d="M12 4.6v8M7.1 8.6h9.8M9.6 6.6v6M14.4 6.6v6"
        stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
</svg>`
    },
    {
      id: PREFIX + 'storage',
      name: '光储一体',
      /* 光伏板刻意做到与右侧电池**等高**（y 7.6~15.8）并带网格：
         第一版把板画得太小（只有电池的一半高），缩到 22px 时看着就是个小蓝块。 */
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M0.8 7.6h6.2l0.8 8.2H0z" fill="#2F6FED"/>
  <path d="M3.9 7.6v8.2M0.4 11.7h7" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
  <rect x="16.6" y="6" width="2.6" height="1.8" rx=".6" fill="#1AA179"/>
  <rect x="13.2" y="7.6" width="9.4" height="8.2" rx="1.8" fill="#1AA179"/>
  <path d="M18.4 9.4l-2.8 3.8h2.2l-1 2.4 3.2-3.6h-2.2z" fill="#fff"/>
</svg>`
    },
    {
      id: PREFIX + 'grid',
      name: '光伏并网',
      /* 铁塔必须**上窄下宽**（两条斜线从塔顶一点向下张开）才像塔；
         第一版把两个端点写反了，成了上宽下窄，看着像个 ¥ 符号。
         横担刻意画得比塔身宽（向外伸出），这才是输电塔的样子。 */
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M0.6 8.6h6l0.8 6.2H0z" fill="#2F6FED"/>
  <path d="M3.6 8.6v6.2M0.3 11.7h6.7" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
  <g stroke="#1E4FA8" stroke-width="1.5" stroke-linecap="round" fill="none">
    <path d="M17.4 4.6 14.6 20.4M17.4 4.6 20.2 20.4"/>
    <path d="M15.2 8.6h4.4M14.5 12.4h5.8M13.8 16.2h7.2"/>
  </g>
</svg>`
    },
    {
      id: PREFIX + 'inverter',
      name: '逆变电站',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="4.2" width="18" height="15.6" rx="2.4" fill="#2F6FED"/>
  <rect x="5.8" y="6.8" width="12.4" height="5.8" rx="1.2" fill="#9DC0FA"/>
  <path d="M6.4 17.9c1.5-2.7 2.8-2.7 4.3 0s2.8 2.7 4.3 0" fill="none"
        stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="17.8" cy="17.9" r="1.2" fill="#7CF0C0"/>
</svg>`
    },
    {
      id: PREFIX + 'leaf',
      name: '绿色能源',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M0.6 10.4h6.4l0.7 6.2H0z" fill="#2F6FED"/>
  <path d="M3.8 10.4v6.2M0.3 13.5h7" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
  <path d="M20.8 3.8c0 7.2-3.6 10.9-8.3 10.9-1.9 0-3.3-.7-4.2-1.8C8.7 6.2 12.4 3.3 20.8 3.8z" fill="#1AA179"/>
  <path d="M9 13.2c1.5-3.1 3.9-5.3 7-6.6" stroke="#fff"
        stroke-opacity=".55" stroke-width="1" fill="none" stroke-linecap="round"/>
</svg>`
    },
    {
      id: PREFIX + 'bolt',
      name: '光伏闪电',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M0.6 8.4h6l0.8 6.4H0z" fill="#2F6FED"/>
  <path d="M3.6 8.4v6.4M0.3 11.6h6.6" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>
  <path d="M17.4 3.6 11 12.6h4.3L13.8 20l6.6-9.2h-4.2z" fill="#F5A623"/>
</svg>`
    },
    {
      id: PREFIX + 'monitor',
      name: '运维监控',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="3.6" width="20" height="13.4" rx="2.2" fill="#1E4FA8"/>
  <rect x="4.2" y="5.8" width="15.6" height="9" rx="1.2" fill="#4C9AFF"/>
  <path d="M6.4 12.4l2.8-3.2 2.4 2.4 3.2-4.4" fill="none" stroke="#fff"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="14.8" cy="7.2" r="1.2" fill="#fff"/>
  <path d="M12 17v2.8M8.4 20.4h7.2" stroke="#1E4FA8" stroke-width="1.6" stroke-linecap="round"/>
</svg>`
    },
    {
      id: PREFIX + 'crystal',
      name: '晶硅电池片',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2.2 20.6 7.1v9.8L12 21.8 3.4 16.9V7.1z" fill="#2F6FED"/>
  <path d="M12 2.2v19.6M3.4 7.1l17.2 9.8M20.6 7.1 3.4 16.9"
        stroke="#fff" stroke-opacity=".45" stroke-width="1"/>
</svg>`
    },
    {
      id: PREFIX + 'meter',
      name: '计量电表',
      svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <circle cx="12" cy="12" r="9.2" fill="#2F6FED"/>
  <circle cx="12" cy="12" r="7" fill="#9DC0FA"/>
  <path d="M12 5.6v1.6M18.4 12h-1.6M5.6 12H7.2" stroke="#fff"
        stroke-opacity=".7" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M12 12.2 16.6 8.6" stroke="#1E4FA8" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="12" cy="12.2" r="1.4" fill="#1E4FA8"/>
</svg>`
    }
  ];

  const MAP = {};
  LIST.forEach((x) => { MAP[x.id] = x; });

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  /* 判断是不是图片地址。刻意保守：只认 http(s):// 、协议相对 // 、
     data:image/ 和以 / ./ ../ 开头的站内路径 —— 别把 '🌐' 或 '面板' 当路径。 */
  function isImage(v) {
    return /^(https?:)?\/\//i.test(v) || /^data:image\//i.test(v) || /^\.{0,2}\//.test(v);
  }

  function textMarkup(v) {
    return '<span class="logo-text">' + esc(v) + '</span>';
  }

  function markup(value) {
    const v = (value == null ? '' : String(value)).trim();
    if (!v) return textMarkup(DEFAULT_LOGO);
    const hit = MAP[v];
    if (hit) return hit.svg;
    if (isImage(v)) return '<img src="' + esc(v) + '" alt="" />';
    return textMarkup(v);
  }

  window.NAV_LOGOS = {
    DEFAULT: DEFAULT_LOGO,
    PREFIX: PREFIX,
    list: LIST,
    get: (id) => MAP[id] || null,
    isBuiltin: (v) => !!MAP[String(v || '').trim()],
    isImage: isImage,
    markup: markup
  };
})();
