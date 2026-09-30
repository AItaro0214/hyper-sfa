// セッション（docs/cloudflare-small-design.md §3.3）。Cookie には 256 ビットの乱数、D1 にはその SHA-256 だけを置く。
// D1 が漏れても Cookie の値は分からない。
import { capabilitiesFor } from '../core.js';
import { randomHex, sha256Hex } from './crypto.js';
import { envNumber, isSecureRequest, parseCookies, serializeSessionCookie } from './http.js';
import { addDays, nowIso } from './time.js';

const SID_PATTERN = /^[0-9a-f]{64}$/;
const DAY_MS = 86400000;

export function sessionDays(env) {
  return {
    days: envNumber(env.SESSION_DAYS, 30),
    absoluteDays: envNumber(env.SESSION_ABSOLUTE_DAYS, 90),
  };
}

export async function createSession(env, userId, userAgent) {
  const sid = randomHex(32);
  const now = nowIso();
  const { days, absoluteDays } = sessionDays(env);
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, device)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(sid), userId, now, now, addDays(now, days), addDays(now, absoluteDays), String(userAgent ?? '').slice(0, 120))
    .run();
  return { sid, maxAgeSec: days * 86400 };
}

export function sessionCookie(request, sid, maxAgeSec) {
  return serializeSessionCookie(sid, { maxAgeSec, secure: isSecureRequest(request.url) });
}

export const clearCookie = (request) => sessionCookie(request, '', 0);

export async function deleteSessionsOf(env, userId, exceptHash = null) {
  if (exceptHash) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').bind(userId, exceptHash).run();
  } else {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  }
}

/**
 * ミドルウェア: Cookie が有効なら c.set('user', ...) する。無効なら何もしない（401 は次の関門が決める）。
 * user: { id, loginId, displayName, role, mustChangePassword }。c.get('sessionHash') は現在のセッション。
 */
export async function sessionMiddleware(c, next) {
  const sid = parseCookies(c.req.header('Cookie')).sid;
  if (sid && SID_PATTERN.test(sid)) {
    const hash = await sha256Hex(sid);
    const row = await c.env.DB.prepare(
      `SELECT s.last_seen_at, s.expires_at, s.absolute_expires_at,
              u.id, u.login_id, u.display_name, u.role, u.status, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
      .bind(hash)
      .first();
    const now = nowIso();
    if (row && row.status === 'active' && row.expires_at > now && row.absolute_expires_at > now) {
      const user = userFromRow(row);
      // 議事録側などが c.get('user').capabilities.dev を見る
      user.capabilities = capabilitiesOf(user);
      c.set('user', user);
      c.set('sessionHash', hash);
      // 使えば延びる。ただし毎回は書かない（D1 の書き込みを減らす）。絶対期限は超えない
      if (Date.now() - new Date(row.last_seen_at).getTime() >= DAY_MS) {
        const { days } = sessionDays(c.env);
        const wanted = addDays(now, days);
        const expires = wanted < row.absolute_expires_at ? wanted : row.absolute_expires_at;
        await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').bind(now, expires, hash).run();
        const maxAgeSec = Math.floor((new Date(expires).getTime() - Date.now()) / 1000);
        c.header('Set-Cookie', sessionCookie(c.req.raw, sid, maxAgeSec));
      }
    }
  }
  await next();
}

const LEVEL = { admin: 'dev', member: 'org_edit' };

export function levelOf(user) {
  return LEVEL[user.role] ?? 'org_edit';
}

export function capabilitiesOf(user) {
  const caps = { ...capabilitiesFor(levelOf(user)) };
  // 部署の仕組みが無いので、member は他の部署に見せる操作を持たない（api-contract §2）。
  // 削除は cloudflare-small-design §4 のとおり全員ができる（サーバー側の判定と一致させる）
  if (user.role === 'member') {
    caps.assignOtherDepts = false;
    caps.deleteAnyCard = true;
  }
  return caps;
}

// /api/me と同じ形。ログイン / セットアップの応答にも使う
export function meResponse(user) {
  const loginId = user.loginId;
  return {
    id: user.id,
    email: loginId.includes('@') ? loginId : '',
    loginId,
    displayName: user.displayName,
    position: '',
    level: levelOf(user),
    deptIds: [],
    departments: [],
    mustChangePassword: Boolean(user.mustChangePassword),
    capabilities: capabilitiesOf(user),
  };
}

export const userFromRow = (r) => ({
  id: r.id,
  loginId: r.login_id,
  displayName: r.display_name || r.login_id,
  role: r.role,
  mustChangePassword: Boolean(r.must_change_password),
});
