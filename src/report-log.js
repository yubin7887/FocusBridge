export function createReportLogger(output = console) {
  let lastSnapshot;
  return (result, fingerprints, elapsed, frame) => {
    const { targets, missing, report, pageUrl, previousStatus } = result;
    const rows = report.map((entry, index) => ({
      no: index + 1, status: entry.status, role: entry.role, name: entry.currentName,
      previousMatch: previousStatus === 'skipped' ? 'skipped'
        : !fingerprints[index]?.eligible ? 'ineligible'
        : previousStatus !== 'ok' ? previousStatus
        : entry.match.source === 'previous' ? 'hit' : 'miss',
      previousReason: fingerprints[index]?.reason,
      match: entry.match.source ?? (entry.match.decision === 'confirm' ? 'rule' : entry.match.decision),
      reused: (entry.match.source === 'ai' || entry.match.decision === 'ai') && typeof entry.aiReused === 'boolean'
        ? entry.aiReused : '-',
      label: entry.match.label,
      selector: entry.selector,
    }));
    // Compare visible results, not timing, scan IDs, DOM identities, or other request metadata.
    const snapshot = JSON.stringify({ pageUrl, frame, targets: targets.length, rows });
    if (snapshot === lastSnapshot) return false;
    lastSnapshot = snapshot;
    output.groupCollapsed(
      `[FocusBridge] ${frame} ${pageUrl.slice(0, 80)} 대상 ${targets.length}개 / 이름 누락 ${missing.length}개 (${elapsed.toFixed(1)}ms)`
    );
    output.table(rows);
    missing.forEach((item, index) => output.log(`#${index + 1}`, item.status, item.element));
    output.groupEnd();
    return true;
  };
}
