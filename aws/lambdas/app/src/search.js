// 検索用の一覧をメモリに持つ（docs/design.md §7）。
// DynamoDB は部分一致が苦手で、検索のたびに全件を読むと件数に比例して遅く高くなる。
// そこで gsi1 から検索用の項目を読み込み、検索はメモリの中で行う。
// ddb を引数で受けるのは、テストで差し替えるため（AWS SDK に依存しない）。
import { searchKeys, parseQuery, matchCard, canSeeCard, matchKeys, classifyMatch, rankMatches } from '@hyper-sfa/core';

// 差分の読み込みで、前回の開始時刻より少し前から読む。索引への反映が遅れて
// 「読んだ後に、それより前の時刻で現れた項目」を取りこぼさないため（同じ cardId は上書きするので重複しても害はない）
export const OVERLAP_MS = 5000;

// 引き表の鍵は文字列ではなく 30 ビットの整数にする。文字列を鍵にすると名刺 1 枚あたり数百バイト増えるが、
// 小さな整数ならヒープに載らない。衝突しても候補が 1 つ増えるだけで、最後に classifyMatch が確かめる
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x3fffffff;
}

// 引き表の値は、ほとんどが 1 枚なので ID の文字列そのものを持ち、2 枚目からだけ Set にする
function tableAdd(table, key, id) {
  const cur = table.get(key);
  if (cur === undefined) table.set(key, id);
  else if (typeof cur === 'string') {
    if (cur !== id) table.set(key, new Set([cur, id]));
  } else cur.add(id);
}

function tableDel(table, key, id) {
  const cur = table.get(key);
  if (cur === undefined) return;
  if (typeof cur === 'string') {
    if (cur === id) table.delete(key);
  } else {
    cur.delete(id);
    if (cur.size === 1) table.set(key, [...cur][0]);
    else if (cur.size === 0) table.delete(key);
  }
}

function tableEach(table, key, fn) {
  const cur = table.get(key);
  if (cur === undefined) return;
  if (typeof cur === 'string') fn(cur);
  else for (const id of cur) fn(id);
}

// 突き合わせの候補を引く数の上限。同姓同名が大量にいる異常な索引でも、判定の回数を抑える
const MAX_CANDIDATES = 50;

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

export function createSearchIndex({ ddb, shards = 8, now = () => Date.now(), classify = classifyMatch }) {
  const map = new Map(); // 名刺 ID -> { id, item, keys }
  let syncedFrom = null; // 次の差分の読み始め（ISO）。null なら全件
  let loading = null;
  // 同じ人を探す 4 つの引き表（鍵のハッシュ -> ID または ID の Set）。確認待ちと確認済みの「現在」の名刺だけを載せる
  const byEmail = new Map();
  const byPhone = new Map();
  const byName = new Map();
  const byCompanyName = new Map();

  function matchKeysOf(item, keys) {
    // gsi1 に役職は載っていない（INCLUDE が上限）ので、検索用キーの正規化済みの役職を使う
    return matchKeys({ ...item, title: item.title ?? keys?.titleN ?? '' });
  }

  function link(id, item, keys) {
    if (item.status !== 'review' && item.status !== 'confirmed') return;
    const k = matchKeysOf(item, keys);
    for (const e of k.emails) tableAdd(byEmail, hash(e), id);
    for (const p of k.phones) tableAdd(byPhone, hash(p), id);
    if (k.nameN) tableAdd(byName, hash(k.nameN), id);
    if (k.companyKeyName) tableAdd(byCompanyName, hash(k.companyKeyName), id);
  }

  function unlink(id, item, keys) {
    const k = matchKeysOf(item, keys);
    for (const e of k.emails) tableDel(byEmail, hash(e), id);
    for (const p of k.phones) tableDel(byPhone, hash(p), id);
    if (k.nameN) tableDel(byName, hash(k.nameN), id);
    if (k.companyKeyName) tableDel(byCompanyName, hash(k.companyKeyName), id);
  }

  function drop(id) {
    const prev = map.get(id);
    if (!prev) return;
    unlink(id, prev.item, prev.keys);
    map.delete(id);
  }

  function apply(items) {
    for (const item of items) {
      const id = item.id ?? String(item.pk ?? '').replace(/^CARD#/, '');
      if (!id) continue;
      const prev = map.get(id);
      // 古い写しで新しいものを上書きしない（重ねて読むため）
      if (prev && String(prev.item.updatedAt ?? '') > String(item.updatedAt ?? '')) continue;
      // 削除と、同じ人の新しい名刺に置き換えられた過去の名刺（status: superseded）は、一覧にも引き表にも載せない。
      // 過去の名刺は gsi1 に残してあるので、ほかの warm な Lambda も差分でこの項目を受け取り、ここで落とす
      if (item.deletedAt || item.status === 'superseded' || item.isCurrent === false) {
        drop(id);
        continue;
      }
      if (prev) drop(id);
      // メモリに載せるのは一覧の表示と絞り込みに要る項目だけ（10 万件で数百 MB に収めるため、extraction と重複する keys は持たない）
      const { keys, extraction, gsi1pk, gsi1sk, ...rest } = item;
      const entry = { id, item: { ...rest, id }, keys: keys ?? searchKeys(item) };
      map.set(id, entry);
      link(id, entry.item, entry.keys);
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

  /**
   * 同じ名刺・同じ人・同じ名前の候補（見える範囲だけ。design §5.5b、§9.4）。
   * 引き表だけで候補を集める。全件は舐めない。
   * 確認待ちの名刺は「更新」の相手にできないので、同じ人としては出さない（二重登録の知らせにだけ使う）。
   */
  async function findMatches(user, card, { max = 5 } = {}) {
    await ensureFresh();
    const mine = matchKeys(card);
    const ids = new Set();
    const collect = (table, key) => tableEach(table, hash(key), (id) => ids.add(id));
    for (const e of mine.emails) collect(byEmail, e);
    for (const p of mine.phones) collect(byPhone, p);
    if (mine.nameN) collect(byName, mine.nameN);
    if (mine.companyKeyName) collect(byCompanyName, mine.companyKeyName);
    ids.delete(card.id);

    const out = [];
    let seen = 0;
    for (const id of ids) {
      if (++seen > MAX_CANDIDATES) break;
      const e = map.get(id);
      if (!e || !canSeeCard(user, e.item)) continue;
      const r = classify(mine, matchKeysOf(e.item, e.keys));
      if (!r) continue;
      if (r.kind === 'same_person' && e.item.status !== 'confirmed') continue;
      out.push({
        id,
        company: e.item.company ?? '',
        department: e.item.department ?? '',
        title: e.item.title ?? '',
        name: e.item.name ?? '',
        createdAt: e.item.createdAt ?? null,
        kind: r.kind,
        reason: r.reason,
      });
    }
    return rankMatches(out, { max });
  }

  /** 保存の応答で返した内容をすぐ反映したいとき。索引の反映を待たずに次の検索へ出す。 */
  function put(item) {
    apply([item]);
  }

  return { search, visibleConfirmed, findMatches, ensureFresh, put, size: () => map.size, _map: map, _tables: { byEmail, byPhone, byName, byCompanyName } };
}
