// 画面（web/）と共通ロジック（packages/core/src）を .assets/ にまとめる。
// なぜ: wrangler の [assets] は 1 ディレクトリしか指せないが、画面は
// `import ... from '/core/index.js'` で共通ロジックを同じオリジンから読む約束になっている。
// .assets/ は毎回作り直す（古いファイルが残って配られるのを防ぐ）。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, '..', '.assets');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const web = join(root, 'web');
if (existsSync(web)) {
  cpSync(web, out, { recursive: true });
} else {
  console.warn('web/ がありません。空の配信ディレクトリを作りました');
}

const core = join(root, 'packages', 'core', 'src');
if (existsSync(core)) {
  cpSync(core, join(out, 'core'), { recursive: true });
} else {
  console.warn('packages/core/src がありません。/core/* は配られません');
}

console.log(`assets ready: ${out}`);
