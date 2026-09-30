import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envNumber, isSameOrigin, parseCookies, serializeSessionCookie } from '../worker/src/lib/http.js';

const url = 'https://app.example.workers.dev/api/cards/scan';

test('GET は Origin を見ない', () => {
  assert.ok(isSameOrigin({ method: 'GET', origin: 'https://evil.example', url }));
});

test('POST は同じオリジンだけ通す', () => {
  assert.ok(isSameOrigin({ method: 'POST', origin: 'https://app.example.workers.dev', url }));
  assert.ok(!isSameOrigin({ method: 'POST', origin: 'https://evil.example', url }));
  assert.ok(!isSameOrigin({ method: 'DELETE', origin: 'http://app.example.workers.dev', url }));
  assert.ok(!isSameOrigin({ method: 'PUT', origin: 'null', url }));
});

test('Origin が無いときは Sec-Fetch-Site で判断する', () => {
  assert.ok(isSameOrigin({ method: 'POST', url }));
  assert.ok(isSameOrigin({ method: 'POST', secFetchSite: 'same-origin', url }));
  assert.ok(!isSameOrigin({ method: 'POST', secFetchSite: 'cross-site', url }));
  assert.ok(!isSameOrigin({ method: 'POST', secFetchSite: 'same-site', url }));
});

test('ローカル開発は http://localhost の同一オリジンを通す', () => {
  assert.ok(isSameOrigin({ method: 'POST', origin: 'http://localhost:8787', url: 'http://localhost:8787/api/auth/login' }));
});

test('Cookie の読み取り', () => {
  assert.deepEqual(parseCookies('a=1; sid=abc; b=x=y'), { a: '1', sid: 'abc', b: 'x=y' });
  assert.deepEqual(parseCookies(null), {});
});

test('sid の Cookie: HttpOnly / SameSite=Lax / 30 日。Secure は https のときだけ', () => {
  const c = serializeSessionCookie('abc', { maxAgeSec: 30 * 86400, secure: true });
  assert.equal(c, 'sid=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure');
  assert.doesNotMatch(serializeSessionCookie('abc', { maxAgeSec: 10, secure: false }), /Secure/);
  assert.match(serializeSessionCookie('', { maxAgeSec: -5, secure: true }), /Max-Age=0/);
});

test('環境変数の数値', () => {
  assert.equal(envNumber('30000', 1), 30000);
  assert.equal(envNumber(undefined, 7), 7);
  assert.equal(envNumber('abc', 7), 7);
});
