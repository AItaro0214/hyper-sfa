// Lambda「console」。/api/admin/*（管理コンソール）と /api/dev/*（開発コンソール）を受ける。
// 権限は入口で確かめる。ここを通らない経路は無い（API Gateway が、この 2 つのパスだけをこの Lambda に送る）。
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { currentUser, errorHandler, forbidden } from '@hyper-sfa/aws-shared';
import { registerAdminRoutes } from './admin.js';
import { registerDevRoutes } from './dev.js';
import { registerReportRoutes } from './reports.js';

export const app = new Hono();
app.onError(errorHandler);
app.notFound((c) => c.json({ error: { code: 'not_found', message: '見つかりません' } }, 404));

app.use('/api/*', async (c, next) => {
  const auth = await currentUser(c.env.event);
  c.set('auth', auth);
  const path = c.req.path;
  // 管理コンソールは役員・GM・SMG と開発者、開発コンソールは開発者だけ（docs/design.md §9.1）
  if (path.startsWith('/api/admin/') && !auth.capabilities.admin) throw forbidden();
  if (path.startsWith('/api/dev/') && !auth.capabilities.dev) throw forbidden();
  if (!path.startsWith('/api/admin/') && !path.startsWith('/api/dev/')) throw forbidden();
  return next();
});

registerAdminRoutes(app);
registerDevRoutes(app);
registerReportRoutes(app);

export const handler = handle(app);
