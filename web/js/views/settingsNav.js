// 管理と開発の画面に共通のタブ。Cloudflare 版は「設定」1 つにまとまるので、同じ帯に並べる。
import { state } from '../state.js';
import { esc } from '../ui.js';

export function settingsNav(active) {
  const c = state.me.capabilities || {};
  const f = state.config.features || {};
  const tabs = [];
  if (c.admin) {
    tabs.push(['/admin/users', 'ユーザー']);
    if (f.departments) tabs.push(['/admin/departments', '部署']);
  }
  if (c.viewHistory) tabs.push(['/admin/history', '履歴']);
  if (c.admin && f.userImport) tabs.push(['/admin/import', 'CSV 一括登録']);
  if (c.dev) tabs.push(['/developer/keys', 'API キー'], ['/developer/models', 'モデル'], ['/developer/prompts', 'プロンプト'], ['/developer/export', 'CSV 出力'], ['/developer/usage', '利用状況'], ['/developer/audit', '監査ログ']);
  return `<nav class="tabs" aria-label="設定">${tabs.map(([p, l]) => `<a href="${p}" class="${p === active ? 'active' : ''}">${esc(l)}</a>`).join('')}</nav>`;
}
