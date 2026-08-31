#!/usr/bin/env node
/*
 * version.js — 自动拨号静态资源版本号，用于破浏览器缓存。
 *
 * 用法：
 *   node scripts/version.js
 *
 * 作用：
 *   读取 index.html / admin.html，把所有 `?v=数字` 替换为「构建时间戳 YYYYMMDDHHmm」。
 *   通常在 Cloudflare Pages 的 Build command 中执行，每次部署都自动生成新版本号，无需人工手改。
 *   带时分可让「同一天多次部署」也破缓存 —— 纯日期戳在同一天不变，
 *   会导致当天第二版上线后浏览器仍吃旧 CSS/JS（真实踩过：改了样式却"没生效"）。
 *
 * 时区：使用运行环境本地时区（Cloudflare 构建环境为 UTC）。
 *       每日部署建议安排在 UTC 16:00（= 北京 0:00），此时 UTC 日期已翻到新的一天，
 *       版本号与「北京每日」对齐。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function buildStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

const stamp = buildStamp();
const root = path.resolve(__dirname, '..');
const targets = ['index.html', 'admin.html'];

let changed = 0;
for (const f of targets) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.log(`[version] 跳过（文件不存在）: ${f}`);
    continue;
  }
  const before = fs.readFileSync(p, 'utf8');
  // 替换 ?v= 后的数字串（兼容 8 位日期戳与 12 位时间戳）；保留 ?v= 前缀，不影响其它查询参数
  const after = before.replace(/\?v=\d+/g, '?v=' + stamp);
  if (after !== before) {
    fs.writeFileSync(p, after);
    changed++;
    console.log(`[version] ${f} -> ?v=${stamp}`);
  } else {
    console.log(`[version] ${f} 已是最新 ?v=${stamp}`);
  }
}
console.log(`[version] 完成，更新 ${changed} 个文件，版本号 ${stamp}`);
process.exit(0);
