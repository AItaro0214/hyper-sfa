// /api/admin/*（管理者）。利用者の管理と履歴。部署と CSV 取り込みは持たない（features で画面が隠す）。
import { generateTempPassword } from '../lib/crypto.js';
import { conflict, notFound, validation } from '../lib/errors.js';
import { clampLimit } from '../lib/search.js';
import { deleteSessionsOf } from '../lib/session.js';
import { jstDayStart, jstMonthStart, jstNextDayStart, jstNextMonthStart, nowIso, safeJson } from '../lib/time.js';
import { audit } from '../lib/usage.js';
import { Check, readJson } from '../lib/validate.js';
import { ulid } from '../core.js';
import { LOGIN_ID_PATTERN, hashNew, normalizeLoginId } from './auth.js';

function userItem(u) {
  return {
    id: u.id,
    email: u.login_id.includes('@') ? u.login_id : '',
    loginId: u.login_id,
    displayName: u.display_name || u.login_id,
    position: '',
    role: u.role,
    deptIds: [],
    departments: [],
    // 仮パスワードのまま一度もログインしていなければ「招待中」
    status: u.status === 'disabled' ? 'disabled' : u.last_login_at ? 'active' : 'invited',
    lastLoginAt: u.last_login_at,
  };
}

const activeAdminsExcept = (id) =>
  ["SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active' AND id != ?", id];

export function historyItem(r) {
  return {
    id: r.id,
    type: r.type,
    at: r.at,
    actor: { id: r.actor_id, name: r.actor_name, deptName: '' },
    source: r.source,
    card: { id: r.card_id, company: r.company ?? '', name: r.name ?? '' },
    changes: safeJson(r.changes, []),
  };
}

export function adminRoutes(app) {
  app.get('/api/admin/users', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT * FROM users ORDER BY created_at').all();
    return c.json({ items: results.map(userItem) });
  });

  app.post('/api/admin/users', async (c) => {
    const actor = c.get('user');
    const body = await readJson(c);
    const check = new Check();
    const loginId = normalizeLoginId(check.str(body.loginId, 'loginId', { required: true, label: 'ログイン ID' }));
    if (loginId && !LOGIN_ID_PATTERN.test(loginId)) check.fail('loginId', 'ログイン ID は 3〜64 文字で、空白を含めないでください');
    const displayName = check.str(body.displayName, 'displayName', { max: 100, label: '表示名' }) || loginId;
    const role = check.oneOf(body.role ?? 'member', ['admin', 'member'], 'role', '権限');
    check.done();

    const exists = await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE login_id = ?').bind(loginId).first();
    if (exists) throw conflict('このログイン ID はすでに使われています');
    const tempPassword = generateTempPassword(12);
    const h = await hashNew(c.env, tempPassword);
    const id = ulid();
    await c.env.DB.prepare(
      `INSERT INTO users (id, login_id, password_hash, salt, iterations, role, status, display_name, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 1, ?)`,
    )
      .bind(id, loginId, h.hash, h.salt, h.iterations, role, displayName, nowIso())
      .run();
    await audit(c.env, actor.id, 'user.create', { userId: id, loginId, role });
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    // 仮パスワードはこの応答でしか見られない
    return c.json({ ...userItem(row), tempPassword }, 201);
  });

  app.patch('/api/admin/users/:id', async (c) => {
    const actor = c.get('user');
    const id = c.req.param('id');
    const body = await readJson(c);
    const target = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) throw notFound('利用者が見つかりません');

    const check = new Check();
    const role = body.role === undefined ? target.role : check.oneOf(body.role, ['admin', 'member'], 'role', '権限');
    const status = body.status === undefined ? target.status : check.oneOf(body.status, ['active', 'disabled'], 'status', '状態');
    const displayName =
      body.displayName === undefined ? target.display_name : check.str(body.displayName, 'displayName', { required: true, max: 100, label: '表示名' });
    check.done();

    const losesAdmin = target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active');
    if (losesAdmin && id === actor.id) throw conflict('自分自身の権限や状態は変更できません。ほかの管理者に頼んでください');

    // 最後の 1 人の管理者を守る。確認と更新を 1 つの文にして、同時に 2 人を外す競合も防ぐ
    const [countSql, countId] = activeAdminsExcept(id);
    const res = await c.env.DB.prepare(
      `UPDATE users SET role = ?, status = ?, display_name = ? WHERE id = ? AND (? = 0 OR (${countSql}) > 0)`,
    )
      .bind(role, status, displayName, id, losesAdmin ? 1 : 0, countId)
      .run();
    if (!res.meta.changes) throw conflict('最後の 1 人の管理者は、無効にしたり権限を変えたりできません');

    if (status === 'disabled') await deleteSessionsOf(c.env, id);
    const changed = {};
    if (role !== target.role) changed.role = role;
    if (status !== target.status) changed.status = status;
    if (displayName !== target.display_name) changed.displayName = true;
    await audit(c.env, actor.id, 'user.update', { userId: id, ...changed });
    const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return c.json(userItem(row));
  });

  app.post('/api/admin/users/:id/temp-password', async (c) => {
    const actor = c.get('user');
    const id = c.req.param('id');
    const target = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) throw notFound('利用者が見つかりません');
    const tempPassword = generateTempPassword(12);
    const h = await hashNew(c.env, tempPassword);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, iterations = ?, must_change_password = 1 WHERE id = ?').bind(h.hash, h.salt, h.iterations, id),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      // ロック中の人にも再発行で入れるようにする
      c.env.DB.prepare('DELETE FROM login_attempts WHERE login_id = ?').bind(target.login_id),
    ]);
    await audit(c.env, actor.id, 'user.temp_password', { userId: id });
    return c.json({ tempPassword });
  });

  // 部署と CSV 取り込みは Cloudflare 版に無い
  app.all('/api/admin/departments', () => {
    throw notFound();
  });
  app.all('/api/admin/departments/*', () => {
    throw notFound();
  });
  app.all('/api/admin/users/import', () => {
    throw notFound();
  });
  app.all('/api/admin/users/import/*', () => {
    throw notFound();
  });

  // ---- 履歴 ----
  app.get('/api/admin/history', async (c) => {
    const q = c.req.query();
    const where = ['1 = 1'];
    const params = [];
    if (['create', 'edit', 'rescan', 'delete', 'restore'].includes(q.type)) {
      where.push('h.type = ?');
      params.push(q.type);
    }
    const from = q.from ? jstDayStart(q.from) : null;
    const to = q.to ? jstNextDayStart(q.to) : null;
    if (from) (where.push('h.at >= ?'), params.push(from));
    if (to) (where.push('h.at < ?'), params.push(to));
    if (q.actor) (where.push('h.actor_id = ?'), params.push(q.actor));
    if (q.cursor) (where.push('h.id < ?'), params.push(q.cursor));
    const limit = clampLimit(q.limit);
    const { results } = await c.env.DB.prepare(
      `SELECT h.*, c.company, c.name FROM card_history h LEFT JOIN cards c ON c.id = h.card_id
       WHERE ${where.join(' AND ')} ORDER BY h.id DESC LIMIT ?`,
    )
      .bind(...params, limit + 1)
      .all();
    const page = results.slice(0, limit);
    return c.json({ items: page.map(historyItem), nextCursor: results.length > limit ? page[page.length - 1].id : null });
  });

  // 人ごとの登録枚数。from / to は年月（YYYY-MM）。既定は今月
  app.get('/api/admin/history/summary', async (c) => {
    const q = c.req.query();
    const thisMonth = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
    const from = jstMonthStart(q.from || thisMonth);
    const to = jstNextMonthStart(q.to || q.from || thisMonth);
    if (!from || !to) throw validation([{ field: 'from', message: '年月は YYYY-MM の形で指定してください' }]);
    const { results } = await c.env.DB.prepare(
      `SELECT actor_id AS id, MAX(actor_name) AS name, COUNT(*) AS count FROM card_history
       WHERE type = 'create' AND at >= ? AND at < ? GROUP BY actor_id ORDER BY count DESC`,
    )
      .bind(from, to)
      .all();
    return c.json({ byUser: results.map((r) => ({ id: r.id, name: r.name, deptName: '', count: r.count })), byDept: [] });
  });

  app.get('/api/admin/cards/:id/history', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT h.*, c.company, c.name FROM card_history h LEFT JOIN cards c ON c.id = h.card_id
       WHERE h.card_id = ? ORDER BY h.id`,
    )
      .bind(c.req.param('id'))
      .all();
    return c.json({ items: results.map(historyItem) });
  });
}
