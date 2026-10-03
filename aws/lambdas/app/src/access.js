// 名刺の「見える範囲」の判定（docs/design.md §9.4）。
// 詳細・画像 URL・状態・編集・再生成・履歴・議事録の紐づけのすべてがここを通る。
// 範囲の外は「無い」と同じ 404 を返し、存在も漏らさない。
import { canSeeCard } from '@hyper-sfa/core';
import { ddb, K, notFound } from '@hyper-sfa/aws-shared';

/**
 * 確認済みか。'superseded' は同じ人の新しい名刺に置き換えられた「確認済みの過去の名刺」で、
 * gsi1 に残したまま status だけ変える（warm な Lambda の索引にも差分で伝わり、落とせるため。design §5.5b）。
 */
export const isConfirmed = (status) => status === 'confirmed' || status === 'superseded';

/** 読み取り中・失敗は本人と、編集できて見える範囲の人だけ。それ以外は担当部署で決まる。 */
export function canSeeItem(user, item) {
  if (!item || item.deletedAt) return false;
  if (item.status === 'processing' || item.status === 'failed') {
    return item.createdBy === user.id || (user.capabilities?.editCards === true && canSeeCard(user, item));
  }
  return canSeeCard(user, item);
}

/** 名刺を読み、見えなければ 404。 */
export async function loadCard(user, id) {
  const k = K.card(String(id ?? ''));
  const item = await ddb.get(k.pk, k.sk);
  if (!item || !canSeeItem(user, item)) throw notFound('名刺が見つかりません');
  return item;
}

/** 与えられた名刺 ID のうち、user に見えるものの Set。議事録の「名刺を開く」の出し分けに使う。 */
export async function visibleCardIds(user, ids) {
  const uniq = [...new Set((ids ?? []).filter(Boolean))];
  if (uniq.length === 0) return new Set();
  const items = await ddb.batchGet(uniq.map((id) => K.card(id)));
  const out = new Set();
  for (const it of items) {
    if ((it.status === 'review' || isConfirmed(it.status)) && canSeeItem(user, it)) out.add(String(it.pk).slice('CARD#'.length));
  }
  return out;
}
