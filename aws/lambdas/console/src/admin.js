// 管理コンソール（/api/admin/*。docs/api-contract.md §5、docs/design.md §3.3、§9.3）。
import { levelFor, planUserImport, normalizeText, isValidEmail, ulid, MAX_IMPORT_ROWS } from '@hyper-sfa/core';
import {
  ddb, K, audit, loadPositions, invalidateUser, isConditionFailed,
  HttpError, notFound, forbidden, conflict, validation, readJson, parseLimit, encodeCursor, decodeCursor,
} from '@hyper-sfa/aws-shared';
import { me, isAdminLevel, listUserItems, emailOf, listDeptItems, countActive, mapPool, monthRange, presentHist, pageMonths } from './common.js';
import { disableCognitoUser, enableCognitoUser } from './cognito.js';

const nowIso = () => new Date().toISOString();

function presentUser(item, positions, deptMap) {
  const deptIds = Array.isArray(item.deptIds) ? item.deptIds : [];
  const email = emailOf(item);
  return {
    id: email,
    email,
    loginId: null,
    displayName: item.displayName || '',
    position: item.position,
    role: levelFor(item.position, positions),
    deptIds,
    departments: deptIds.filter((d) => deptMap.has(d)).map((d) => ({ id: d, name: deptMap.get(d).name })),
    // 保存する状態は active / disabled。画面の「未ログイン」は、ログインの記録が無い人
    status: item.status === 'disabled' ? 'disabled' : item.firstLoginAt ? 'active' : 'invited',
    lastLoginAt: item.lastLoginAt ?? null,
  };
}

/** 部署名から ID を引く。似た名前は normalizeText が一致するものだけ。 */
function deptIdByName(depts) {
  return new Map(depts.map((d) => [normalizeText(d.name), d.id]));
}

async function createDepartments(names, depts) {
  const byName = deptIdByName(depts);
  let order = depts.reduce((m, d) => Math.max(m, d.order), 0);
  const created = [];
  for (const name of names) {
    const key = normalizeText(name);
    if (byName.has(key)) continue;
    const id = ulid();
    order += 1;
    await ddb.put({ ...K.dept(id), name, order, active: true });
    byName.set(key, id);
    created.push({ id, name });
  }
  return { byName, created };
}

export function registerAdminRoutes(app) {
  app.get('/api/admin/users', async (c) => {
    const [items, positions, depts] = await Promise.all([listUserItems(), loadPositions(), listDeptItems()]);
    const deptMap = new Map(depts.map((d) => [d.id, d]));
    return c.json({ items: items.map((i) => presentUser(i, positions, deptMap)).sort((a, b) => a.email.localeCompare(b.email)) });
  });

  app.post('/api/admin/users', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const email = String(b.email ?? '').trim().toLowerCase();
    const errors = [];
    if (!isValidEmail(email)) errors.push({ field: 'email', message: 'メールアドレスの形式が正しくありません' });
    const hd = String(process.env.ALLOWED_HD ?? '').toLowerCase();
    if (hd && email.split('@')[1] !== hd) errors.push({ field: 'email', message: '会社のドメインではありません' });
    const positions = await loadPositions();
    const level = levelFor(b.position, positions);
    if (!level) errors.push({ field: 'position', message: '役職が一覧にありません' });
    else if (level === 'dev' && !actor.capabilities.dev) errors.push({ field: 'position', message: '「開発者」を付けられるのは開発者だけです' });
    const displayName = typeof b.displayName === 'string' ? b.displayName.trim().slice(0, 100) : '';
    const newNames = [...new Set((Array.isArray(b.newDepartments) ? b.newDepartments : []).map((n) => String(n ?? '').trim()).filter(Boolean))];
    if (newNames.some((n) => n.length > 50)) errors.push({ field: 'newDepartments', message: '部署名は 50 文字までです' });
    const depts = await listDeptItems();
    const ids = [...new Set(Array.isArray(b.deptIds) ? b.deptIds : [])];
    for (const id of ids) {
      const d = depts.find((x) => x.id === id);
      if (!d || !d.active) errors.push({ field: 'deptIds', message: '選べない部署が含まれています' });
    }
    if (ids.length + newNames.length === 0) errors.push({ field: 'deptIds', message: '部署を 1 つ以上選んでください' });
    if (errors.length) throw validation('入力を確かめてください', errors);

    // 部署の作成と登録を 1 回の操作で済ませる（§3.3）
    const { byName, created } = await createDepartments(newNames, depts);
    const deptIds = [...new Set([...ids, ...newNames.map((n) => byName.get(normalizeText(n)))])];
    const item = {
      ...K.user(email),
      email,
      displayName,
      position: positions.find((p) => normalizeText(p.name) === normalizeText(b.position)).name,
      deptIds,
      status: 'active',
      registeredBy: actor.id,
      registeredAt: nowIso(),
    };
    try {
      await ddb.put(item, { condition: 'attribute_not_exists(pk)' });
    } catch (e) {
      if (isConditionFailed(e)) throw conflict('すでに登録されているメールアドレスです');
      throw e;
    }
    await audit(actor, 'user.create', { target: email, position: item.position, departmentsCreated: created.length });
    const depts2 = await listDeptItems();
    return c.json(presentUser(item, positions, new Map(depts2.map((d) => [d.id, d]))), 201);
  });

  app.patch('/api/admin/users/:id', async (c) => {
    const actor = me(c);
    const email = decodeURIComponent(c.req.param('id')).trim().toLowerCase();
    const b = await readJson(c);
    const k = K.user(email);
    const item = await ddb.get(k.pk, k.sk);
    if (!item) throw notFound('ユーザーが見つかりません');
    const positions = await loadPositions();
    const curLevel = levelFor(item.position, positions);

    const errors = [];
    const set = {};
    let newPosition = item.position;
    if (b.position !== undefined) {
      const pos = positions.find((p) => normalizeText(p.name) === normalizeText(b.position));
      if (!pos) errors.push({ field: 'position', message: '役職が一覧にありません' });
      else newPosition = pos.name;
    }
    const newLevel = levelFor(newPosition, positions);
    if (b.status !== undefined && b.status !== 'active' && b.status !== 'disabled') errors.push({ field: 'status', message: 'active か disabled を指定してください' });
    if (b.displayName !== undefined && typeof b.displayName !== 'string') errors.push({ field: 'displayName', message: '文字列で指定してください' });
    let deptIds = item.deptIds ?? [];
    if (b.deptIds !== undefined) {
      const depts = await listDeptItems();
      deptIds = [...new Set(Array.isArray(b.deptIds) ? b.deptIds : [])];
      if (deptIds.length === 0) errors.push({ field: 'deptIds', message: '部署を 1 つ以上選んでください' });
      for (const id of deptIds) {
        const d = depts.find((x) => x.id === id);
        // 既に付いている部署は、使用停止になっていてもそのまま残せる
        if (!d || (!d.active && !(item.deptIds ?? []).includes(id))) errors.push({ field: 'deptIds', message: '選べない部署が含まれています' });
      }
    }
    if (errors.length) throw validation('入力を確かめてください', errors);

    // 「開発者」を付ける・外すのは開発者だけ。全社管理の人が自分を開発者にすることもできない（§9.3）
    if ((curLevel === 'dev' || newLevel === 'dev') && !actor.capabilities.dev) {
      if (newPosition !== item.position || (curLevel === 'dev' && b.status !== undefined)) {
        throw forbidden('「開発者」に関わる変更ができるのは開発者だけです');
      }
    }

    const newStatus = b.status ?? item.status;
    // 最後の 1 人の開発者と、最後の 1 人の管理コンソールに入れる人は、無効化も役職の変更もさせない
    const staysActive = newStatus === 'active';
    if (item.status === 'active') {
      if (curLevel === 'dev' && !(staysActive && newLevel === 'dev') && (await countActive((l) => l === 'dev', email)) === 0) {
        throw conflict('最後の 1 人の開発者は、無効にも役職の変更もできません');
      }
      if (isAdminLevel(curLevel) && !(staysActive && isAdminLevel(newLevel)) && (await countActive(isAdminLevel, email)) === 0) {
        throw conflict('管理コンソールに入れる最後の 1 人は、無効にも役職の変更もできません');
      }
    }

    if (newPosition !== item.position) set.position = newPosition;
    if (b.deptIds !== undefined) set.deptIds = deptIds;
    if (b.displayName !== undefined) set.displayName = b.displayName.trim().slice(0, 100);
    if (newStatus !== item.status) set.status = newStatus;
    if (Object.keys(set).length === 0) {
      const depts = await listDeptItems();
      return c.json(presentUser(item, positions, new Map(depts.map((d) => [d.id, d]))));
    }
    set.updatedAt = nowIso();
    const updated = await ddb.update(k.pk, k.sk, { set, condition: 'attribute_exists(pk)' });
    invalidateUser(email);

    // DynamoDB を先に変えるので、関門 3 は 1 分以内に効く。Cognito 側の取り消しが失敗したら、そのことを知らせる
    let cognitoFailed = false;
    if (set.status) {
      try {
        if (set.status === 'disabled') await disableCognitoUser(email);
        else await enableCognitoUser(email);
      } catch (e) {
        console.error('cognito update failed', e?.name);
        cognitoFailed = true;
      }
    }
    const changed = Object.keys(set).filter((f) => f !== 'updatedAt');
    await audit(actor, 'user.update', {
      target: email,
      changed,
      ...(set.position ? { positionFrom: item.position, positionTo: set.position } : {}),
      ...(set.status ? { status: set.status } : {}),
    });
    if (cognitoFailed) {
      throw new HttpError(502, 'provider_error', '状態は変更しましたが、ログインの取り消しに失敗しました。もう一度お試しください');
    }
    const depts = await listDeptItems();
    return c.json(presentUser(updated, positions, new Map(depts.map((d) => [d.id, d]))));
  });

  // ---- CSV の一括登録 ----

  async function buildPlan(actor, rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw validation('取り込む行がありません');
    if (rows.length > MAX_IMPORT_ROWS) throw validation(`1 回に取り込めるのは ${MAX_IMPORT_ROWS} 行までです`);
    const [items, positions, depts] = await Promise.all([listUserItems(), loadPositions(), listDeptItems()]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const existingUsers = items.map((i) => ({
      email: emailOf(i),
      displayName: i.displayName || '',
      position: i.position,
      departments: (i.deptIds ?? []).map((d) => deptName.get(d)).filter(Boolean),
    }));
    const plan = planUserImport({
      rows,
      existingUsers,
      departments: depts,
      positions,
      companyDomain: process.env.ALLOWED_HD,
      actorIsDev: actor.capabilities.dev,
    });
    return { plan, items, positions, depts };
  }

  app.post('/api/admin/users/import/preview', async (c) => {
    const b = await readJson(c);
    const { plan } = await buildPlan(me(c), b.rows);
    // 何も保存しない
    return c.json(plan);
  });

  app.post('/api/admin/users/import', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    // 画面の確認の後でもう一度検証する（確認から実行の間に状態が変わることがある）
    const { plan, items, positions, depts } = await buildPlan(actor, b.rows);
    if (plan.errors.some((e) => e.row === 0)) throw validation(plan.errors[0].message);
    if (plan.errors.length > 0 && b.skipErrors !== true) {
      throw validation('エラーの行があります。確認してからもう一度お試しください', plan.errors.map((e) => ({ field: `row ${e.row}`, message: e.message })));
    }

    // 開発者を外す変更は開発者だけ。最後の 1 人の開発者・管理者も守る
    const posOf = new Map(items.map((i) => [emailOf(i), i]));
    const after = new Map(items.map((i) => [emailOf(i), { status: i.status, level: levelFor(i.position, positions) }]));
    for (const u of plan.update) {
      const cur = posOf.get(u.after.email);
      const curLevel = levelFor(cur.position, positions);
      const newLevel = levelFor(u.after.position, positions);
      if (curLevel === 'dev' && newLevel !== 'dev' && !actor.capabilities.dev) throw forbidden('「開発者」を外せるのは開発者だけです');
      after.set(u.after.email, { status: cur.status, level: newLevel });
    }
    for (const u of plan.create) after.set(u.email, { status: 'active', level: levelFor(u.position, positions) });
    const remaining = [...after.values()].filter((x) => x.status === 'active');
    if (!remaining.some((x) => x.level === 'dev')) throw conflict('開発者が 1 人もいなくなる変更はできません');
    if (!remaining.some((x) => isAdminLevel(x.level))) throw conflict('管理コンソールに入れる人が 1 人もいなくなる変更はできません');

    const { byName, created } = await createDepartments(plan.newDepartments.map((d) => d.name), depts);
    const idsOf = (u) => [...new Set((u.departments ?? []).map((n) => byName.get(normalizeText(n))).filter(Boolean))];
    const canonicalPos = (name) => positions.find((p) => normalizeText(p.name) === normalizeText(name))?.name ?? name;
    const at = nowIso();

    await mapPool(plan.create, 25, async (u) => {
      try {
        await ddb.put({
          ...K.user(u.email), email: u.email, displayName: u.displayName || '', position: canonicalPos(u.position),
          deptIds: idsOf(u), status: 'active', registeredBy: actor.id, registeredAt: at,
        }, { condition: 'attribute_not_exists(pk)' });
      } catch (e) {
        if (!isConditionFailed(e)) throw e; // 確認の後で誰かが先に登録した人は、そのままにする
      }
    });
    await mapPool(plan.update, 25, async (u) => {
      const k = K.user(u.after.email);
      const set = { position: canonicalPos(u.after.position), deptIds: idsOf(u.after), updatedAt: at };
      if (u.after.displayName) set.displayName = u.after.displayName;
      await ddb.update(k.pk, k.sk, { set });
      invalidateUser(u.after.email);
    });

    const result = { created: plan.create.length, updated: plan.update.length, departmentsCreated: created.length };
    await audit(actor, 'user.import', { ...result, departments: created.map((d) => d.name) });
    return c.json(result);
  });

  // ---- 部署 ----

  app.get('/api/admin/departments', async (c) => c.json({ items: await listDeptItems() }));

  app.post('/api/admin/departments', async (c) => {
    const actor = me(c);
    const b = await readJson(c);
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 50) throw validation('部署名は 1〜50 文字で入力してください', [{ field: 'name', message: '1〜50 文字' }]);
    const depts = await listDeptItems();
    if (depts.some((d) => normalizeText(d.name) === normalizeText(name))) throw conflict('同じ名前の部署がすでにあります');
    const id = ulid();
    const order = Number.isFinite(b.order) ? Math.trunc(b.order) : depts.reduce((m, d) => Math.max(m, d.order), 0) + 1;
    const item = { ...K.dept(id), name, order, active: b.active !== false };
    await ddb.put(item);
    await audit(actor, 'department.create', { departmentId: id });
    return c.json({ id, name, order, active: item.active }, 201);
  });

  app.patch('/api/admin/departments/:id', async (c) => {
    const actor = me(c);
    const id = c.req.param('id');
    const b = await readJson(c);
    const k = K.dept(id);
    const cur = await ddb.get(k.pk, k.sk);
    if (!cur) throw notFound('部署が見つかりません');
    const set = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name || name.length > 50) throw validation('部署名は 1〜50 文字で入力してください', [{ field: 'name', message: '1〜50 文字' }]);
      const depts = await listDeptItems();
      if (depts.some((d) => d.id !== id && normalizeText(d.name) === normalizeText(name))) throw conflict('同じ名前の部署がすでにあります');
      set.name = name;
    }
    if (b.order !== undefined) {
      if (!Number.isFinite(b.order)) throw validation('order は数で指定してください');
      set.order = Math.trunc(b.order);
    }
    if (b.active !== undefined) set.active = b.active === true;
    if (Object.keys(set).length === 0) return c.json({ id, name: cur.name, order: cur.order ?? 0, active: cur.active !== false });
    const updated = await ddb.update(k.pk, k.sk, { set });
    await audit(actor, 'department.update', { departmentId: id, changed: Object.keys(set) });
    return c.json({ id, name: updated.name, order: updated.order ?? 0, active: updated.active !== false });
  });

  // ---- 履歴 ----

  app.get('/api/admin/history', async (c) => {
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const jstStart = (s) => (/^\d{4}-\d{2}-\d{2}/.test(s ?? '') ? new Date(`${s.slice(0, 10)}T00:00:00+09:00`) : null);
    const fromAt = jstStart(q.from)?.toISOString() ?? null;
    const toDay = jstStart(q.to);
    const toAt = toDay ? new Date(toDay.getTime() + 86400000).toISOString() : null;
    const actorId = q.actor ? String(q.actor).toLowerCase() : null;
    const r = await pageMonths({
      months: monthRange(q.from, q.to),
      cursor: decodeCursor(q.cursor),
      limit,
      // 月ごとに新しい順で読む
      page: (month, startKey) => ddb.query({ pk: `HIST#${month}`, index: 'gsi2', forward: false, limit: 100, startKey }),
      keep: (h) =>
        (!q.type || h.type === q.type) &&
        (!actorId || h.actorUserId === actorId) &&
        (!q.dept || (h.actorDeptIds ?? []).includes(q.dept)) &&
        (!fromAt || h.at >= fromAt) &&
        (!toAt || h.at < toAt),
      map: presentHist,
      keyOf: (h) => ({ pk: h.pk, sk: h.sk, gsi2pk: h.gsi2pk, gsi2sk: h.gsi2sk }),
    });
    return c.json({ items: r.items, nextCursor: r.cursor ? encodeCursor(r.cursor) : null });
  });

  app.get('/api/admin/history/summary', async (c) => {
    const q = c.req.query();
    const months = monthRange(q.from, q.to, 1);
    const [users, depts] = await Promise.all([listUserItems(), listDeptItems()]);
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));
    const userMap = new Map(users.map((u) => [emailOf(u), u]));
    const byUser = new Map();
    const byDept = new Map();
    for (const month of months) {
      const items = await ddb.queryAll({ pk: `HIST#${month}`, index: 'gsi2' });
      for (const h of items) {
        if (h.type !== 'create') continue; // 登録枚数
        const uid = h.actorUserId;
        const u = byUser.get(uid) ?? { id: uid, name: h.actorName || userMap.get(uid)?.displayName || uid, deptName: h.actorDeptName ?? '', count: 0 };
        u.count += 1;
        byUser.set(uid, u);
        for (const d of h.actorDeptIds ?? []) {
          const e = byDept.get(d) ?? { id: d, name: deptMap.get(d) ?? d, count: 0 };
          e.count += 1;
          byDept.set(d, e);
        }
      }
    }
    return c.json({
      byUser: [...byUser.values()].sort((a, b) => b.count - a.count),
      byDept: [...byDept.values()].sort((a, b) => b.count - a.count),
    });
  });

  app.get('/api/admin/cards/:id/history', async (c) => {
    const id = c.req.param('id');
    const k = K.card(id);
    const items = await ddb.queryAll({ pk: k.pk, skPrefix: 'HIST#', forward: false });
    if (items.length === 0 && !(await ddb.get(k.pk, k.sk))) throw notFound('名刺が見つかりません');
    return c.json({ items: items.map(presentHist), nextCursor: null });
  });
}
