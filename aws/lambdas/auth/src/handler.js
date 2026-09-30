// Cognito のトリガー（docs/design.md §9.6 の関門 2）。API Gateway にはつながない。
// ddb は引数で受ける（テストで差し替えるため）。ログには判定の結果だけを書き、メールアドレスや名前は書かない。
import { K } from '@hyper-sfa/aws-shared/keys.js';

// 拒否の文言は 1 つにそろえる。画面はこの文言で「登録されていません」の案内を出す
export const DENY_MESSAGE = 'このアカウントは登録されていません。管理者に連絡してください。';

const lower = (s) => String(s ?? '').trim().toLowerCase();

function deny(reason) {
  console.log(`auth: denied reason=${reason}`);
  return new Error(DENY_MESSAGE);
}

/** Cognito は idToken を JSON 文字列で渡すことも、オブジェクトで渡すこともあるので両方受ける。 */
function readIdToken(event) {
  const raw = event.request?.attributes?.idToken;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Google の sub は Cognito のユーザー名 "Google_<sub>" の後ろ半分
const subFromUserName = (userName) => String(userName ?? '').replace(/^Google_/, '');

/**
 * 組織のドメインの確認。
 * Google の証明（ID トークン）の hd を優先する。Cognito が渡す証明に hd が含まれない場合は、
 * メールアドレスの @ 以降で確かめる（設計書 §9.6「実機で確かめること」の代替案）。
 * hd が無いときにメールで確かめるのは、Google 側の「内部」設定が外れたときにも組織外を止めるため。
 * ただし hd があるのにメールのドメインと食い違う場合も拒否する。
 */
function checkDomain(claims, allowedHd) {
  const allowed = lower(allowedHd);
  if (!allowed) throw new Error('ALLOWED_HD が未設定です'); // 設定漏れで全員を通さない
  const hd = lower(claims.hd);
  const emailDomain = lower(claims.email).split('@')[1] ?? '';
  if (hd) {
    if (hd !== allowed) throw deny('hd');
    if (emailDomain && emailDomain !== allowed) throw deny('email_domain');
    return;
  }
  if (emailDomain !== allowed) throw deny('no_hd');
}

export function createHandler({ ddb, env = process.env, now = () => new Date() }) {
  async function findUser(email) {
    const k = K.user(email);
    return ddb.get(k.pk, k.sk);
  }

  /**
   * 登録済みで有効か。初回は Google の ID を記録し、以後は一致を確かめる。
   * ID を確かめるのは、メールアドレスを使い回されても別人が入れないようにするため。
   */
  async function verifyRegistered({ email, sub, name }) {
    const e = lower(email);
    if (!e) throw deny('no_email');
    const user = await findUser(e);
    if (!user || user.status !== 'active') throw deny(user ? 'inactive' : 'unregistered');

    const at = now().toISOString();
    const k = K.user(e);
    if (!user.googleSub) {
      if (sub) {
        // 同時に 2 回目のログインが来ても、先に書いた ID を上書きしない
        await ddb.update(k.pk, k.sk, {
          set: { googleSub: sub, firstLoginAt: at, lastLoginAt: at, ...(user.displayName || !name ? {} : { displayName: name }) },
          condition: 'attribute_not_exists(googleSub)',
        }).catch((err) => {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
        });
      }
    } else {
      if (sub && user.googleSub !== sub) throw deny('sub_mismatch');
      await ddb.update(k.pk, k.sk, { set: { lastLoginAt: at } });
    }
  }

  return async function handler(event) {
    const source = event?.triggerSource;
    const attrs = event?.request?.userAttributes ?? {};

    switch (source) {
      case 'InboundFederation_ExternalProvider': {
        const claims = readIdToken(event);
        checkDomain(claims, env.ALLOWED_HD);
        // 毎回、登録の有無も確かめる（ログイン後に無効にされた人が、更新のたびに入り直せないように）
        if (claims.email) await verifyRegistered({ email: claims.email, sub: claims.sub, name: claims.name });
        event.response = event.response ?? {};
        event.response.userAttributesToMap = {
          email: claims.email,
          name: claims.name,
          'custom:hd': lower(claims.hd) || lower(claims.email).split('@')[1] || '',
        };
        return event;
      }
      case 'PreSignUp_ExternalProvider': {
        await verifyRegistered({ email: attrs.email, sub: subFromUserName(event.userName), name: attrs.name });
        event.response = event.response ?? {};
        // 連携ユーザーは確認メールを受け取れないので、こちらで確認済みにする
        event.response.autoConfirmUser = true;
        event.response.autoVerifyEmail = true;
        return event;
      }
      case 'PreAuthentication_Authentication': {
        await verifyRegistered({ email: attrs.email, sub: subFromUserName(event.userName), name: attrs.name });
        return event;
      }
      case 'TokenGeneration_HostedAuth':
        return event;
      default:
        // 想定外のトリガーは通さず、内容も出さない
        console.log('auth: unexpected trigger');
        return event;
    }
  };
}
