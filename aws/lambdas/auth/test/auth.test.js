// Cognito トリガーの分岐。ddb は差し替える（AWS には触れない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, DENY_MESSAGE } from '../src/handler.js';

function fakeDdb(users = {}) {
  const updates = [];
  return {
    updates,
    async get(pk, sk) {
      return users[sk] ?? null;
    },
    async update(pk, sk, o) {
      updates.push({ sk, ...o });
      users[sk] = { ...users[sk], ...o.set };
      return users[sk];
    },
  };
}

const env = { ALLOWED_HD: 'example.co.jp' };
const now = () => new Date('2026-10-02T00:00:00.000Z');
const active = { status: 'active', position: 'MG', deptIds: ['d1'] };

const inbound = (idToken) => ({ triggerSource: 'InboundFederation_ExternalProvider', request: { attributes: { idToken: JSON.stringify(idToken) } }, response: {} });
const presignup = (email, sub = 'g1') => ({ triggerSource: 'PreSignUp_ExternalProvider', userName: `Google_${sub}`, request: { userAttributes: { email } }, response: {} });

test('hd が会社のドメインと違えば拒否する', async () => {
  const h = createHandler({ ddb: fakeDdb(), env, now });
  await assert.rejects(h(inbound({ hd: 'other.example', email: 'a@other.example', sub: 'g1' })), { message: DENY_MESSAGE });
});

test('hd が無ければメールアドレスのドメインで確かめる', async () => {
  const db = fakeDdb({ 'USER#a@example.co.jp': { ...active } });
  const h = createHandler({ ddb: db, env, now });
  await assert.rejects(h(inbound({ email: 'a@gmail.com', sub: 'g1' })), { message: DENY_MESSAGE });
  const ev = await h(inbound({ email: 'a@example.co.jp', name: '山田 太郎', sub: 'g1' }));
  assert.equal(ev.response.userAttributesToMap['custom:hd'], 'example.co.jp');
  assert.equal(ev.response.userAttributesToMap.email, 'a@example.co.jp');
});

test('hd があるのにメールのドメインと食い違えば拒否する', async () => {
  const h = createHandler({ ddb: fakeDdb(), env, now });
  await assert.rejects(h(inbound({ hd: 'example.co.jp', email: 'a@evil.example', sub: 'g1' })), { message: DENY_MESSAGE });
});

test('未登録・無効のメールアドレスは同じ文言で拒否する', async () => {
  const db = fakeDdb({ 'USER#off@example.co.jp': { ...active, status: 'disabled' } });
  const h = createHandler({ ddb: db, env, now });
  await assert.rejects(h(presignup('nobody@example.co.jp')), { message: DENY_MESSAGE });
  await assert.rejects(h(presignup('off@example.co.jp')), { message: DENY_MESSAGE });
});

test('初回は googleSub と firstLoginAt を記録し、自動で確認済みにする', async () => {
  const db = fakeDdb({ 'USER#a@example.co.jp': { ...active } });
  const h = createHandler({ ddb: db, env, now });
  const ev = await h(presignup('A@Example.co.jp', 'g1'));
  assert.equal(ev.response.autoConfirmUser, true);
  assert.equal(db.updates.length, 1);
  assert.equal(db.updates[0].set.googleSub, 'g1');
  assert.equal(db.updates[0].set.firstLoginAt, '2026-10-02T00:00:00.000Z');
});

test('2 回目以降は googleSub の一致を確かめ、lastLoginAt を更新する', async () => {
  const db = fakeDdb({ 'USER#a@example.co.jp': { ...active, googleSub: 'g1' } });
  const h = createHandler({ ddb: db, env, now });
  await h({ triggerSource: 'PreAuthentication_Authentication', userName: 'Google_g1', request: { userAttributes: { email: 'a@example.co.jp' } }, response: {} });
  assert.equal(db.updates[0].set.lastLoginAt, '2026-10-02T00:00:00.000Z');
  await assert.rejects(
    h({ triggerSource: 'PreAuthentication_Authentication', userName: 'Google_other', request: { userAttributes: { email: 'a@example.co.jp' } }, response: {} }),
    { message: DENY_MESSAGE },
  );
});

test('正常なログインは通り、TokenGeneration はそのまま返す', async () => {
  const db = fakeDdb({ 'USER#a@example.co.jp': { ...active } });
  const h = createHandler({ ddb: db, env, now });
  const ev = await h(inbound({ hd: 'example.co.jp', email: 'a@example.co.jp', name: 'A', sub: 'g1' }));
  assert.equal(ev.response.userAttributesToMap['custom:hd'], 'example.co.jp');
  const tok = { triggerSource: 'TokenGeneration_HostedAuth', request: {}, response: { x: 1 } };
  assert.equal(await h(tok), tok);
});
