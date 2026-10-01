import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptSecret,
  encryptSecret,
  generateTempPassword,
  hashPassword,
  sha256Hex,
  timingSafeEqualStr,
  verifyPassword,
} from '../worker/src/lib/crypto.js';
import { signedPath, verifySignedPath } from '../worker/src/lib/sign.js';

const opts = { pepper: 'pepper-1', iterations: 1000 };

test('パスワードのハッシュを検証できる（pepper あり）', async () => {
  const h = await hashPassword('correct horse battery', opts);
  assert.equal(h.iterations, 1000);
  assert.ok(await verifyPassword('correct horse battery', h, 'pepper-1'));
  assert.ok(!(await verifyPassword('wrong password!!', h, 'pepper-1')));
});

test('users 表の行（password_hash）をそのまま渡しても検証できる', async () => {
  const h = await hashPassword('correct horse battery', opts);
  const row = { password_hash: h.hash, salt: h.salt, iterations: h.iterations, login_id: 'admin' };
  assert.ok(await verifyPassword('correct horse battery', row, 'pepper-1'));
  assert.ok(!(await verifyPassword('wrong', row, 'pepper-1')));
  assert.ok(!(await verifyPassword('correct horse battery', { salt: h.salt, iterations: 1000 }, 'pepper-1')));
});

test('pepper が違えば通らない', async () => {
  const h = await hashPassword('correct horse battery', opts);
  assert.ok(!(await verifyPassword('correct horse battery', h, 'pepper-2')));
});

test('同じパスワードでもソルトでハッシュが変わる', async () => {
  const a = await hashPassword('same-password-1', opts);
  const b = await hashPassword('same-password-1', opts);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('pepper が空ならエラー', async () => {
  await assert.rejects(() => hashPassword('x'.repeat(10), { pepper: '', iterations: 10 }));
});

test('セッション ID のハッシュは SHA-256 の 16 進 64 文字', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(await sha256Hex('a'.repeat(64)), /^[0-9a-f]{64}$/);
});

test('文字列比較は長さが違っても false', () => {
  assert.ok(timingSafeEqualStr('abc', 'abc'));
  assert.ok(!timingSafeEqualStr('abc', 'abd'));
  assert.ok(!timingSafeEqualStr('abc', 'abcd'));
});

test('仮パスワードは 12 文字で英大小文字と数字を含む', () => {
  for (let i = 0; i < 50; i++) {
    const p = generateTempPassword(12);
    assert.equal(p.length, 12);
    assert.match(p, /[a-z]/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[0-9]/);
    assert.doesNotMatch(p, /[0OIl1]/);
  }
});

test('API キーの暗号化は往復でき、用途（aad）や鍵が違うと復号できない', async () => {
  const sealed = await encryptSecret('AIzaSy-secret-key', 'kek', 'apikey:gemini');
  assert.equal(await decryptSecret(sealed, 'kek', 'apikey:gemini'), 'AIzaSy-secret-key');
  await assert.rejects(() => decryptSecret(sealed, 'kek', 'apikey:openai'));
  await assert.rejects(() => decryptSecret(sealed, 'other', 'apikey:gemini'));
});

test('署名付きパス: 検証できる / 改ざん・別の利用者・期限切れ・別の鍵は通らない', async () => {
  const env = { KEY_ENCRYPTION_KEY: 'kek' };
  const url = await signedPath(env, '/api/uploads/cards/A/front.jpg', 60, 'user1');
  assert.ok(await verifySignedPath(env, url, 'user1'));
  assert.ok(!(await verifySignedPath(env, url, 'user2')));
  assert.ok(!(await verifySignedPath(env, url.replace('/front.jpg', '/back.jpg'), 'user1')));
  const expired = await signedPath(env, '/api/x', -10, 'user1');
  assert.ok(!(await verifySignedPath(env, expired, 'user1')));
  assert.ok(!(await verifySignedPath({ KEY_ENCRYPTION_KEY: 'other' }, url, 'user1')));
});
