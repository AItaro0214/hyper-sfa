// 管理者が自分のパスワードを忘れたときの復旧用（docs/cloudflare-small-design.md §3.1）。
// 仮パスワードを作り、D1 に流す SQL を表示する。画面からは戻せないので、wrangler で実行する。
//
//   AUTH_PEPPER=<本番と同じ値> node scripts/reset-password.mjs <ログインID> [繰り返し回数]
//   → 表示された SQL を  npx wrangler d1 execute hyper-sfa --remote --command "<SQL>"  で実行する
//   （ローカルなら --remote を --local に）
import { generateTempPassword, hashPassword } from '../worker/src/lib/crypto.js';

const loginId = (process.argv[2] ?? '').trim().toLowerCase();
const iterations = Number(process.argv[3] ?? 30000);
const pepper = process.env.AUTH_PEPPER;
if (!loginId || !pepper) {
  console.error('使い方: AUTH_PEPPER=... node scripts/reset-password.mjs <ログインID> [繰り返し回数]');
  process.exit(1);
}

const temp = generateTempPassword(12);
const h = await hashPassword(temp, { pepper, iterations });
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
console.log(`仮パスワード（初回ログインで変更を求められます）: ${temp}\n`);
console.log(
  `UPDATE users SET password_hash = ${q(h.hash)}, salt = ${q(h.salt)}, iterations = ${h.iterations}, must_change_password = 1 WHERE login_id = ${q(loginId)}; ` +
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE login_id = ${q(loginId)}); ` +
    `DELETE FROM login_attempts WHERE login_id = ${q(loginId)};`,
);
