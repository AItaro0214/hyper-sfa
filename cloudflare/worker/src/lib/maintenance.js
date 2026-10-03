// 掃除。Cron を使わないので、ログインのたびに少しずつ行う（docs/cloudflare-small-design.md §3.3, §5）。
import { addDays, nowIso } from './time.js';

const PURGE_CARDS_PER_RUN = 5;

export async function housekeeping(env) {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?').bind(now, now),
    env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(addDays(now, -1)),
    env.DB.prepare('DELETE FROM scan_quota WHERE day < ?').bind(addDays(now, -3).slice(0, 10)),
    env.DB.prepare('DELETE FROM qa_quota WHERE day < ?').bind(addDays(now, -3).slice(0, 10)),
  ]);

  // 論理削除から 30 日たった名刺を、画像と履歴ごと消す
  const { results } = await env.DB.prepare(
    'SELECT id, image_front_key, image_back_key, thumb_key FROM cards WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?',
  )
    .bind(addDays(now, -30), PURGE_CARDS_PER_RUN)
    .all();
  for (const c of results) {
    const keys = [c.image_front_key, c.image_back_key, c.thumb_key].filter(Boolean);
    if (keys.length) await env.IMAGES.delete(keys);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM card_history WHERE card_id = ?').bind(c.id),
      env.DB.prepare('DELETE FROM card_contacts WHERE card_id = ?').bind(c.id),
      env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(c.id),
    ]);
  }
}
