// 権限（docs/design.md §9、docs/api-contract.md §2）。
// 判定はすべてサーバー側で行う。画面の出し分けは capabilities を見た目に使うだけで、守りにはしない。

export const LEVELS = Object.freeze(['dev', 'org_admin', 'org_edit', 'dept_edit', 'dept_view']);

// 役職と段階の対応の初期値。実際は設定として持ち、開発コンソールから変えられる（役職が増えてもコードを直さない）。
const POSITION_LEVELS = [
  ['開発者', 'dev'],
  ['役員', 'org_admin'],
  ['GM', 'org_admin'],
  ['SMG', 'org_admin'],
  ['MG', 'org_edit'],
  ['SubMG', 'org_edit'],
  ['EX', 'dept_edit'],
  ['社員A', 'dept_edit'],
  ['社員B', 'dept_view'],
  ['協力会社', 'dept_view'],
];
export const DEFAULT_POSITIONS = Object.freeze(
  POSITION_LEVELS.map(([name, level], i) => Object.freeze({ name, level, order: i + 1 })),
);

/** 役職名から段階を引く。役職の表記ゆれ（全角 / 半角、大文字 / 小文字）は無視する。見つからなければ null。 */
export function levelFor(position, positions = DEFAULT_POSITIONS) {
  const key = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();
  const target = key(position);
  return positions.find((p) => key(p.name) === target)?.level ?? null;
}

const ALL_KEYS = ['seeAllCards', 'editCards', 'deleteAnyCard', 'assignOtherDepts', 'register', 'admin', 'dev', 'viewHistory'];

/** 段階ごとの capabilities。上の段階から順に、できることを減らしていく。 */
export function capabilitiesFor(level) {
  const caps = Object.fromEntries(ALL_KEYS.map((k) => [k, true]));
  const off = (...keys) => keys.forEach((k) => (caps[k] = false));
  switch (level) {
    case 'dev':
      break;
    case 'org_admin':
      off('dev');
      break;
    case 'org_edit':
      off('dev', 'admin', 'viewHistory', 'deleteAnyCard');
      break;
    case 'dept_edit':
      off('dev', 'admin', 'viewHistory', 'deleteAnyCard', 'seeAllCards', 'assignOtherDepts');
      break;
    case 'dept_view':
      off('dev', 'admin', 'viewHistory', 'deleteAnyCard', 'seeAllCards', 'assignOtherDepts', 'editCards');
      break;
    default:
      // 段階が分からない人には登録以外を許さない
      ALL_KEYS.forEach((k) => (caps[k] = false));
  }
  return caps;
}

const overlaps = (a = [], b = []) => a.some((x) => b.includes(x));
const userCaps = (user) => user?.capabilities ?? capabilitiesFor(user?.level);
const creatorId = (card) => card?.createdBy?.id ?? card?.createdBy ?? null;

/** 担当部署が自分の所属と重なる、または全部見られる段階。 */
export function canSeeCard(user, card) {
  if (!user || !card) return false;
  return userCaps(user).seeAllCards || overlaps(user.deptIds, card.deptIds);
}

/** 保存済みの名刺の編集。部署編集は見える範囲だけ。 */
export function canEditCard(user, card) {
  return userCaps(user).editCards === true && canSeeCard(user, card);
}

/** 削除。全社管理以上はすべて、それ以外の編集できる人は自分が登録したものだけ（§9.3）。 */
export function canDeleteCard(user, card) {
  if (!user || !card) return false;
  const caps = userCaps(user);
  if (caps.deleteAnyCard) return true;
  if (!caps.editCards) return false;
  const id = creatorId(card);
  return id != null && id === user.id;
}
