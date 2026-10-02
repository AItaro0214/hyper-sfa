// 検索用の一覧をメモリに持つ（docs/design.md §7）。
// DynamoDB は部分一致が苦手で、検索のたびに全件を読むと件数に比例して遅く高くなる。
// そこで gsi1 から検索用の項目を読み込み、検索はメモリの中で行う。
// ddb を引数で受けるのは、テストで差し替えるため（AWS SDK に依存しない）。
import { searchKeys, parseQuery, matchCard, canSeeCard } from '@hyper-sfa/core';

// 差分の読み込みで、前回の開始時刻より少し前から読む。索引への反映が遅れて
// 「読んだ後に、それより前の時刻で現れた項目」を取りこぼさないため（同じ cardId は上書きするので重複しても害はない）
export const OVERLAP_MS = 5000;

const JST_OFFSET = '+09:00';
const normId = (v) => String(v ?? '').trim().toLowerCase();

/** 登録日（YYYY-MM-DD）の範囲。画面は日本時間の日付で指定するので日本時間の 0 時と翌日 0 時で比べる。 */
function dateRange(from, to) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
  const lo = ok(from) ? new Date(`${from}T00:00:00${JST_OFFSET}`).toISOString() : null;
  let hi = null;
  if (ok(to)) {
    const d = new Date(`${to}T00:00:00${JST_OFFSET}`);
    d.setUTCDate(d.getUTCDate() + 1);
    hi = d.toISOString();
  }
  return { lo, hi };
}

export function createSearchIndex({ ddb, shards = 8, now = () => Date.now() }) {
  const map = new Map(); // 名刺 ID -> { id, item, keys }
  let syncedFrom = null; // 次の差分の読み始め（ISO）。null なら全件
  let loading = null;

  function apply(items) {
    for (const item of items) {
      const id = item.id ?? String(item.pk ?? '').replace(/^CARD#/, '');
      if (!id) continue;
      const prev = map.get(id);
      // 古い写しで新しいものを上書きしない（重ねて読むため）
      if (prev && String(prev.item.updatedAt ?? '') > String(item.updatedAt ?? '')) continue;
      if (item.deletedAt) {
        map.delete(id);
        continue;
      }
      // メモリに載せるのは一覧の表示と絞り込みに要る項目だけ（10 万件で数百 MB に収めるため、extraction と重複する keys は持たない）
      const { keys, extraction, gsi1pk, gsi1sk, ...rest } = item;
      map.set(id, { id, item: { ...rest, id }, keys: keys ?? searchKeys(item) });
    }
  }

  async function sync() {
    const started = now();
    const from = syncedFrom;
    const lists = await Promise.all(
      Array.from({ length: shards }, (_, n) =>
        ddb.queryAll({ pk: `IDX#${n}`, index: 'gsi1', ...(from ? { skGte: from } : {}) }),
      ),
    );
    for (const items of lists) apply(items);
    syncedFrom = new Date(started - OVERLAP_MS).toISOString();
  }

  /** リクエストごとに呼ぶ。同時に呼ばれても読み込みは 1 回にまとめる。 */
  function ensureFresh() {
    loading ??= sync().finally(() => {
      loading = null;
    });
    return loading;
  }

  /** 検索結果や重複の判定に出してよいか（docs/design.md §9.4、§4 の状態表）。 */
  function visible(user, entry) {
    const it = entry.item;
    if (it.status === 'processing' || it.status === 'failed') {
      // 読み取り中と失敗は、登録した本人と、編集できて見える範囲の人だけ
      return it.createdBy === user.id || (user.capabilities?.editCards === true && canSeeCard(user, it));
    }
    return canSeeCard(user, it);
  }

  /**
   * @returns {Promise<{ entries: Array, nextCursor: string|null, total: number }>}
   */
  async function search({ user, params = {}, limit = 50, cursor = null }) {
    await ensureFresh();
    const q = parseQuery(params);
    const { lo, hi } = dateRange(params.from, params.to);
    const owner = normId(params.owner);
    const dept = String(params.dept ?? '').trim();
    const status = String(params.status ?? '').trim();

    const hits = [];
    for (const e of map.values()) {
      const it = e.item;
      if (status) {
        if (it.status !== status) continue;
      } else if (it.status !== 'review' && it.status !== 'confirmed') {
        continue;
      }
      if (owner && normId(it.createdBy) !== owner) continue;
      if (dept && !(it.deptIds ?? []).includes(dept)) continue;
      if (lo && String(it.createdAt ?? '') < lo) continue;
      if (hi && String(it.createdAt ?? '') >= hi) continue;
      // 見える範囲を先に絞る。範囲の外の名刺は、件数にも数えない
      if (!visible(user, e)) continue;
      if (!matchCard(e.keys, q)) continue;
      hits.push(e);
    }
    hits.sort((a, b) => {
      const ua = String(a.item.updatedAt ?? '');
      const ub = String(b.item.updatedAt ?? '');
      if (ua !== ub) return ua < ub ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });

    let start = 0;
    if (cursor?.u != null) {
      // カーソルは最後に返した項目の位置。並びが変わっていても、その次から続ける
      start = hits.findIndex((e) => {
        const u = String(e.item.updatedAt ?? '');
        return u < cursor.u || (u === cursor.u && e.id < cursor.id);
      });
      if (start < 0) start = hits.length;
    }
    const page = hits.slice(start, start + limit);
    const last = page[page.length - 1];
    const more = start + limit < hits.length;
    return {
      entries: page,
      total: hits.length,
      nextCursor: more && last ? { u: String(last.item.updatedAt ?? ''), id: last.id } : null,
    };
  }

  /**
   * 見える範囲の確認済みの名刺（取引先の集計用。docs/api-contract.md の GET /api/companies）。
   * 範囲の外の名刺を集計に混ぜると、会社名や人の名前から存在が分かってしまうので、search と同じ visible を通す。
   */
  async function visibleConfirmed(user) {
    await ensureFresh();
    const out = [];
    for (const e of map.values()) {
      if (e.item.status === 'confirmed' && visible(user, e)) out.push(e.item);
    }
    return out;
  }

  /** 同じメールアドレス、または同じ会社名と氏名の名刺（見える範囲だけ。§9.4）。 */
  async function findDuplicates(user, card, { max = 5 } = {}) {
    await ensureFresh();
    const mine = searchKeys(card);
    const out = [];
    for (const e of map.values()) {
      if (e.id === card.id) continue;
      if (e.item.status !== 'review' && e.item.status !== 'confirmed') continue;
      if (!canSeeCard(user, e.item)) continue;
      let reason = null;
      if (mine.emailsN.length && e.keys.emailsN?.some((m) => mine.emailsN.includes(m))) reason = 'email';
      else if (mine.companyN && mine.nameN && e.keys.companyN === mine.companyN && e.keys.nameN === mine.nameN) reason = 'company_name';
      if (!reason) continue;
      out.push({ id: e.id, company: e.item.company ?? '', name: e.item.name ?? '', reason });
      if (out.length >= max) break;
    }
    return out;
  }

  /** 保存の応答で返した内容をすぐ反映したいとき。索引の反映を待たずに次の検索へ出す。 */
  function put(item) {
    apply([item]);
  }

  return { search, visibleConfirmed, findDuplicates, ensureFresh, put, size: () => map.size, _map: map };
}
