/* 自动注入静态资源版本号（?v=）
 * 用途：Cloudflare Pages 在「Build command」里运行本脚本，把 index.html / admin.html 中
 *       静态资源引用的 ?v= 占位值替换为「当前 git commit 短哈希」（取不到时回退构建时间戳），
 *       使每次部署的 URL 都不同，浏览器自动拉取新文件，无需手动拨日期、也无需 Ctrl+F5 强刷。
 * 注意：本脚本只原地修改 html，不产生其它产物；Build output directory 仍为 "."。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = ['index.html', 'admin.html'];

function buildStamp() {
  // 优先 git commit 短哈希（语义化、每次提交必不同）
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim();
    if (hash) return hash;
  } catch (e) { /* 非 git 环境或无 .git，回退时间戳 */ }

  // 回退：构建时间戳 YYYYMMDDHHMMSS（每次部署必然不同）
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const stamp = buildStamp();
const re = /(\?v=)[A-Za-z0-9._-]+/g;
let changed = 0;

for (const f of FILES) {
  const fp = path.join(ROOT, f);
  if (!fs.existsSync(fp)) continue;
  const orig = fs.readFileSync(fp, 'utf8');
  const next = orig.replace(re, '$1' + stamp);
  if (next !== orig) {
    fs.writeFileSync(fp, next, 'utf8');
    changed++;
  }
}

console.log('[version] ?v= -> ' + stamp + '  (' + changed + ' file(s) updated)');
