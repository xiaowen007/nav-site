#!/usr/bin/env node
/*
 * version.js — 自动拨号静态资源版本号，用于破浏览器缓存。
 *
 * 用法：
 *   node scripts/version.js
 *
 * 作用：
 *   读取 index.html / admin.html，把所有 `?v=YYYYMMDD` 替换为「当天日期戳」。
 *   通常在 Cloudflare Pages 的 Build command 中执行，每次部署都自动生成新版本号，
 *   无需人工手改。脚本幂等：当天已是最新时不会改动文件。
 *
 * 时区：使用运行环境本地时区（Cloudflare 构建环境为 UTC）。
 *       每日部署建议安排在 UTC 16:00（= 北京 0:00），此时 UTC 日期已翻到新的一天，
 *       版本号与「北京每日」对齐。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

const stamp = todayStamp();
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
  // 仅替换 ?v= 后的 6~8 位数字日期戳；保留 ?v= 前缀，不影响其它查询参数
  const after = before.replace(/\?v=\d{6,8}/g, '?v=' + stamp);
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
