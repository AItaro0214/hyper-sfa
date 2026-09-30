// 全 JS ファイルの構文チェック。ビルド工程が無いので、これがローカルでの最小の確認になる。
// 依存パッケージの解決はしない（import 先が無くても通る）。実行時の不整合はテストで見る。
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:');
const SKIP = new Set(['node_modules', '.git', '.wrangler', '.assets', 'dist', 'build', '.terraform']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(name))) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`NG ${f}\n${r.stderr}`);
  }
}
console.log(`${files.length} files checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
