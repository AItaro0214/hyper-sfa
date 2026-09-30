// Lambda を 1 ファイルに束ねる。aws/lambdas/*/src/index.js → aws/lambdas/*/build/index.mjs
// Terraform は build/ を zip にして配備する。@hyper-sfa/core と @hyper-sfa/aws-shared も束ねるので、
// zip に node_modules は要らない（配備物が小さくなり、起動も速い）。
// 使い方: リポジトリのルートで `npm install` の後に `node aws/scripts/build.mjs [lambda 名...]`
import { readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const lambdasDir = fileURLToPath(new URL('../lambdas/', import.meta.url));
// shared はライブラリで、単独では配備しない
const SKIP = new Set(['shared']);

const only = process.argv.slice(2);
const names = readdirSync(lambdasDir)
  .filter((n) => !SKIP.has(n) && statSync(join(lambdasDir, n)).isDirectory())
  .filter((n) => existsSync(join(lambdasDir, n, 'src', 'index.js')))
  .filter((n) => only.length === 0 || only.includes(n));

if (names.length === 0) {
  console.error('ビルドする Lambda が見つかりません');
  process.exit(1);
}

for (const name of names) {
  const outdir = join(lambdasDir, name, 'build');
  rmSync(outdir, { recursive: true, force: true });
  await build({
    entryPoints: [join(lambdasDir, name, 'src', 'index.js')],
    outfile: join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // 束ねた CommonJS の依存が require() を呼んでも動くようにする（ESM 出力で require が無いため）
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    // ソースマップは付けない。スタックトレースに名刺の内容は入らないが、配備物を小さく保つ
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    logLevel: 'info',
  });
  console.log(`built ${name}`);
}
