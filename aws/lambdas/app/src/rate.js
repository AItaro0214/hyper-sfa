// 1 人 1 日 200 回の上限（docs/design.md §5.7）。名刺の読み取り（再生成を含む）と、議事録への質問
// （minutes-design.md §16）で、同じ数え方・別のカウンタ。誤操作や不正利用で費用が膨らむのを防ぐ。
// 日付は日本時間で数える（利用者の「1 日」に合わせる）。
import { ddb, K, HttpError, isConditionFailed } from '@hyper-sfa/aws-shared';

export const SCAN_PER_DAY = 200;
export const QA_PER_DAY = 200;
const TTL_SEC = 3 * 24 * 3600;

export function jstDay(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// field は同じ日の項目の中の属性名。用途ごとに別の属性にして、互いの上限を食い合わないようにする
async function consume(field, max, message, userId, now) {
  const k = K.rate(jstDay(now), userId);
  try {
    await ddb.update(k.pk, k.sk, {
      add: { [field]: 1 },
      set: { ttl: Math.floor(now.getTime() / 1000) + TTL_SEC },
      condition: 'attribute_not_exists(#c) OR #c < :max',
      names: { '#c': field },
      values: { ':max': max },
    });
  } catch (e) {
    if (isConditionFailed(e)) throw new HttpError(429, 'rate_limited', message);
    throw e;
  }
}

/** 1 回分を数える。上限を超えていたら rate_limited。 */
export function consumeScan(userId, now = new Date()) {
  return consume('scans', SCAN_PER_DAY, `1 日の読み取り回数の上限（${SCAN_PER_DAY} 回）に達しました。明日またお試しください`, userId, now);
}

/** 質問 1 回分を数える。 */
export function consumeQa(userId, now = new Date()) {
  return consume('qa', QA_PER_DAY, `1 日の質問回数の上限（${QA_PER_DAY} 回）に達しました。明日またお試しください`, userId, now);
}
