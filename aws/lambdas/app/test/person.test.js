// 同じ人の名刺（design §5.5b）。DynamoDB と S3 は共有の関数を差し替える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { capabilitiesFor, searchKeys, classifyMatch } from '@hyper-sfa/core';
import { ddb, s3, errorHandler } from '@hyper-sfa/aws-shared';
import { shardOf } from '@hyper-sfa/aws-shared/keys.js';
import { createSearchIndex } from '../src/search.js';
import { registerCardRoutes } from '../src/cards.js';

const T0 = '2026-09-01T00:00:00.000Z';
const card = (id, o = {}) => {
  const c = {
    id, status: 'confirmed', company: '株式会社アシスト', department: '営業部', title: '課長', name: `名前${id}`,
    phones: [], mobiles: [], emails: [], deptIds: ['d1'], createdBy: 'a@example.jp', createdAt: T0, updatedAt: T0, version: 1, editCount: 0, ...o,
  };
  return { pk: `CARD#${id}`, sk: 'META', gsi1pk: `IDX#${shardOf(id)}`, gsi1sk: `${c.updatedAt}#${id}`, keys: searchKeys(c), ...c };
};
// 過去の名刺は gsi1 のキーを持ったまま、status が superseded
const past = (c) => {
  c.status = 'superseded';
  return c;
};

function setup(cards, { level = 'dept_edit' } = {}) {
  const store = new Map();
  const key = (pk, sk) => `${pk}|${sk}`;
  for (const c of cards) store.set(key(c.pk, c.sk), c);
  const txs = [];
  ddb.get = async (pk, sk) => store.get(key(pk, sk)) ?? null;
  ddb.batchGet = async (keys) => keys.map((k) => store.get(key(k.pk, k.sk))).filter(Boolean);
  ddb.put = async (it) => { store.set(key(it.pk, it.sk), it); };
  ddb.queryAll = async ({ pk, index, skPrefix, skGte }) => {
    if (index === 'gsi1') return [...store.values()].filter((i) => i.gsi1pk === pk && (!skGte || i.gsi1sk >= skGte));
    return [...store.values()].filter((i) => i.pk === pk && (!skPrefix || i.sk.startsWith(skPrefix)));
  };
  ddb.transact = async (ops) => {
    txs.push(ops);
    // 条件（version）を先に全部確かめてから書く
    for (const op of ops) {
      if (op.update && op.values?.[':ver'] !== undefined && store.get(key(op.update.pk, op.update.sk))?.version !== op.values[':ver']) {
        const err = new Error('cancel');
        err.name = 'TransactionCanceledException';
        err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }];
        throw err;
      }
    }
    for (const op of ops) {
      if (op.put) store.set(key(op.put.pk, op.put.sk), { ...op.put });
      else if (op.del) store.delete(key(op.del.pk, op.del.sk));
      else if (op.update) {
        const cur = { ...(store.get(key(op.update.pk, op.update.sk)) ?? {}) };
        Object.assign(cur, op.set);
        for (const [k, v] of Object.entries(op.add ?? {})) cur[k] = (cur[k] ?? 0) + v;
        for (const k of op.remove ?? []) delete cur[k];
        store.set(key(op.update.pk, op.update.sk), cur);
      }
    }
  };
  s3.presignGet = async ({ key: k }) => `https://s3.example/${k}`;
  const user = { id: 'a@example.jp', displayName: 'A', position: '', deptIds: ['d1'], capabilities: capabilitiesFor(level) };
  const index = createSearchIndex({ ddb });
  const app = new Hono();
  app.onError((e, c) => { if (process.env.DBG) console.error(e); return errorHandler(e, c); });
  app.use('*', async (c, next) => { c.set('auth', { user }); return next(); });
  registerCardRoutes(app, { index });
  const call = async (method, path, body) => {
    const res = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  return { store, txs, call, index };
}

const save = (item, o = {}) => ({
  company: item.company, department: item.department, title: item.title, name: item.name, nameReading: '',
  phones: [], mobiles: [], emails: item.emails, note: '', deptIds: item.deptIds, version: item.version, source: 'review', confirm: true, ...o,
});

test('引き表で候補を引く: 1,000 件あっても判定は数件で、全件を舐めない', async () => {
  const cards = [];
  for (let i = 0; i < 1000; i++) {
    cards.push(card(`C${String(i).padStart(4, '0')}`, { name: `人${i}`, emails: [`p${i}@example.jp`], mobiles: [`090-0000-${String(i).padStart(4, '0')}`] }));
  }
  setup(cards);
  let calls = 0;
  const idx = createSearchIndex({ ddb, classify: (a, b) => { calls++; return classifyMatch(a, b); } });
  await idx.ensureFresh();
  assert.equal(idx.size(), 1000);
  const user = { id: 'u', deptIds: ['d1'], capabilities: capabilitiesFor('dept_edit') };
  // メールだけ同じ（氏名は別）の新しい名刺
  const r = await idx.findMatches(user, { id: 'NEW', company: '別会社', name: '新人', emails: ['P7@example.jp'], phones: [], mobiles: [] });
  assert.deepEqual(r.map((m) => [m.id, m.kind, m.reason]), [['C0007', 'same_person', 'email']]);
  assert.ok(calls <= 3, `判定の回数 ${calls}`);
  // 何も当たらなければ判定は 0 回
  calls = 0;
  assert.deepEqual(await idx.findMatches(user, { id: 'NEW', company: 'x', name: '誰か', emails: ['none@example.jp'] }), []);
  assert.equal(calls, 0);
});

test('更新として登録: 1 回のトランザクションで新旧の名刺・人の項目・履歴を書く', async () => {
  const prev = card('P1', { name: '山田 太郎', title: '課長', department: '営業部', emails: ['taro@example.jp'] });
  const draft = card('N1', { status: 'review', name: '山田 太郎', title: '部長', department: '営業本部', emails: ['taro@example.jp'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  const { call, txs, store, index } = setup([prev, draft]);
  const r = await call('PUT', '/api/cards/N1', save(draft, { personAction: { kind: 'update', ofCardId: 'P1' } }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(txs.length, 1);
  const ops = txs[0];
  assert.equal(ops.length, 5);
  const [newer, older, rowNew, rowOld, hist] = ops;
  assert.equal(newer.set.personId, 'P1');
  assert.equal(newer.set.isCurrent, true);
  assert.equal(newer.set.supersedes, 'P1');
  assert.equal(older.update.pk, 'CARD#P1');
  assert.equal(older.set.isCurrent, false);
  assert.equal(older.remove, undefined, 'gsi1 のキーは外さない');
  assert.equal(older.set.status, 'superseded');
  assert.ok(older.set.updatedAt > prev.updatedAt, 'updatedAt を進めて差分で伝える');
  assert.equal(older.set.gsi1sk, `${older.set.updatedAt}#P1`);
  assert.equal(older.values[':ver'], 1);
  assert.deepEqual([rowNew.put.pk, rowNew.put.sk, rowNew.put.isCurrent], ['PERSON#P1', 'CARD#N1', true]);
  assert.deepEqual([rowOld.put.pk, rowOld.put.sk, rowOld.put.isCurrent], ['PERSON#P1', 'CARD#P1', false]);
  assert.equal(hist.put.type, 'person_update');
  assert.deepEqual(hist.put.changes.map((c) => [c.field, c.before, c.after]), [['department', '営業部', '営業本部'], ['title', '課長', '部長']]);
  // 応答は書いた内容から作る: 人の名刺は古い順で、現在は新しい方
  assert.deepEqual(r.json.person.cards.map((c) => [c.id, c.isCurrent]), [['P1', false], ['N1', true]]);
  assert.equal(r.json.personId, 'P1');
  // 前の名刺は gsi1 のキーを持ったまま superseded になり、索引から落ちる
  assert.equal(store.get('CARD#P1|META').status, 'superseded');
  assert.ok(store.get('CARD#P1|META').gsi1pk);
  assert.equal(r.json.person.cards[0].isCurrent, false);
  assert.equal(index._map.has('P1'), false);
  assert.equal(index._map.has('N1'), true);
});

test('同じ人がいるのに personAction が無いと 400。閲覧だけの人は更新にできない', async () => {
  const prev = card('P1', { name: '山田 太郎', emails: ['taro@example.jp'] });
  const draft = card('N1', { status: 'review', name: '山田 太郎', title: '部長', emails: ['taro@example.jp'] });
  const edit = setup([prev, draft]);
  const r = await edit.call('PUT', '/api/cards/N1', save(draft));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.details.code, 'person_choice_required');
  assert.equal(r.json.error.details.matches[0].kind, 'same_person');
  assert.equal(r.json.error.details.matches[0].title, '課長');
  assert.equal(edit.txs.length, 0);

  const view = setup([prev, draft], { level: 'dept_view' });
  const denied = await view.call('PUT', '/api/cards/N1', save(draft, { personAction: { kind: 'update', ofCardId: 'P1' } }));
  assert.equal(denied.status, 403);
  const sep = await view.call('PUT', '/api/cards/N1', save(draft, { personAction: { kind: 'separate' } }));
  assert.equal(sep.status, 200);
  assert.equal(sep.json.personId, 'N1');
  assert.equal(sep.json.isCurrent, true);
  assert.equal(view.store.get('CARD#P1|META').isCurrent, undefined, '別の人にしたので前の名刺は触らない');
});

test('つながりを外すと、残った人の「現在」を一番新しい名刺に付け直す', async () => {
  // A(古) -> B -> C(現在)。C を外すと、残った A, B のうち新しい B が現在に戻る
  const a = past(card('A', { personId: 'A', isCurrent: false, createdAt: '2026-01-01T00:00:00.000Z' }));
  const b = past(card('B', { personId: 'A', isCurrent: false, createdAt: '2026-05-01T00:00:00.000Z' }));
  const c = card('C', { personId: 'A', isCurrent: true, createdAt: '2026-09-01T00:00:00.000Z' });
  const rows = [a, b, c].map((x) => ({ pk: 'PERSON#A', sk: `CARD#${x.id}`, isCurrent: x.id === 'C', createdAt: x.createdAt }));
  const { call, store, index } = setup([a, b, c, ...rows]);

  const r = await call('POST', '/api/cards/C/person/unlink');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.notEqual(r.json.personId, 'A');
  assert.deepEqual(r.json.person.cards.map((x) => x.id), ['C']);
  assert.equal(store.get('CARD#B|META').isCurrent, true);
  assert.equal(store.get('CARD#B|META').status, 'confirmed');
  assert.ok(store.get('CARD#B|META').updatedAt > '2026-10-01');
  assert.ok(store.get('CARD#B|META').gsi1pk);
  assert.equal(store.get('CARD#A|META').isCurrent, false);
  assert.equal(store.has('PERSON#A|CARD#C'), false);
  assert.equal(index._map.has('B'), true);
  assert.equal(index._map.has('A'), false);
});

test('現在の名刺を削除すると、残った人の一番新しい名刺が現在に戻る', async () => {
  const a = past(card('A', { personId: 'A', isCurrent: false, createdAt: '2026-01-01T00:00:00.000Z' }));
  const c = card('C', { personId: 'A', isCurrent: true, createdAt: '2026-09-01T00:00:00.000Z' });
  const rows = [a, c].map((x) => ({ pk: 'PERSON#A', sk: `CARD#${x.id}`, isCurrent: x.id === 'C', createdAt: x.createdAt }));
  const { call, store } = setup([a, c, ...rows], { level: 'dev' });
  const del = await call('DELETE', '/api/cards/C');
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(store.get('CARD#A|META').isCurrent, true);
  assert.equal(store.get('CARD#A|META').status, 'confirmed');
  assert.ok(store.get('CARD#A|META').gsi1pk);
});

test('別の warm な Lambda の索引にも、過去になったことが差分で伝わり、現在に戻れば載り直す', async () => {
  const prev = card('P1', { name: '山田 太郎', title: '課長', emails: ['taro@example.jp'] });
  const draft = card('N1', { status: 'review', name: '山田 太郎', title: '部長', emails: ['taro@example.jp'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
  const { call, store } = setup([prev, draft]);
  // 更新を実行する Lambda とは別の索引（先に全件を読んである）
  let t = Date.parse('2026-10-02T00:00:00.000Z');
  const other = createSearchIndex({ ddb, now: () => t });
  await other.ensureFresh();
  assert.equal(other._map.has('P1'), true);
  const r = await call('PUT', '/api/cards/N1', save(draft, { personAction: { kind: 'update', ofCardId: 'P1' } }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  t = Date.now() + 60_000;
  await other.ensureFresh();
  assert.equal(other._map.has('P1'), false, '差分で superseded を受け取って落とす');
  assert.equal(other._map.has('N1'), true);
  assert.equal(store.get('CARD#P1|META').status, 'superseded');
  // 過去の名刺は status の応答は confirmed のまま、isCurrent: false
  const d = await call('GET', '/api/cards/P1');
  assert.equal(d.status, 200);
  assert.equal(d.json.status, 'confirmed');
  assert.equal(d.json.isCurrent, false);
});
