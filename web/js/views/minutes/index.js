// 議事録の画面の入口。main.js がこの 2 つを呼ぶ。
import { registerRoute } from '../../router.js';
import { state } from '../../state.js';
import { renderList } from './list.js';
import { renderNew, hasActiveSession } from './new.js';
import { renderDetail } from './detail.js';

export function registerMinutesRoutes() {
  // '/minutes/new' を '/minutes/:id' より先に登録する（後だと 'new' が ID として拾われる）
  registerRoute('/minutes', renderList);
  registerRoute('/minutes/new', renderNew);
  registerRoute('/minutes/:id', renderDetail);
}

// 名刺を探す画面の下段。スマホでは画面の下に固定する（CSS 側）。
export function renderHomeMinutesBar(container) {
  if (state.config && state.config.features && state.config.features.minutes === false) return;
  const bar = document.createElement('div');
  bar.className = 'mn-homebar';
  const rec = hasActiveSession();
  bar.innerHTML = `<a class="mn-btn mn-btn-primary mn-btn-lg" href="/minutes/new">${rec ? '🔴 録音中の画面に戻る' : '🎙 議事録を作る'}</a>
    <a class="mn-btn mn-btn-lg" href="/minutes">議事録の一覧</a>`;
  container.appendChild(bar);
  // 固定バーが一覧の最後を隠さないよう、余白の目印を付ける
  container.classList.add('mn-has-homebar');
}
