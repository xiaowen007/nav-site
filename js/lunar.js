/* 内置农历 / 节气 / 节日计算（零依赖，浏览器端运行）
 * - 农历数据表 lunarInfo 覆盖 1900-2100（标准公开数据）
 * - 节气用寿星公式近似（21 世纪误差极小）
 * 暴露 window.NavLunar.info(Date) -> { lunar, jieqi, festival, greet }
 */
(function () {
  'use strict';

  var lunarInfo = [
    0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
    0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
    0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
    0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
    0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
    0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
    0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
    0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,
    0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
    0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
    0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
    0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
    0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
    0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
    0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
    0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
    0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
    0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
    0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
    0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
    0x0d520
  ];

  var sTermInfo = [0,21208,42467,63836,85337,107014,128867,150921,173149,195551,218072,240693,263343,285989,308563,331033,353350,375494,397447,419210,440795,462224,483532,504758];
  var nStr1 = ['日', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  var jieqiNames = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'];

  function getLeapMonth(l) { return l & 0xf; }
  function getLeapDays(l) { return getLeapMonth(l) ? ((l & 0x10000) ? 30 : 29) : 0; }
  function monthDays(l, m) { return ((l & (0x10000 >> m)) ? 30 : 29); }
  function getLunarYearDays(l) {
    var s = 348;
    for (var i = 0x8000; i > 0x8; i >>= 1) s += (l & i) ? 1 : 0;
    return s + getLeapDays(l);
  }

  function toLunar(date) {
    var i, temp = 0;
    var baseDate = new Date(1900, 0, 31);
    var offset = Math.round((date.getTime() - baseDate.getTime()) / 86400000);
    for (i = 0; i < lunarInfo.length; i++) {
      temp = getLunarYearDays(lunarInfo[i]);
      if (offset < temp) break;
      offset -= temp;
    }
    var lunarYear = 1900 + i;
    var leap = getLeapMonth(lunarInfo[i]);
    var isLeap = false;
    var j;
    for (j = 1; j <= 12; j++) {
      if (leap > 0 && j === (leap + 1) && !isLeap) {
        // 该农历年有闰月：先扣掉闰月天数（落在闰月则标记 isLeap 并结束）
        temp = getLeapDays(lunarInfo[i]);
        if (offset < temp) { isLeap = true; break; }
        offset -= temp;
        isLeap = false;
      }
      temp = monthDays(lunarInfo[i], j);
      if (offset < temp) break;
      offset -= temp;
    }
    return { year: lunarYear, month: isLeap ? leap : j, day: offset + 1, isLeap: isLeap };
  }

  function cnMonth(m) {
    if (m === 1) return '正月';
    if (m === 11) return '冬月';
    if (m === 12) return '腊月';
    if (m === 10) return '十月';
    return nStr1[m] + '月';
  }
  function cnDay(dd) {
    if (dd === 10) return '初十';
    if (dd === 20) return '二十';
    if (dd === 30) return '三十';
    var s = dd < 10 ? '初' : (dd < 20 ? '十' : '廿');
    return s + nStr1[dd % 10 === 0 ? 10 : dd % 10];
  }
  function lunarText(L) {
    return (L.isLeap ? '闰' : '') + cnMonth(L.month) + cnDay(L.day);
  }

  function getTerm(y, n) {
    var offDate = new Date((31556925974.7 * (y - 1900) + sTermInfo[n] * 60000) + Date.UTC(1900, 0, 6, 2, 5));
    return offDate.getUTCDate();
  }
  function getJieqi(date) {
    var y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    for (var n = 0; n < 24; n++) {
      if (Math.floor(n / 2) + 1 === m) {
        if (getTerm(y, n) === d) return jieqiNames[n];
      }
    }
    return '';
  }

  var SOLAR_FESTIVAL = {
    '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节',
    '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节',
    '8-1': '建军节', '9-10': '教师节', '10-1': '国庆节', '12-24': '平安夜', '12-25': '圣诞节'
  };
  var LUNAR_FESTIVAL = {
    '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节',
    '7-7': '七夕', '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节', '12-23': '小年'
  };
  function getFestival(date, L) {
    var sk = (date.getMonth() + 1) + '-' + date.getDate();
    if (SOLAR_FESTIVAL[sk]) return SOLAR_FESTIVAL[sk];
    var lk = L.month + '-' + L.day;
    if (LUNAR_FESTIVAL[lk]) return LUNAR_FESTIVAL[lk];
    return '';
  }
  function greetOf(date, festival, jieqi) {
    if (festival) return festival + '快乐 🎉';
    if (jieqi) return '今日' + jieqi;
    var h = date.getHours();
    if (h < 6) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 13) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  window.NavLunar = {
    info: function (date) {
      date = date || new Date();
      var L = toLunar(date);
      var jieqi = getJieqi(date);
      var festival = getFestival(date, L);
      return {
        lunar: lunarText(L),
        jieqi: jieqi,
        festival: festival,
        greet: greetOf(date, festival, jieqi)
      };
    }
  };
})();
