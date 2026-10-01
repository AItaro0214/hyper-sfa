// 議事録の画面の入口。main.js がこの 2 つを呼ぶ。
import { registerRoute } from '../../router.js';
import { state } from '../../state.js';
import { icon } from '../../icons.js';
import { renderList } from './list.js';
import { renderNew, hasActiveSession } from './new.js';
import { renderDetail } from './detail.js';

export function registerMinutesRoutes() {
  // '/minutes/new' を '/minutes/:id' より先に登録する（後だと 'new' が ID として拾われる）
  registerRoute('/minutes', renderList);
  registerRoute('/minutes/new', renderNew);
  registerRoute('/minutes/:id', renderDetail);
}

// 名刺を探す画面の見出しの右に置く入口。スマホでは下部ナビの「議事録」に統合するので、CSS 側で隠す。
export function renderHomeMinutesBar(container) {
  if (!container) return;
  if (state.config && state.config.features && state.config.features.minutes === false) return;
  const bar = document.createElement('div');
  bar.className = 'mn-homebar';
  const rec = hasActiveSession();
  bar.innerHTML = `<a class="mn-btn mn-btn-primary" href="/minutes/new">${icon('mic', 18)}${rec ? '録音中の画面に戻る' : '議事録を作る'}</a>
    <a class="mn-btn" href="/minutes">議事録の一覧</a>`;
  container.appendChild(bar);
}
