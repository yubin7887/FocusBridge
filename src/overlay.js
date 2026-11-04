// 개발용 디버그 표시: 이름 누락 요소에 빨간 테두리 + 번호 배지를 그린다.
// 배지는 <body> 밖(<html> 바로 아래)에 붙여서 MutationObserver 재검사를 유발하지 않고,
// aria-hidden으로 스크린리더에도 보이지 않게 한다.
const COLORS = { empty: '#e5221a', meaningless: '#f08c00' };

let layer = null;
let items = [];   // { el, status, n, badge }
let enabled = true;
let raf = 0;

function ensureLayer() {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.setAttribute('data-fb-ignore', '');
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647',
  });
  document.documentElement.appendChild(layer);
  return layer;
}

function place() {
  raf = 0;
  for (const it of items) {
    const r = it.el.getBoundingClientRect();
    const box = it.badge;
    const hidden = r.width === 0 && r.height === 0;
    // 크기 0 요소는 위치만 점으로 표시
    Object.assign(box.style, {
      display: enabled ? 'block' : 'none',
      left: `${r.left}px`, top: `${r.top}px`,
      width: `${Math.max(r.width, 4)}px`, height: `${Math.max(r.height, 4)}px`,
      outline: `3px ${hidden ? 'dotted' : 'solid'} ${COLORS[it.status]}`,
    });
  }
}

function schedule() { if (!raf) raf = requestAnimationFrame(place); }

/** @param {{element: Element, status: string}[]} missing */
export function showOverlay(missing) {
  const l = ensureLayer();
  l.replaceChildren();
  items = missing.map((m, i) => {
    const badge = document.createElement('div');
    Object.assign(badge.style, { position: 'fixed', boxSizing: 'border-box' });
    const tag = document.createElement('span');
    tag.textContent = `${i + 1}`;
    Object.assign(tag.style, {
      position: 'absolute', top: '-14px', left: '-3px',
      background: COLORS[m.status], color: '#fff',
      font: 'bold 11px/14px system-ui, sans-serif', padding: '0 4px', borderRadius: '3px',
    });
    badge.appendChild(tag);
    l.appendChild(badge);
    return { el: m.element, status: m.status, badge };
  });
  place();
}

window.addEventListener('scroll', schedule, true); // true: 내부 스크롤 영역(캐러셀 등)도 포함
window.addEventListener('resize', schedule);

// Alt(Option) + Shift + F 로 표시 켜기/끄기
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && e.code === 'KeyF') {
    enabled = !enabled;
    place();
  }
});
