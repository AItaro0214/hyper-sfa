// 設定、自分、部署、利用者の一覧（共有や同席者の選択用）。
import { envNumber } from '../lib/http.js';
import { meResponse } from '../lib/session.js';

export function miscRoutes(app) {
  // 認証不要。画面が最初に読む
  app.get('/api/config', async (c) => {
    const any = await c.env.DB.prepare('SELECT 1 AS x FROM users LIMIT 1').first();
    return c.json({
      appName: c.env.APP_NAME || 'hyper-sfa',
      edition: 'cloudflare',
      authMode: 'password',
      features: { departments: false, positions: false, userImport: false, minutes: true },
      limits: {
        scanPerDay: envNumber(c.env.SCAN_PER_DAY, 200),
        recordingMaxSec: envNumber(c.env.RECORDING_MAX_SEC, 7200),
        segmentSec: envNumber(c.env.SEGMENT_SEC, 600),
      },
      setupRequired: !any,
    });
  });

  app.get('/api/me', (c) => c.json(meResponse(c.get('user'))));

  // 部署の仕組みは持たない
  app.get('/api/departments', (c) => c.json({ items: [] }));

  app.get('/api/directory', async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, login_id, display_name FROM users WHERE status = 'active' ORDER BY display_name, login_id",
    ).all();
    return c.json({
      items: results.map((u) => ({
        id: u.id,
        displayName: u.display_name || u.login_id,
        email: u.login_id.includes('@') ? u.login_id : '',
        departments: [],
      })),
    });
  });
}
