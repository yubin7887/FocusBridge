import { checkName, isUnhelpfulGeneratedName } from './detector.js';
import { TARGET_ROLES } from './collector.js';

// Track exactly the attributes we wrote so that later page changes retain ownership.
export function createLabelController() {
  const applied = new Map();
  const writes = new WeakMap();

  function write(element, attr, value) {
    const oldValue = element.getAttribute(attr);
    if (value === oldValue) return;
    if (element.isConnected) {
      let queue = writes.get(element);
      if (!queue) writes.set(element, queue = []);
      queue.push({ attr, oldValue });
    }
    if (value === null) element.removeAttribute(attr);
    else element.setAttribute(attr, value);
  }

  function ownMutation(record) {
    if (record.type !== 'attributes') return false;
    const queue = writes.get(record.target);
    if (!queue?.length) return false;
    const { attr, oldValue } = queue[0];
    if (record.attributeName !== attr || record.oldValue !== oldValue) return false;
    queue.shift();
    return true;
  }

  function restore(element, changes) {
    for (const { attr, before, after } of changes) {
      if (element.getAttribute(attr) === after) write(element, attr, before);
    }
  }

  function restoreAll() {
    for (const [element, changes] of applied) restore(element, changes);
    applied.clear();
  }

  function keepOnly(elements) {
    if (!applied.size) return;
    const keep = new Set(elements);
    for (const [element, changes] of applied) {
      if (keep.has(element)) continue;
      restore(element, changes);
      applied.delete(element);
    }
  }

  function withOriginalLabels(read) {
    if (!applied.size) return read();
    const restorable = [];
    for (const [element, changes] of applied) {
      if (element.isConnected && changes.every(({ attr, after }) => element.getAttribute(attr) === after)) {
        restorable.push([element, changes]);
      }
      restore(element, changes);
    }
    applied.clear();
    try {
      return read();
    } finally {
      for (const [element, changes] of restorable) {
        if (!element.isConnected || !changes.every(({ attr, before }) => element.getAttribute(attr) === before)) continue;
        for (const { attr, after } of changes) write(element, attr, after);
        applied.set(element, changes);
      }
    }
  }

  function apply(element, match, expected) {
    if (!element?.isConnected || match?.decision !== 'confirm') return false;
    const label = typeof match.label === 'string' ? match.label.trim().replace(/\s+/g, ' ') : '';
    const oldChanges = applied.get(element);
    if (oldChanges) {
      if (element.getAttribute('aria-label') === label
        && oldChanges.every(({ attr, after }) => element.getAttribute(attr) === after)
        && checkName(element).name === label) return true;
      restore(element, oldChanges);
      applied.delete(element);
    }
    if (!label || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label)) return false;
    if (match.source === 'ai' && isUnhelpfulGeneratedName(label)) return false;
    const current = checkName(element);
    if (!TARGET_ROLES.has(current.role) || current.status === 'ok'
      || current.role !== expected.role || current.name !== expected.name || current.status !== expected.status) return false;

    const changes = [];
    const set = (attr, after) => {
      const before = element.getAttribute(attr);
      if (before === after) return;
      changes.push({ attr, before, after });
      write(element, attr, after);
    };
    set('aria-label', label);
    // A valid aria-labelledby reference takes precedence over aria-label.
    if (checkName(element).name !== label && element.hasAttribute('aria-labelledby')) set('aria-labelledby', null);
    const named = checkName(element);
    // A verified explicit label can be short even when the original control contains hidden text.
    const repairedHiddenName = named.reason === 'hidden-name' && label !== current.name;
    if (named.name !== label || (named.status !== 'ok' && !repairedHiddenName)) {
      restore(element, changes);
      return false;
    }
    applied.set(element, changes);
    return true;
  }

  function applyMatches(missing, report) {
    for (let i = 0; i < missing.length; i++) {
      const match = report[i]?.match;
      if (match?.decision === 'confirm') report[i].labelApplied = apply(missing[i].element, match, missing[i]);
    }
  }

  return { applyMatches, keepOnly, ownMutation, restoreAll, withOriginalLabels };
}
