// 同じ人の名刺（docs/design.md §5.5b、docs/api-contract.md §4）。
// 人ごとの名刺の一覧は `PERSON#<人ID>` / `CARD#<名刺ID>` を Query 1 回で引く。検索の索引は経由しない。
// 既存の名刺は personId が無い。読むときに「名刺 ID = 人 ID」と見なし、移行の書き込みはしない。
import { canEditCard, ulid } from '@hyper-sfa/core';
import { ddb, K, conflict, forbidden, validation, readJson, isConditionFailed } from '@hyper-sfa/aws-shared';
import { canSeeItem, loadCard, isConfirmed } from './access.js';
import { presentCard } from './present.js';

export const idOf = (item) => item.id ?? String(item.pk).slice('CARD#'.length);
export const personIdOf = (item) => item.personId ?? idOf(item);
const isPast = (item) => item.isCurrent === false || item.status === 'superseded';
const byCreated = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : idOf(a) < idOf(b) ? -1 : 1);

/** 人の名刺のうち、自分以外で生きているもの（META の全項目）。Query 1 回 + BatchGet 1 回（相手がいるときだけ）。 */
export async function otherCards(personId, selfId) {
  const rows = await ddb.queryAll({ pk: `PERSON#${personId}`, skPrefix: 'CARD#' });
  const ids = rows.map((r) => String(r.sk).slice('CARD#'.length)).filter((id) => id !== selfId);
  if (ids.length === 0) return [];
  const items = await ddb.batchGet(ids.map((id) => K.card(id)));
  // 外された名刺の古い項目が残っていても混ざらないよう、personId が今も同じものだけを採る
  return items.filter((it) => !it.deletedAt && (isConfirmed(it.status) || it.status === 'review') && personIdOf(it) === personId);
}

/** `person.cards` の形。見える名刺だけを、古い順に。 */
export function personView(user, items) {
  const cards = items
    .filter((it) => canSeeItem(user, it))
    .sort(byCreated)
    .map((it) => ({
      id: idOf(it),
      company: it.company ?? '',
      department: it.department ?? '',
      title: it.title ?? '',
      name: it.name ?? '',
      createdAt: it.createdAt ?? null,
      isCurrent: !isPast(it),
    }));
  return { cards };
}

/** 詳細の応答用。確認済みの名刺だけが人の単位を持つ（確認前は自分 1 枚で、Query もしない）。 */
export async function personOf(user, item, { known } = {}) {
  if (!isConfirmed(item.status)) return personView(user, [item]);
  const others = known ?? (await otherCards(personIdOf(item), idOf(item)));
  return personView(user, [item, ...others]);
}

/** 確認画面に出す候補に役職を足す（gsi1 に役職が載っていないため、最大 5 件だけ BatchGet で読む）。 */
export async function withTitles(matches) {
  if (!matches?.length) return matches;
  const items = await ddb.batchGet(matches.map((m) => K.card(m.id)));
  const by = new Map(items.map((it) => [idOf(it), it]));
  return matches.map((m) => ({ ...m, title: by.get(m.id)?.title ?? m.title ?? '' }));
}

/**
 * 一覧の索引（gsi1）のキー。過去の名刺にも付けたままにする（status が superseded なら、メモリ内の索引が落とす）。
 * キーを外すと、ほかの warm な Lambda の索引に「過去になった」ことが伝わらないため。
 */
export const gsi1For = (item, at) => K.gsi1(idOf(item), at);

export const versionCondition = (card) => ({
  condition: '#ver = :ver AND attribute_not_exists(deletedAt)',
  names: { '#ver': 'version' },
  values: { ':ver': card.version ?? 1 },
});

/**
 * 名刺を「現在」にする / 「過去」にする書き込み 2 つ（名刺と PERSON# の項目）。
 * どちらも status（confirmed / superseded）と updatedAt、gsi1 のキーを書き直す。ほかの Lambda の索引が差分で受け取り、
 * superseded なら落とし、confirmed に戻ったら載せ直すため（gsi1 のキーは外さない）。
 */
export function flipOps(card, current, at) {
  const id = idOf(card);
  const key = { pk: `CARD#${id}`, sk: 'META' };
  const update = current
    ? { update: key, set: { isCurrent: true, status: 'confirmed', updatedAt: at, ...K.gsi1(id, at) }, remove: ['supersededBy'], add: { version: 1 }, ...versionCondition(card) }
    : { update: key, set: { isCurrent: false, status: 'superseded', updatedAt: at, ...K.gsi1(id, at) }, add: { version: 1 }, ...versionCondition(card) };
  return [update, { put: { ...K.personCard(personIdOf(card), id), createdAt: card.createdAt, isCurrent: current } }];
}

/** flipOps を書いた後の姿（読み直さずに索引と応答へ反映する）。 */
export function flipped(card, current, at) {
  const next = { ...card, isCurrent: current, status: current ? 'confirmed' : 'superseded', updatedAt: at, version: (card.version ?? 1) + 1 };
  if (current) delete next.supersededBy;
  return next;
}

const newest = (items) => [...items].sort(byCreated).at(-1) ?? null;

/**
 * 人の「現在」を正す書き込みと、書いた後の姿。items は人に残る名刺（外す / 消す名刺を除く）。
 * 一番新しい確認済みの名刺を現在に、それ以外は過去にする。
 */
export function reassignCurrent(items, at) {
  const top = newest(items.filter((it) => isConfirmed(it.status)));
  const ops = [];
  const after = [];
  for (const it of items) {
    const want = top != null && idOf(it) === idOf(top);
    if (want !== !isPast(it)) {
      ops.push(...flipOps(it, want, at));
      after.push(flipped(it, want, at));
    } else after.push(it);
  }
  return { ops, after };
}

export function registerPersonRoutes(app, { index }) {
  const me = (c) => c.get('auth').user;
  const needEdit = (user, item) => {
    if (!canEditCard(user, item)) throw forbidden('この名刺を編集する権限がありません');
  };
  const raced = (e) => {
    if (isConditionFailed(e)) throw conflict('ほかの人が先に更新しました。最新の内容を読み込み直してください');
    throw e;
  };

  async function respond(user, item, peers) {
    return presentCard(item, { detail: true, person: await personOf(user, item, { known: peers }) });
  }

  // 保存済みの名刺を、後から同じ人につなぐ。つなぐのは相手の人に、この名刺 1 枚だけ
  app.post('/api/cards/:id/person/link', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    const body = await readJson(c);
    if (!body.ofCardId || typeof body.ofCardId !== 'string') throw validation('ofCardId が必要です', [{ field: 'ofCardId', message: '必須です' }]);
    const target = await loadCard(user, body.ofCardId);
    needEdit(user, item);
    needEdit(user, target);
    if (idOf(item) === idOf(target)) throw validation('同じ名刺は選べません', [{ field: 'ofCardId', message: '別の名刺を選んでください' }]);
    if (!isConfirmed(item.status) || !isConfirmed(target.status)) throw conflict('保存済みの名刺だけをつなげられます');

    const fromPid = personIdOf(item);
    const toPid = personIdOf(target);
    const mine = await otherCards(fromPid, idOf(item));
    if (fromPid === toPid) return c.json(await respond(user, item, mine));
    if (mine.length) throw conflict('この名刺は別の人ともつながっています。先に「つながりを外す」を行ってください');

    const peers = [target, ...(await otherCards(toPid, idOf(target)))];
    const top = newest([item, ...peers].filter((it) => isConfirmed(it.status)));
    const at = new Date().toISOString();
    const itemCurrent = idOf(top) === idOf(item);
    const older = peers.filter((p) => byCreated(p, item) < 0).sort(byCreated).at(-1);

    const ops = [
      {
        update: { pk: item.pk, sk: item.sk },
        set: {
          personId: toPid,
          isCurrent: itemCurrent,
          ...(older ? { supersedes: idOf(older) } : {}),
          ...(itemCurrent ? {} : { status: 'superseded', updatedAt: at, ...K.gsi1(idOf(item), at) }),
        },
        remove: older ? [] : ['supersedes'],
        add: { version: 1 },
        ...versionCondition(item),
      },
      { put: { ...K.personCard(toPid, idOf(item)), createdAt: item.createdAt, isCurrent: itemCurrent } },
      // つなぐ前の人の項目（無ければ何も起きない）
      { del: K.personCard(fromPid, idOf(item)) },
    ];
    const afterPeers = [];
    for (const p of peers) {
      const want = idOf(p) === idOf(top);
      if (want !== !isPast(p)) {
        ops.push(...flipOps(p, want, at));
        afterPeers.push(flipped(p, want, at));
      } else {
        // 古い名刺には PERSON# の項目が無いことがあるので、ここで揃える
        ops.push({ put: { ...K.personCard(toPid, idOf(p)), createdAt: p.createdAt, isCurrent: want } });
        afterPeers.push(p);
      }
    }
    if (ops.length > 25) throw conflict('つなぐ名刺が多すぎます');
    try {
      await ddb.transact(ops);
    } catch (e) {
      raced(e);
    }
    for (const p of afterPeers) index.put(p);
    const updated = { ...item, personId: toPid, isCurrent: itemCurrent, version: (item.version ?? 1) + 1 };
    if (!itemCurrent) Object.assign(updated, { status: 'superseded', updatedAt: at });
    if (older) updated.supersedes = idOf(older);
    else delete updated.supersedes;
    index.put(updated);
    return c.json(await respond(user, updated, afterPeers));
  });

  // 間違ってつないだものを外す。この名刺だけを新しい人にし、残った人の「現在」を一番新しい名刺に付け直す
  app.post('/api/cards/:id/person/unlink', async (c) => {
    const user = me(c);
    const item = await loadCard(user, c.req.param('id'));
    needEdit(user, item);
    if (!isConfirmed(item.status)) throw conflict('保存済みの名刺だけが対象です');
    const pid = personIdOf(item);
    const peers = await otherCards(pid, idOf(item));
    if (peers.length === 0) return c.json(await respond(user, item, []));

    const at = new Date().toISOString();
    const newPid = ulid();
    const wasPast = isPast(item);
    const { ops: peerOps, after } = reassignCurrent(peers.filter((p) => isConfirmed(p.status)), at);
    const ops = [
      {
        update: { pk: item.pk, sk: item.sk },
        set: { personId: newPid, isCurrent: true, ...(wasPast ? { status: 'confirmed', updatedAt: at, ...K.gsi1(idOf(item), at) } : {}) },
        remove: ['supersedes', 'supersededBy'],
        add: { version: 1 },
        ...versionCondition(item),
      },
      { del: K.personCard(pid, idOf(item)) },
      { put: { ...K.personCard(newPid, idOf(item)), createdAt: item.createdAt, isCurrent: true } },
      ...peerOps,
    ];
    if (ops.length > 25) throw conflict('つながっている名刺が多すぎます');
    try {
      await ddb.transact(ops);
    } catch (e) {
      raced(e);
    }
    for (const p of after) index.put(p);
    const updated = { ...item, personId: newPid, isCurrent: true, version: (item.version ?? 1) + 1 };
    if (wasPast) Object.assign(updated, { status: 'confirmed', updatedAt: at });
    delete updated.supersedes;
    delete updated.supersededBy;
    index.put(updated);
    return c.json(await respond(user, updated, []));
  });
}
