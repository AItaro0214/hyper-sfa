// ユーザーの無効化に合わせて Cognito 側のログインも止める（docs/design.md §9.6）。
// Cognito のユーザー名は Google_<sub> 形式で、メールアドレスからは引けないので ListUsers で探す。
// 見つからなければ（まだ一度もログインしていない人）DynamoDB だけで足りる。
import {
  CognitoIdentityProviderClient, ListUsersCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';

let cip = null;
const client = () => (cip ??= new CognitoIdentityProviderClient({}));

function poolId() {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) throw new Error('COGNITO_USER_POOL_ID が未設定です');
  return id;
}

async function usernamesFor(email) {
  // Filter の文字列に入るので、引用符と円記号を除いておく（メールアドレスの形は呼び出し側で確かめ済み）
  const safe = String(email).replace(/["\\]/g, '');
  const r = await client().send(new ListUsersCommand({ UserPoolId: poolId(), Filter: `email = "${safe}"`, Limit: 10 }));
  return (r.Users ?? []).map((u) => u.Username).filter(Boolean);
}

/** 無効にして、発行済みのトークンも取り消す（ログインの維持を止める）。見つかった人数を返す。 */
export async function disableCognitoUser(email) {
  const names = await usernamesFor(email);
  for (const Username of names) {
    await client().send(new AdminDisableUserCommand({ UserPoolId: poolId(), Username }));
    await client().send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username }));
  }
  return names.length;
}

export async function enableCognitoUser(email) {
  const names = await usernamesFor(email);
  for (const Username of names) {
    await client().send(new AdminEnableUserCommand({ UserPoolId: poolId(), Username }));
  }
  return names.length;
}
