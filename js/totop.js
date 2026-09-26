/*
 * totop.js — 右下角「返回顶部」浮动圆钮。主页（index.html）与后台（admin.html）共用。
 *
 * 为什么一个脚本能管两页：
 *   两页的**纵向滚动容器都是 window** —— .topbar 是 sticky 吸顶，
 *   .layout（主页）/ .admin（后台）都是普通流，没有被做成 height:100vh + overflow:auto 的
 *   内部滚动容器。侧栏（.sidebar / .studio-side）确实各自有 overflow 滚动条，
 *   但那只改变侧栏自身的滚动位置，不影响页面纵向位置。
 *   所以判据统一用 window.scrollY，不需要按页面写分支。
 *
 * 不写「登录后才显示」这类判断的原因：
 *   后台登录前 #adminMain 是 display:none、登录遮罩是 position:fixed，
 *   页面根本没有纵向可滚动空间，scrollY 恒为 0，按钮自己就不会浮现。
 *   按钮的 DOM 也放在 #adminMain 内部，未登录时它压根不存在。
 *
 * 与 CSS 的分工：
 *   本脚本只负责「何时加 .on 类」和「点击后滚回顶部」；
 *   长什么样（毛玻璃、圆角、淡入淡出）全在 css/style.css 的 .to-top。
 */
(function () {
  'use strict';

  /* 滚过约 2/3 屏才出现。设太小的话，随便滚一下按钮就闪出来，很吵。 */
  var SHOW_AT = 400;

  function init() {
    var btn = document.getElementById('toTop');
    if (!btn) return;   // 该页没有这个按钮（例如被裁掉的旧页面），静默跳过

    /* 系统「减弱动态效果」：回顶不做平滑滚动。CSS 那边同步去掉位移与缩放。 */
    var reduce = false;
    try {
      reduce = !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {}

    function currentY() {
      return window.pageYOffset || document.documentElement.scrollTop ||
        document.body.scrollTop || 0;
    }

    var ticking = false;
    function sync() {
      ticking = false;
      var y = currentY();
      /* 只读 scrollY、只写一个 class，开销很小；但仍用 rAF 合并，
         避免高速滚动时每个 scroll 事件都触发一次样式计算。 */
      btn.classList.toggle('on', y > SHOW_AT);
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      if (window.requestAnimationFrame) window.requestAnimationFrame(sync);
      else sync();
    }

    function toTop() {
      /* 左侧分类栏自己有滚动条（分类多时被撑高）。一并归零，
         否则会出现「页面已经到顶了、分类栏还停在中间」的割裂感。 */
      var side = document.getElementById('sidebar');
      if (side && side.scrollTop) side.scrollTop = 0;

      try {
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      } catch (e) {
        window.scrollTo(0, 0);   // 老浏览器不认 options 对象，退回两参数写法
      }
      /* 这里不手动调 sync()：平滑滚动是异步的，此刻 scrollY 还没变小，
         调了也只会维持 .on。滚动过程中由 scroll 事件自然把它收起来。 */
    }

    btn.addEventListener('click', toTop);
    window.addEventListener('scroll', onScroll, { passive: true });

    /* 带锚点进入 / 刷新时停在页面中段，首屏状态要立刻正确 */
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();   // 脚本被延迟加载时 DOM 可能已经就绪
  }
})();
