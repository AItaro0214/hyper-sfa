// /api/auth/*（docs/cloudflare-small-design.md §3、docs/api-contract.md §3）。
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { ApiError, forbidden, rateLimited, unauthorized } from '../lib/errors.js';
import { clientIp, envNumber } from '../lib/http.js';
import { housekeeping } from '../lib/maintenance.js';
import {
  clearCookie,
  createSession,
  deleteSessionsOf,
  meResponse,
  sessionCookie,
  userFromRow,
} from '../lib/session.js';
import { addMinutes, nowIso } from '../lib/time.js';
import { audit } from '../lib/usage.js';
import { Check, readJson } from '../lib/validate.js';
import { ulid } from '../core.js';

export const LOGIN_ID_PATTERN = /^[^\s\u0000-\u001f]{3,64}$/;
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
const LOCK_FAILS = 5;
const LOCK_MINUTES = 15;
const IP_PER_MINUTE = 10;
const LOGIN_FAILED = 'ログイン ID またはパスワードが違います';

export const normalizeLoginId = (s) => String(s ?? '').trim().toLowerCase();

const iterationsOf = (env) => envNumber(env.PBKDF2_ITERATIONS, 30000);

export function hashNew(env, password) {
  return hashPassword(password, { pepper: env.AUTH_PEPPER, iterations: iterationsOf(env) });
}

async function recordAttempt(env, loginId, ip, ok) {
  await env.DB.prepare('INSERT INTO login_attempts (login_id, ip, at, ok) VALUES (?, ?, ?, ?)')
    .bind(loginId.slice(0, 64), ip, nowIso(), ok ? 1 : 0)
    .run();
}

// 同じ ID で 5 回続けて失敗したら 15 分ロック。同じ IP は 1 分 10 回まで。
// ロック中の試行は記録しない（記録するとロックが延び続け、正しい本人が入れなくなる）
async function assertNotLimited(env, loginId, ip) {
  const now = nowIso();
  const ipRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?')
    .bind(ip, addMinutes(now, -1))
    .first();
  if (ipRow.n >= IP_PER_MINUTE) throw rateLimited('試行が多すぎます。しばらく待ってからやり直してください');
  const { results } = await env.DB.prepare('SELECT ok, at FROM login_attempts WHERE login_id = ? ORDER BY id DESC LIMIT ?')
    .bind(loginId.slice(0, 64), LOCK_FAILS)
    .all();
  if (results.length === LOCK_FAILS && results.every((r) => !r.ok) && results[0].at > addMinutes(now, -LOCK_MINUTES)) {
    throw rateLimited(`ログインに続けて失敗したため、${LOCK_MINUTES} 分間ロックしています`);
  }
}

function checkPassword(check, value, field, label) {
  const v = typeof value === 'string' ? value : '';
  if (v.length < MIN_PASSWORD) check.fail(field, `${label}は${MIN_PASSWORD}文字以上にしてください`);
  if (v.length > MAX_PASSWORD) check.fail(field, `${label}は${MAX_PASSWORD}文字以内にしてください`);
  return v;
}

async function startSession(c, userRow) {
  const { sid, maxAgeSec } = await createSession(c.env, userRow.id, c.req.header('User-Agent'));
  c.header('Set-Cookie', sessionCookie(c.req.raw, sid, maxAgeSec));
}

export function authRoutes(app) {
  // 最初の管理者。利用者が 1 人でもいれば 403。INSERT ... WHERE NOT EXISTS で同時実行にも耐える
  app.post('/api/auth/setup', async (c) => {
    const body = await readJson(c);
    const check = new Check();
    const loginId = normalizeLoginId(check.str(body.loginId, 'loginId', { required: true, label: 'ログイン ID' }));
    if (loginId && !LOGIN_ID_PATTERN.test(loginId)) check.fail('loginId', 'ログイン ID は 3〜64 文字で、空白を含めないでください');
    const password = checkPassword(check, body.password, 'password', 'パスワード');
    const displayName = check.str(body.displayName, 'displayName', { max: 100, label: '表示名' }) || loginId;
    check.done();

    const h = await hashNew(c.env, password);
    const id = ulid();
    const res = await c.env.DB.prepare(
      `INSERT INTO users (id, login_id, password_hash, salt, iterations, role, status, display_name, must_change_password, created_at, last_login_at)
       SELECT ?, ?, ?, ?, ?, 'admin', 'active', ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
      .bind(id, loginId, h.hash, h.salt, h.iterations, displayName, nowIso(), nowIso())
      .run();
    if (!res.meta.changes) throw forbidden('最初の管理者はすでに作られています');
    await audit(c.env, id, 'setup', { loginId });
    await startSession(c, { id });
    return c.json(meResponse({ id, loginId, displayName, role: 'admin', mustChangePassword: false }), 201);
  });

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c);
    const loginId = normalizeLoginId(body.loginId);
    const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD) : '';
    if (!loginId || !password) throw unauthorized(LOGIN_FAILED);
    const ip = clientIp(c.req.raw.headers);
    await assertNotLimited(c.env, loginId, ip);

    const row = await c.env.DB.prepare('SELECT * FROM users WHERE login_id = ?').bind(loginId).first();
    // 存在しない ID でも同じ計算をして、応答時間から ID の有無が分からないようにする
    const ok = row
      ? await verifyPassword(password, row, c.env.AUTH_PEPPER)
      : (await hashNew(c.env, password), false);
    if (!ok || row.status !== 'active') {
      await recordAttempt(c.env, loginId, ip, false);
      await audit(c.env, row?.id ?? null, 'login.denied', { loginId: loginId.slice(0, 64), ip });
      throw unauthorized(LOGIN_FAILED);
    }
    await recordAttempt(c.env, loginId, ip, true);
    await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
    await startSession(c, row);
    c.executionCtx.waitUntil(housekeeping(c.env).catch(() => {}));
    return c.json(meResponse(userFromRow(row)));
  });

  app.post('/api/auth/logout', async (c) => {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(c.get('sessionHash')).run();
    c.header('Set-Cookie', clearCookie(c.req.raw));
    return c.json({ ok: true });
  });

  // 自分のセッションを全部消す（この端末も含む）
  app.post('/api/auth/logout-all', async (c) => {
    await deleteSessionsOf(c.env, c.get('user').id);
    c.header('Set-Cookie', clearCookie(c.req.raw));
    return c.json({ ok: true });
  });

  app.post('/api/auth/change-password', async (c) => {
    const user = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const current = typeof body.currentPassword === 'string' ? body.currentPassword.slice(0, MAX_PASSWORD) : '';
    const next = checkPassword(check, body.newPassword, 'newPassword', '新しいパスワード');
    if (next && next === current) check.fail('newPassword', '今のパスワードと同じにはできません');
    check.done();

    // 現在のパスワードの総当たりを防ぐため、ログインと同じ数え方で制限する
    const ip = clientIp(c.req.raw.headers);
    await assertNotLimited(c.env, user.loginId, ip);
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    if (!(await verifyPassword(current, row, c.env.AUTH_PEPPER))) {
      await recordAttempt(c.env, user.loginId, ip, false);
      throw new ApiError(400, 'validation', '今のパスワードが違います', {
        details: [{ field: 'currentPassword', message: '今のパスワードが違います' }],
      });
    }
    const h = await hashNew(c.env, next);
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, iterations = ?, must_change_password = 0 WHERE id = ?')
      .bind(h.hash, h.salt, h.iterations, user.id)
      .run();
    await deleteSessionsOf(c.env, user.id, c.get('sessionHash'));
    await audit(c.env, user.id, 'password.change', {});
    return c.json(meResponse({ ...user, mustChangePassword: false }));
  });
}
