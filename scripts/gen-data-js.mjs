/* 由 data/sites.json 生成 data/sites.js
 *
 * 用途：以 file:// 直接打开 index.html 时，浏览器会拦截 fetch()（报 Failed to fetch），
 * 前端会退回用 <script> 标签读取本文件——脚本标签不受 file:// 限制。
 * server.js 每次保存数据时会自动同步，本脚本供手动补生成 / 部署前刷新。
 *
 * 运行：node scripts/gen-data-js.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sites.json'), 'utf8'));

const out =
  '/* 自动生成，请勿手工修改：由 data/sites.json 同步而来。\n' +
  ' * 供以 file:// 方式直接打开 index.html 时兜底读取（该协议下 fetch 会被浏览器拦截）。\n' +
  ' */\n' +
  'window.__NAV_DATA__ = ' + JSON.stringify(data) + ';\n';

fs.writeFileSync(path.join(ROOT, 'data', 'sites.js'), out, 'utf8');
console.log('已生成 data/sites.js：' + (data.categories || []).length + ' 个分类 / ' +
  (data.categories || []).reduce((a, c) => a + (c.links || []).length, 0) + ' 条链接');
