// 開発コンソール: CSV 出力。URL は 5 分だけ有効。
import { api } from '../../api.js';
import { state } from '../../state.js';
import { esc, toast, errorMessage } from '../../ui.js';
import { settingsNav } from '../settingsNav.js';

const KINDS = {
  cards: '名刺の一覧',
  history: '履歴',
  'minutes-usage': '議事録の利用状況',
};

export async function renderDevExport(container) {
  const page = document.createElement('div');
  page.className = 'page narrow';
  container.appendChild(page);
  const useDepts = !!state.config.features.departments;
  page.innerHTML = `${settingsNav('/developer/export')}<h1>CSV 出力</h1>
    <form class="stack" novalidate>
      <div class="field"><span>出力するもの</span><div class="radios">${Object.entries(KINDS).map(([k, l], i) => `<label><input type="radio" name="kind" value="${k}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
      <div class="field" data-when="cards history"><span>期間（登録日・操作日）</span><div class="range"><input type="date" name="from"><span>〜</span><input type="date" name="to"></div></div>
      <div class="field" data-when="minutes-usage" hidden><span>期間（月）</span><div class="range"><input type="month" name="mfrom"><span>〜</span><input type="month" name="mto"></div></div>
      <label class="field" data-when="cards"><span>会社名（含む）</span><input name="company"></label>
      <label class="field" data-when="cards"><span>状態</span><select name="status"><option value="">すべて</option><option value="confirmed">確認済み</option><option value="review">確認待ち</option></select></label>
      <label class="field" data-when="history"><span>種類</span><select name="type"><option value="">すべて</option><option value="create">登録</option><option value="edit">編集</option><option value="rescan">読み取り直し</option><option value="delete">削除</option></select></label>
      ${useDepts ? '<label class="field" data-when="cards history minutes-usage"><span>部署</span><select name="dept"><option value="">すべて</option></select></label>' : ''}
      <div class="actions"><button type="submit" class="btn btn-primary">出力する</button></div>
      <p data-out></p></form>`;
  const f = page.querySelector('form');
  const sync = () => {
    const k = f.elements.kind.value;
    f.querySelectorAll('[data-when]').forEach((n) => { n.hidden = !n.dataset.when.split(' ').includes(k); });
  };
  f.addEventListener('change', (e) => { if (e.target.name === 'kind') sync(); });
  sync();
  if (useDepts) api.get('/api/admin/departments').then((r) => {
    f.elements.dept.insertAdjacentHTML('beforeend', (r.items || []).map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join(''));
  }).catch(() => {});
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kind = f.elements.kind.value;
    const v = (n) => f.elements[n]?.value || undefined;
    const filters = kind === 'minutes-usage' ? { from: v('mfrom'), to: v('mto'), dept: v('dept') }
      : kind === 'history' ? { from: v('from'), to: v('to'), type: v('type'), dept: v('dept') }
      : { from: v('from'), to: v('to'), company: v('company'), status: v('status'), dept: v('dept') };
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await api.post('/api/dev/export', { kind, filters });
      page.querySelector('[data-out]').innerHTML = `${esc(r.rows)} 行。<a href="${esc(r.url)}" download>ダウンロード</a>（5 分間有効）`;
      window.open(r.url, '_blank', 'noopener');
    } catch (ex) { toast(errorMessage(ex), 'error'); }
    btn.disabled = false;
  });
}
