// 議事録の詳細の「資料」の欄（minutes-design §15.2）。
// 追加の流れ: ファイルを選ぶ → ブラウザで展開（pptx / xlsx）→ 送り先を貰う → 元のファイルと抜いた JSON を PUT → done。
import { api } from '../../api.js';
import { toast } from '../../ui.js';
import { extractMaterial, materialKind } from '../../materials/extract.js';
import { esc, ask, errMessage, isProcessing } from './util.js';

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;
const ICON = { pdf: '📄', pptx: '📽', xlsx: '📊' };
const OUTLINE = { pending: '目次: 作成待ち', done: '目次: 作成済み', failed: '目次: 失敗' };

// 詳細画面が描き直されても、送信中の行が消えないように、議事録ごとに持っておく
const inflight = new Map(); // minuteId → Map(key → { name, text })
const repaints = new Map(); // minuteId → 最後に描いた欄の再描画
// 一覧の API には、グラフの数が無い。この画面で追加した分だけは、展開した結果から分かる。
const chartCounts = new Map(); // `${minuteId}/${matId}` → 数

function sizeLabel(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`; }

function unitLabel(mat) {
  if (!mat.pages) return '';
  return mat.kind === 'pptx' ? `${mat.pages} スライド` : mat.kind === 'xlsx' ? `${mat.pages} シート` : `${mat.pages} ページ`;
}

function chartsOf(extract) {
  if (!extract) return 0;
  const list = extract.slides || extract.sheets || [];
  return list.reduce((n, s) => n + (s.charts ? s.charts.length : 0), 0);
}

export function renderMaterials(container, minute, { onChanged } = {}) {
  const id = minute.id;
  const own = minute.relation === 'owner';
  const items = minute.materials || [];
  const busy = isProcessing(minute.status);
  const run = inflight.get(id) || new Map();
  inflight.set(id, run);

  const rows = items.map((mat) => {
    const charts = mat.charts ?? chartCounts.get(`${id}/${mat.id}`);
    const meta = [
      unitLabel(mat),
      charts ? `グラフ ${charts} つ` : '',
      OUTLINE[mat.outlineStatus] || '',
    ].filter(Boolean).join('　');
    return `<li class="mn-mat-row" data-mat="${esc(mat.id)}">
      <span class="mn-mat-icon" aria-hidden="true">${ICON[mat.kind] || '📎'}</span>
      <span class="mn-mat-name">${esc(mat.name)}</span>
      <span class="mn-muted mn-mat-meta${mat.outlineStatus === 'failed' ? ' mn-warn' : ''}">${esc(meta)}</span>
      <span class="mn-mat-btns"><button type="button" class="mn-btn mn-btn-sm" data-mat-open="${esc(mat.id)}">開く</button>
      ${own ? `<button type="button" class="mn-btn mn-btn-sm mn-btn-danger" data-mat-del="${esc(mat.id)}">削除</button>` : ''}</span>
    </li>`;
  }).join('');
  const sending = Array.from(run.values()).map((r) => `<li class="mn-mat-row mn-mat-wait"><span class="mn-mat-icon" aria-hidden="true">⏳</span><span class="mn-mat-name">${esc(r.name)}</span><span class="mn-muted mn-mat-meta">${esc(r.text)}</span></li>`).join('');
  const full = items.length + run.size >= MAX_FILES;

  container.innerHTML = `<section class="mn-mat">
    <div class="mn-row mn-mat-head"><h2>資料</h2>
      ${own ? `<label class="mn-btn mn-btn-sm mn-mat-add${full ? ' is-disabled' : ''}">資料を追加
        <input type="file" accept=".pdf,.pptx,.xlsx" data-mat-file hidden ${full ? 'disabled' : ''}></label>` : ''}</div>
    ${items.length || run.size ? `<ul class="mn-mat-list">${rows}${sending}</ul>` : '<p class="mn-muted">資料はまだありません。</p>'}
    ${own ? `<div class="mn-mat-foot">
      <button type="button" class="mn-btn" data-mat-regen ${items.length && !busy ? '' : 'disabled'}>資料を踏まえて議事録を作り直す</button>
      <p class="mn-muted">PDF / pptx / xlsx を 1 件 20MB、${MAX_FILES} 件まで。<br>※ PowerPoint の図が重要なときは、PDF で書き出したものも添付してください。<br>※ 古い形式（.ppt / .xls）は読めません。.pptx / .xlsx に保存し直すか、PDF にしてください。</p></div>` : ''}
  </section>`;

  const rerender = () => { if (container.isConnected) renderMaterials(container, minute, { onChanged }); };
  repaints.set(id, rerender);

  const changed = async () => { if (onChanged) await onChanged(); };

  async function add(file) {
    let kind;
    try { kind = materialKind(file.name); } catch (e) { toast(e.message, 'error'); return; }
    if (file.size > MAX_BYTES) { toast('20MB までの資料を添付できます。', 'error'); return; }
    if (items.length + run.size >= MAX_FILES) { toast(`資料は ${MAX_FILES} 件までです。`, 'error'); return; }
    const key = `${Date.now()}-${Math.random()}`;
    const set = (text) => { run.set(key, { name: file.name, text }); const f = repaints.get(id); if (f) f(); };
    set(kind === 'pdf' ? '送信中…' : '展開中…');
    try {
      let extract = null;
      if (kind !== 'pdf') extract = await extractMaterial(file);
      const json = extract ? new Blob([JSON.stringify(extract)], { type: 'application/json' }) : null;
      set('送信中…');
      const r = await api.post(`/api/minutes/${id}/materials`, { name: file.name, kind, size: file.size, hasExtract: !!json });
      await api.upload(r.file.url, file, r.file.headers || {});
      if (json && r.extract) await api.upload(r.extract.url, json, r.extract.headers || {});
      const pages = extract ? (extract.slides || extract.sheets || []).length : extract && extract.pages;
      const doneBody = { extracted: !!json };
      const pageCount = kind === 'pdf' ? undefined : pages;
      if (pageCount) doneBody.pages = pageCount;
      await api.put(`/api/minutes/${id}/materials/${r.id}/done`, doneBody);
      const n = chartsOf(extract);
      if (n) chartCounts.set(`${id}/${r.id}`, n);
      toast('資料を追加しました');
    } catch (e) {
      toast(`${file.name}: ${errMessage(e)}`, 'error');
    } finally {
      run.delete(key);
      if (!run.size) inflight.delete(id);
    }
    await changed();
    const f = repaints.get(id); if (f) f();
  }

  async function open(matId, btn) {
    btn.disabled = true;
    // ポップアップが遮断されないよう、await の前にタブを開いておく
    const w = window.open('about:blank', '_blank');
    try {
      const r = await api.get(`/api/minutes/${id}/materials/${matId}/url`);
      if (w) { w.opener = null; w.location.href = r.url; } else window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      if (w) w.close();
      toast(errMessage(e), 'error');
    } finally { if (btn.isConnected) btn.disabled = false; }
  }

  container.querySelector('[data-mat-file]')?.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) add(f);
  });
  container.querySelectorAll('[data-mat-open]').forEach((b) => b.addEventListener('click', () => open(b.dataset.matOpen, b)));
  container.querySelectorAll('[data-mat-del]').forEach((b) => b.addEventListener('click', async () => {
    const mat = items.find((x) => x.id === b.dataset.matDel);
    if (!(await ask(`「${mat ? mat.name : '資料'}」を削除します。元に戻せません。`, { okLabel: '削除する', danger: true }))) return;
    b.disabled = true;
    try { await api.del(`/api/minutes/${id}/materials/${b.dataset.matDel}`); toast('削除しました'); await changed(); } catch (e) { toast(errMessage(e), 'error'); b.disabled = false; }
  }));
  const regen = container.querySelector('[data-mat-regen]');
  if (regen) {
    regen.addEventListener('click', async () => {
      if (!(await ask('追加した資料と文字起こしの両方から、議事録を作り直します。前の内容は「前の内容に戻す」で戻せます。', { okLabel: '作り直す' }))) return;
      regen.disabled = true;
      try { await api.post(`/api/minutes/${id}/regenerate`, { target: 'summary', withMaterials: true }); toast('作り直しを始めました'); await changed(); } catch (e) { toast(errMessage(e), 'error'); regen.disabled = false; }
    });
  }
}
