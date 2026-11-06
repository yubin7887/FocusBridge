// 옛 수집 데이터 보정용: dataAttrs 필드가 생기기 전(2026-11-04, 11-06)에 모은 데이터는
// html(요소 HTML 앞 300자)에서 "요소 자신의 여는 태그"만 잘라 data- 속성을 뽑아 채운다.
// content.js의 extractContext()와 같은 규칙: 최대 10개, 값은 50자까지.
// 한계: 여는 태그가 300자 안에서 끝나지 않으면 뒤쪽 속성은 못 본다.

function openTag(html) {
  let quote = null;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return html.slice(0, i + 1);
  }
  return html;
}

export function dataAttrsFromHtml(html) {
  const out = {};
  const re = /\s(data-[A-Za-z0-9_:.-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of openTag(html || '').matchAll(re)) {
    if (Object.keys(out).length >= 10) break;
    out[m[1]] = (m[2] ?? m[3] ?? m[4] ?? '').slice(0, 50);
  }
  return out;
}

/** 수집 데이터 items에 dataAttrs가 없으면 html에서 채운다 (있으면 그대로 둔다) */
export function withDataAttrs(items) {
  return items.map((it) => (it.context && it.context.dataAttrs !== undefined)
    ? it
    : { ...it, context: { ...it.context, dataAttrs: dataAttrsFromHtml(it.html) } });
}
