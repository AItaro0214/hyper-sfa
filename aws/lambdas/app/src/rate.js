// 1 人 1 日 200 回の読み取り上限（再生成を含む。docs/design.md §5.7）。
// 誤操作や不正利用で費用が膨らむのを防ぐ。日付は日本時間で数える（利用者の「1 日」に合わせる）。
import { ddb, K, HttpError, isConditionFailed } from '@hyper-sfa/aws-shared';

export const SCAN_PER_DAY = 200;
const TTL_SEC = 3 * 24 * 3600;

export function jstDay(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 1 回分を数える。上限を超えていたら rate_limited。 */
export async function consumeScan(userId, now = new Date()) {
  const k = K.rate(jstDay(now), userId);
  try {
    await ddb.update(k.pk, k.sk, {
      add: { scans: 1 },
      set: { ttl: Math.floor(now.getTime() / 1000) + TTL_SEC },
      condition: 'attribute_not_exists(#c) OR #c < :max',
      names: { '#c': 'scans' },
      values: { ':max': SCAN_PER_DAY },
    });
  } catch (e) {
    if (isConditionFailed(e)) {
      throw new HttpError(429, 'rate_limited', `1 日の読み取り回数の上限（${SCAN_PER_DAY} 回）に達しました。明日またお試しください`);
    }
    throw e;
  }
}
