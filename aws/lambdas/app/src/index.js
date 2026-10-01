// Lambda「app」。/api/* のうち /api/admin/* と /api/dev/* 以外を受ける（それは console）。
// ログイン（関門 3）は全 API の入口で行う。/api/config だけは認証なし（画面が最初に読む）。
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { ddb, currentUser, errorHandler, notFound } from '@hyper-sfa/aws-shared';
import { createSearchIndex } from './search.js';
import { registerCardRoutes } from './cards.js';
import { registerMinutesRoutes } from './minutes.js';
import { registerChatRoutes } from './chat.js';
import { listDepartments, listUsers, deptRefs } from './org.js';
import { SCAN_PER_DAY } from './rate.js';

// Lambda の起動時に 1 度だけ作る。実行環境が再利用される間、メモリの一覧が残る
const index = createSearchIndex({ ddb });
// 最初の検索を待たせないよう、起動中に読み始める。失敗しても次の検索で読み直す
index.ensureFresh().catch((e) => console.error('index preload failed', e?.name));

export const app = new Hono();
app.onError(errorHandler);
app.notFound((c) => c.json({ error: { code: 'not_found', message: '見つかりません' } }, 404));

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/config') return next();
  c.set('auth', await currentUser(c.env.event));
  return next();
});

app.get('/api/config', (c) => {
  const env = process.env;
  // redirectUri は CloudFront のドメイン（Terraform が APP_ORIGIN に入れる）。画面と同じオリジン
  const origin = env.APP_ORIGIN ?? '';
  return c.json({
    appName: 'hyper-sfa',
    edition: 'aws',
    authMode: 'cognito-google',
    cognito: {
      domain: env.COGNITO_DOMAIN ?? '',
      clientId: env.COGNITO_CLIENT_ID ?? '',
      redirectUri: origin ? `${origin}/auth/callback` : '',
    },
    features: { departments: true, positions: true, userImport: true, minutes: true },
    limits: { scanPerDay: SCAN_PER_DAY, recordingMaxSec: 7200, segmentSec: 600 },
    setupRequired: false,
  });
});

app.get('/api/me', async (c) => {
  const { user, level, capabilities } = c.get('auth');
  return c.json({
    id: user.id,
    email: user.email,
    loginId: null,
    displayName: user.displayName,
    position: user.position,
    level,
    deptIds: user.deptIds,
    departments: await deptRefs(user.deptIds),
    mustChangePassword: false,
    capabilities,
  });
});

app.get('/api/departments', async (c) => {
  const items = await listDepartments();
  return c.json({ items: items.map((d) => ({ id: d.id, name: d.name, order: d.order, active: d.active })) });
});

// 共有や同席者の選択用。無効の人は除く
app.get('/api/directory', async (c) => {
  const [users, depts] = await Promise.all([listUsers(), listDepartments()]);
  const byId = new Map(depts.map((d) => [d.id, d]));
  const items = users
    .filter((u) => u.status === 'active')
    .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      departments: u.deptIds.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).name })),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
  return c.json({ items });
});

registerCardRoutes(app, { index });
registerMinutesRoutes(app);
registerChatRoutes(app);

// 上のどれにも当たらない /api/admin と /api/dev は API Gateway がこの Lambda に送らない。
// 万一届いても、存在を教えない
app.all('/api/*', () => {
  throw notFound();
});

export const handler = handle(app);
