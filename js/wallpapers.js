/* 预置壁纸库
 * ------------------------------------------------------------------
 * 「磨砂透明类优先」：主力是纯 CSS 的多层柔光渐变 —— 零体积、不依赖外链、
 * 永不失效，而且天然就是低饱和弥散的效果，叠上站内的模糊 / 遮罩滑块就是
 * 标准的毛玻璃背景；旁边再各放几款「磨砂玻璃」（渐变 + SVG 噪点颗粒，
 * 做出真实磨砂的细颗粒感）与本地化缓存的风景图。
 *
 * 每项字段：
 *   id      唯一标识（前缀区分来源，避免与用户自定义值混淆）
 *   name    后台里显示的名字
 *   kind    'css' | 'img'
 *   value   写入 site.wallpaperValue 的字符串
 *           css → 直接是 CSS 背景值（可多层，逗号分隔）
 *           img → 资源路径（本地 assets/wallpapers/ 下的文件）
 *   thumb   仅 img 用：后台网格显示的小图（不填就退回 value）。
 *           导航主题那 20 张主图是 2560x1440、单张 300KB+，
 *           后台一屏 20 格全加载原图会明显卡顿，所以另出一份 480x270 小图。
 *   type    写入 site.wallpaperType（css 走 'gradient'，img 走 'image'）
 *   opacity 推荐遮罩透明度（磨砂感的关键，比站点默认 0.08 重）
 *   blur    推荐模糊半径 px
 *   dark    是否偏深（后台用来给文字反色，纯展示用途）
 *
 * 用法与 js/logos.js 一致：后台只负责往 #setWallpaperValue 写值，
 * 剩下的即时预览 / 脏标记 / 保存全部走壁纸面板既有的那条链路，不另开旁路。
 */
(function () {
  'use strict';

  /* 磨砂玻璃的细颗粒：用 SVG feTurbulence 现场生成噪点，
     以 data-uri 形式当一层背景叠在渐变之上。
     注意：外层用单引号包 data-uri，内部的 SVG 属性才能安全地用双引号；
     # 必须写成 %23，否则会被当成 CSS 的 id 选择器截断。 */
  function noiseLayer(alpha) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">' +
      '<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch"/>' +
      '<feColorMatrix type="saturate" values="0"/></filter>' +
      '<rect width="140" height="140" filter="url(%23g)" opacity="' + alpha + '"/>' +
      '</svg>';
    return "url('data:image/svg+xml;utf8," + svg + "')";
  }

  var N_LIGHT = noiseLayer(0.16);
  var N_DARK = noiseLayer(0.26);

  /* 柔光斑渐变：几个不同色相的 radial-gradient 各自弥散 + 一层同色系
     斜向线性渐变打底。就是「磨砂玻璃后面透出来的光」那种感觉。 */
  var list = [
    /* ---------- 导航主题（20 张高清图，成套设计）----------
       来源：全网抓取的高清原图（Unsplash，见 assets/wallpapers/CREDITS.json），
       再用同一套设计语言重制：磨砂柔化底 + 细颗粒 + 经纬网 + 虚线路线 +
       玻璃卡里的主图标 + 图标簇（地图定位标记 / 地址标签 / 链接符号 / 指南针 /
       路线 / 地球经纬 / 搜索 / 应用方格 / 导航箭头 / 分享节点 …）。
       20 张共用图标语言与网格，只有版式与配色轮换，所以是一整套而不是 20 张散图。
       thumb 是后台网格用的小图（480x270，约 10KB），不加载 2.5K 原图，后台才不卡。 */
    { id: 'wp:nav-01', name: '白绢微光', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-01.jpg', thumb: 'assets/wallpapers/nav-01.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-02', name: '晨雾远山', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-02.jpg', thumb: 'assets/wallpapers/nav-02.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-03', name: '玻璃几何', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-03.jpg', thumb: 'assets/wallpapers/nav-03.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-04', name: '蓝玻璃', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-04.jpg', thumb: 'assets/wallpapers/nav-04.t.jpg',
      opacity: 0.2, blur: 0 },
    { id: 'wp:nav-05', name: '蓝紫流体', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-05.jpg', thumb: 'assets/wallpapers/nav-05.t.jpg',
      opacity: 0.2, blur: 0 },
    { id: 'wp:nav-06', name: '靛蓝波纹', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-06.jpg', thumb: 'assets/wallpapers/nav-06.t.jpg',
      opacity: 0.2, blur: 0 },
    { id: 'wp:nav-07', name: '紫晶方块', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-07.jpg', thumb: 'assets/wallpapers/nav-07.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-08', name: '柔光球体', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-08.jpg', thumb: 'assets/wallpapers/nav-08.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-09', name: '虹波', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-09.jpg', thumb: 'assets/wallpapers/nav-09.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-10', name: '彩浪', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-10.jpg', thumb: 'assets/wallpapers/nav-10.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-11', name: '霞光渐变', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-11.jpg', thumb: 'assets/wallpapers/nav-11.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-12', name: '紫蓝暮色', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-12.jpg', thumb: 'assets/wallpapers/nav-12.t.jpg',
      opacity: 0.2, blur: 0 },
    { id: 'wp:nav-13', name: '暖霞云', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-13.jpg', thumb: 'assets/wallpapers/nav-13.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-14', name: '粉彩云', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-14.jpg', thumb: 'assets/wallpapers/nav-14.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-15', name: '粉绿撞色', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-15.jpg', thumb: 'assets/wallpapers/nav-15.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-16', name: '桃粉光晕', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-16.jpg', thumb: 'assets/wallpapers/nav-16.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-17', name: '粉蓝云石', kind: 'img', group: 'nav',
      value: 'assets/wallpapers/nav-17.jpg', thumb: 'assets/wallpapers/nav-17.t.jpg',
      opacity: 0.14, blur: 0 },
    { id: 'wp:nav-18', name: '玄黑织物', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-18.jpg', thumb: 'assets/wallpapers/nav-18.t.jpg',
      opacity: 0.2, blur: 0 },
    { id: 'wp:nav-19', name: '洋红暗流', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-19.jpg', thumb: 'assets/wallpapers/nav-19.t.jpg',
      opacity: 0.2, blur: 0 },
    { id: 'wp:nav-20', name: '暗夜窗光', kind: 'img', group: 'nav', dark: true,
      value: 'assets/wallpapers/nav-20.jpg', thumb: 'assets/wallpapers/nav-20.t.jpg',
      opacity: 0.2, blur: 0 },

    /* ---------- 磨砂玻璃（渐变 + 噪点颗粒）：最贴近「磨砂透明」----------
       配色经验：第一版用了 #dbeafe / #ede9fe 这类**极浅色**做光斑，
       再叠上 0.34 的白色遮罩，主页上几乎就是一片纯白 ——
       截图一对比才发现「设了跟没设一样」。现在光斑统一提到中等饱和度
       （参考「柔光弥散」组里表现最好的那几款），遮罩也相应降到 0.24~0.3。 */
    { id: 'wp:frost-white', name: '磨砂白玻璃', kind: 'css', group: 'frost',
      value: N_LIGHT + ', radial-gradient(at 18% 22%, #bcd9ff 0%, transparent 58%), ' +
             'radial-gradient(at 82% 16%, #d9cdff 0%, transparent 52%), ' +
             'radial-gradient(at 68% 88%, #b8f0e6 0%, transparent 56%), ' +
             'linear-gradient(135deg, #eef4ff, #e6eefb)',
      opacity: 0.26, blur: 12 },
    { id: 'wp:frost-mist', name: '磨砂雾灰', kind: 'css', group: 'frost',
      value: N_LIGHT + ', radial-gradient(at 25% 30%, #a8bccf 0%, transparent 60%), ' +
             'radial-gradient(at 78% 72%, #cbd7e4 0%, transparent 55%), ' +
             'linear-gradient(160deg, #e9eef5, #dae3ee)',
      opacity: 0.3, blur: 16 },
    { id: 'wp:frost-cyan', name: '磨砂青玻璃', kind: 'css', group: 'frost',
      value: N_LIGHT + ', radial-gradient(at 22% 20%, #7fe3f0 0%, transparent 55%), ' +
             'radial-gradient(at 80% 26%, #9cc7ff 0%, transparent 50%), ' +
             'radial-gradient(at 60% 90%, #7fe0c8 0%, transparent 58%), ' +
             'linear-gradient(140deg, #e6fbfd, #dcefff)',
      opacity: 0.24, blur: 14 },
    { id: 'wp:frost-rose', name: '磨砂玫瑰玻璃', kind: 'css', group: 'frost',
      value: N_LIGHT + ', radial-gradient(at 24% 24%, #ffbcc7 0%, transparent 56%), ' +
             'radial-gradient(at 76% 22%, #ffc2dd 0%, transparent 52%), ' +
             'radial-gradient(at 66% 86%, #ffcfa0 0%, transparent 56%), ' +
             'linear-gradient(150deg, #fff0f2, #ffe9f3)',
      opacity: 0.26, blur: 14 },
    { id: 'wp:frost-night', name: '磨砂暗玻璃', kind: 'css', group: 'frost', dark: true,
      value: N_DARK + ', radial-gradient(at 20% 24%, #1e3a8a 0%, transparent 58%), ' +
             'radial-gradient(at 80% 20%, #312e81 0%, transparent 54%), ' +
             'radial-gradient(at 64% 88%, #0f766e 0%, transparent 56%), ' +
             'linear-gradient(140deg, #0f172a, #111827)',
      opacity: 0.3, blur: 16 },
    { id: 'wp:frost-graphite', name: '磨砂石墨', kind: 'css', group: 'frost', dark: true,
      value: N_DARK + ', radial-gradient(at 28% 26%, #1f2937 0%, transparent 60%), ' +
             'radial-gradient(at 74% 76%, #374151 0%, transparent 55%), ' +
             'linear-gradient(160deg, #111827, #1f2937)',
      opacity: 0.36, blur: 18 },

    /* ---------- 柔光弥散（纯渐变，不叠噪点，最轻量）---------- */
    { id: 'wp:aurora', name: '极光', kind: 'css', group: 'soft',
      value: 'radial-gradient(at 18% 20%, #a5d8ff 0%, transparent 55%), ' +
             'radial-gradient(at 84% 18%, #d0bfff 0%, transparent 52%), ' +
             'radial-gradient(at 66% 86%, #96f2d7 0%, transparent 58%), ' +
             'linear-gradient(135deg, #f8faff, #eef4ff)',
      opacity: 0.26, blur: 10 },
    { id: 'wp:dawn', name: '晨曦', kind: 'css', group: 'soft',
      value: 'radial-gradient(at 16% 26%, #ffd8a8 0%, transparent 56%), ' +
             'radial-gradient(at 82% 20%, #ffc9c9 0%, transparent 52%), ' +
             'radial-gradient(at 62% 88%, #fff3bf 0%, transparent 58%), ' +
             'linear-gradient(150deg, #fffdf7, #fff5eb)',
      opacity: 0.24, blur: 10 },
    { id: 'wp:ocean', name: '海雾', kind: 'css', group: 'soft',
      value: 'radial-gradient(at 20% 18%, #99e9f2 0%, transparent 56%), ' +
             'radial-gradient(at 80% 28%, #a5d8ff 0%, transparent 52%), ' +
             'radial-gradient(at 58% 90%, #c5f6fa 0%, transparent 58%), ' +
             'linear-gradient(140deg, #f7feff, #eaf8fb)',
      opacity: 0.22, blur: 12 },
    { id: 'wp:lavender', name: '薰衣草', kind: 'css', group: 'soft',
      value: 'radial-gradient(at 22% 22%, #d0bfff 0%, transparent 56%), ' +
             'radial-gradient(at 78% 24%, #b197fc 0%, transparent 50%), ' +
             'radial-gradient(at 66% 88%, #eebefa 0%, transparent 56%), ' +
             'linear-gradient(145deg, #fbf9ff, #f3efff)',
      opacity: 0.24, blur: 12 },
    { id: 'wp:mint', name: '薄荷', kind: 'css', group: 'soft',
      value: 'radial-gradient(at 24% 20%, #b2f2bb 0%, transparent 56%), ' +
             'radial-gradient(at 80% 26%, #96f2d7 0%, transparent 52%), ' +
             'radial-gradient(at 60% 88%, #d8f5a2 0%, transparent 56%), ' +
             'linear-gradient(140deg, #f8fff9, #eefaf1)',
      opacity: 0.22, blur: 10 },
    { id: 'wp:sand', name: '暖沙', kind: 'css', group: 'soft',
      value: 'radial-gradient(at 20% 24%, #ffe8cc 0%, transparent 56%), ' +
             'radial-gradient(at 78% 22%, #ffec99 0%, transparent 52%), ' +
             'radial-gradient(at 64% 88%, #ffd8a8 0%, transparent 56%), ' +
             'linear-gradient(150deg, #fffdf8, #fdf6ec)',
      opacity: 0.22, blur: 10 },
    { id: 'wp:slate', name: '墨色', kind: 'css', group: 'soft', dark: true,
      value: 'radial-gradient(at 20% 22%, #334155 0%, transparent 58%), ' +
             'radial-gradient(at 80% 24%, #1e293b 0%, transparent 54%), ' +
             'radial-gradient(at 62% 88%, #3f3f46 0%, transparent 56%), ' +
             'linear-gradient(145deg, #0f172a, #1e293b)',
      opacity: 0.3, blur: 14 },
    { id: 'wp:midnight', name: '午夜蓝', kind: 'css', group: 'soft', dark: true,
      value: 'radial-gradient(at 22% 20%, #1e40af 0%, transparent 58%), ' +
             'radial-gradient(at 78% 26%, #4c1d95 0%, transparent 54%), ' +
             'radial-gradient(at 60% 90%, #155e75 0%, transparent 56%), ' +
             'linear-gradient(150deg, #0b1220, #131c33)',
      opacity: 0.3, blur: 14 },

    /* ---------- 纯净单色（最省事，也最不抢卡片）---------- */
    { id: 'wp:plain-light', name: '净白', kind: 'css', group: 'plain',
      value: 'linear-gradient(180deg, #ffffff, #f7f9fc)', opacity: 0.18, blur: 0 },
    { id: 'wp:plain-warm', name: '暖白', kind: 'css', group: 'plain',
      value: 'linear-gradient(180deg, #fffdfa, #f7f2ea)', opacity: 0.18, blur: 0 },
    { id: 'wp:plain-cool', name: '冷白', kind: 'css', group: 'plain',
      value: 'linear-gradient(180deg, #fbfdff, #eef3f9)', opacity: 0.18, blur: 0 },
    { id: 'wp:plain-dark', name: '深灰', kind: 'css', group: 'plain', dark: true,
      value: 'linear-gradient(180deg, #1b2028, #141920)', opacity: 0.28, blur: 0 },

    /* ---------- 自然风景（本项目自带，不依赖外链）---------- */
    { id: 'wp:scene-1', name: '风景 01', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-1.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-2', name: '风景 02', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-2.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-3', name: '风景 03', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-3.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-4', name: '风景 04', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-4.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-5', name: '风景 05', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-5.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-6', name: '风景 06', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-6.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-7', name: '风景 07', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-7.jpg', opacity: 0.22, blur: 6 },
    { id: 'wp:scene-8', name: '风景 08', kind: 'img', group: 'scene',
      value: 'assets/wallpapers/scene-8.jpg', opacity: 0.22, blur: 6 }
  ];

  var groups = [
    { id: 'nav', name: '导航主题', hint: '20 张高清成套壁纸：磨砂透明底 + 定位标记/地址标签/链接等线条图标' },
    { id: 'frost', name: '磨砂玻璃', hint: '渐变 + 噪点颗粒，最接近真实磨砂质感' },
    { id: 'soft', name: '柔光弥散', hint: '纯渐变、零体积，最轻量' },
    { id: 'plain', name: '纯净单色', hint: '不抢卡片注意力' },
    { id: 'scene', name: '自然风景', hint: '随项目自带，不依赖外链' }
  ];

  var byValue = {};
  /* type 由 kind 推导，不手写：46 项手写一遍迟早写漏一个，
     而漏掉的那项会被前台当成 image 去包 url()，渐变就渲染不出来了。
     （后台点选时是拿 item.type 去写 wallpaperType 的，必须每项都有。） */
  list.forEach(function (it) {
    if (!it.type) it.type = it.kind === 'img' ? 'image' : 'gradient';
    byValue[it.value] = it;
  });

  window.NAV_WALLPAPERS = {
    list: list,
    groups: groups,
    /* 按壁纸值反查预置项：后台用它打「当前选中」的高亮。
       data-uri 那种超长值用全等匹配，图片路径再做一次「去掉前导 ./ 」的宽容匹配。 */
    find: function (value) {
      var v = String(value == null ? '' : value).trim();
      if (!v) return null;
      if (byValue[v]) return byValue[v];
      var stripped = v.replace(/^\.\//, '');
      for (var i = 0; i < list.length; i++) {
        if (list[i].value.replace(/^\.\//, '') === stripped) return list[i];
      }
      return null;
    }
  };
})();
