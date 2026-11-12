import { getRole } from 'dom-accessibility-api';

const sensitive = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [hidden], [aria-hidden="true"], script, style, template';

function clean(value, max = 120) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted]')
    .replace(/(?:\+?\d[\d() .-]{6,}\d)/g, '[redacted]')
    .replace(/\b[a-z0-9_-]{24,}\b/gi, '[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

function pathOnly(value, base) {
  if (!value) return undefined;
  if (/^#[\w-]{1,80}$/.test(value)) return clean(value);
  try {
    const url = new URL(value, base);
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) return undefined;
    return clean(decodeURIComponent(url.pathname), 150);
  } catch { return undefined; }
}

function compact(values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function visibleText(element, max = 100) {
  if (!element || element.matches(sensitive)) return undefined;
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let i = 0; i < 40 && text.length < max * 2; i++) {
    const node = walker.nextNode();
    if (!node) break;
    if (!node.parentElement?.closest(sensitive)) text += ' ' + node.data.slice(0, max);
  }
  return clean(text, max);
}

export function buildAiEvidence(element, entry) {
  const doc = element.ownerDocument;
  const attrs = (...names) => compact(Object.fromEntries(names.map((name) => [name, clean(element.getAttribute(name))])));
  const attr = (name) => clean(element.getAttribute(name));
  const icon = element.querySelector('svg, img, i, [class*="icon"]');
  const ref = icon?.querySelector('use');
  const area = element.closest('section, nav, main, header, footer, aside, [role="region"]');
  const controls = [];
  const root = element.getRootNode();
  for (const id of (element.getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)) {
    const target = root.getElementById(id);
    if (!target || target.matches('input, textarea, select, [contenteditable]')) continue;
    const heading = target.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    const references = (target.getAttribute('aria-labelledby') || '').split(/\s+/)
      .filter(Boolean).slice(0, 2).map((reference) => visibleText(root.getElementById(reference))).filter(Boolean);
    const targetName = references.join(' ') || target.getAttribute('aria-label');
    const linked = compact({ role: clean(getRole(target)), name: clean(targetName),
      title: clean(target.getAttribute('title')) || visibleText(heading) });
    if (linked) controls.push(linked);
  }
  const parent = element.parentElement;
  return compact({
    tagName: element.localName, role: clean(entry.role), type: attr('type'),
    currentName: clean(entry.currentName), status: entry.status,
    text: visibleText(element),
    attributes: attrs('title', 'aria-description', 'aria-haspopup', 'data-action', 'data-command', 'data-type', 'id', 'class'),
    state: compact({ disabled: element.disabled === true ? true : undefined,
      ...attrs('aria-disabled', 'aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected') }),
    destination: compact({
      href: pathOnly(element.getAttribute('href'), element.baseURI),
      formAction: pathOnly(element.getAttribute('formaction') || (element.type === 'submit' && element.form?.getAttribute('action')), element.baseURI),
    }),
    icon: icon && compact({
      title: clean(icon.querySelector('title')?.textContent), alt: clean(icon.getAttribute('alt')),
      src: pathOnly(icon.getAttribute('src'), element.baseURI),
      reference: pathOnly(ref?.getAttribute('href') || ref?.getAttribute('xlink:href'), element.baseURI),
      className: clean(icon.getAttribute('class')),
    }) || undefined,
    context: compact({
      heading: visibleText(area?.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')),
      parentText: clean([...parent?.childNodes || []].filter((n) => n.nodeType === 3)
        .slice(0, 8).map((n) => n.data.slice(0, 100)).join(' ')),
      previousText: visibleText(element.previousElementSibling),
      nextText: visibleText(element.nextElementSibling),
    }),
    controls: controls.length ? controls : undefined,
    page: compact({ title: clean(doc.title), lang: clean(doc.documentElement.lang, 24) }),
  });
}
