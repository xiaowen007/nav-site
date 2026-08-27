// 把本地 data/sites.json 生成为 functions/_seed.js（KV 为空时的种子数据）
// 用法：npm run seed
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const data = JSON.parse(readFileSync(join(root, 'data/sites.json'), 'utf8'));
const out =
  '// 自动生成：KV 为空时的种子数据（来自 data/sites.json）\n' +
  '// 由 scripts/gen-seed.mjs 生成，请勿手动编辑\n' +
  'export const SEED = ' + JSON.stringify(data, null, 2) + ';\n';
writeFileSync(join(root, 'functions/_seed.js'), out);
console.log('functions/_seed.js 已更新（' + out.length + ' 字节）');
