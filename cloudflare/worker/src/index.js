// Worker のエントリ。Hono で /api/* を受け、それ以外は静的アセット（画面）に渡す。
// 議事録の API と Workflow は別ファイル（minutes/、workflows/minutes.js）。import はここ 1 か所にまとめる。
import { Hono } from 'hono';
import { ApiError, errorBody, forbidden, notFound, unauthorized } from './lib/errors.js';
import { isSameOrigin } from './lib/http.js';
import { sessionMiddleware } from './lib/session.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { cardRoutes } from './routes/cards.js';
import { devRoutes } from './routes/dev.js';
import { miscRoutes } from './routes/misc.js';

import { minutesRoutes } from './minutes/index.js';
export { CardScanWorkflow } from './workflows/cards.js';
export { MinutesWorkflow } from './workflows/minutes.js';

const app = new Hono();

// エラーは契約 §1 の形にそろえる。想定外のエラーは中身を出さず（名刺・キー等が混ざり得る）、種類だけログに残す
app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(errorBody(err), err.status);
  if (err?.name === 'HTTPException' || typeof err?.getResponse === 'function') return err.getResponse();
  console.error('unhandled', err?.name ?? 'Error');
  return c.json({ error: { code: 'internal', message: 'サーバーでエラーが起きました。もう一度お試しください' } }, 500);
});

// 1. 変更を伴うリクエストは同じオリジンからだけ（CSRF。SameSite=Lax に加える二重の守り）
app.use('/api/*', async (c, next) => {
  const ok = isSameOrigin({
    method: c.req.method,
    origin: c.req.header('Origin'),
    secFetchSite: c.req.header('Sec-Fetch-Site'),
    url: c.req.url,
  });
  if (!ok) throw forbidden('このリクエストは受け付けられません');
  await next();
});

// 2. セッション
app.use('/api/*', sessionMiddleware);

// 3. ログインが要る API。パスワード変更を求められている間は、変更に要る API だけ通す
const PUBLIC = new Set(['/api/config', '/api/auth/setup', '/api/auth/login']);
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC.has(path)) return next();
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (user.mustChangePassword && path !== '/api/me' && !path.startsWith('/api/auth/')) {
    throw forbidden('パスワードを変更してください');
  }
  await next();
});

// 4. 管理者だけ（管理コンソールと開発コンソールは 1 つの「設定」画面にまとめたので、権限も同じ）
const adminOnly = async (c, next) => {
  if (c.get('user')?.role !== 'admin') throw forbidden();
  await next();
};
app.use('/api/admin/*', adminOnly);
app.use('/api/dev/*', adminOnly);

miscRoutes(app);
authRoutes(app);
cardRoutes(app);
adminRoutes(app);
devRoutes(app);
minutesRoutes(app);

// 知らない /api/* は JSON の 404（SPA の index.html を返さない）
app.all('/api/*', () => {
  throw notFound();
});

// /api/* 以外は静的アセット。通常は wrangler の [assets] が先に返すので、ここには来ない
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: app.fetch };
