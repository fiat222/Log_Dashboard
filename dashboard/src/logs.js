(function () {
  "use strict";

  let deps = {};

  function init(nextDeps = {}) {
    deps = { ...deps, ...nextDeps };
  }

  function normalizeLevel(level, message) {
    let lvl = (level || "").toLowerCase();
    const scanLimit = deps.levelScanLimit || 200;
    if (lvl === "info" || lvl === "debug" || lvl === "—" || !lvl) {
      const msgUpper = String(message || "").slice(0, scanLimit).toUpperCase();
      if (msgUpper.includes("ERR") || msgUpper.includes("ERROR")) lvl = "error";
      else if (msgUpper.includes("WARN") || msgUpper.includes("WARNING") || msgUpper.includes("WRN")) lvl = "warn";
    }
    return lvl;
  }

  function badgeClass(level) {
    return {
      error: "badge-error",
      warn: "badge-warn",
      warning: "badge-warn",
      info: "badge-info",
      debug: "badge-debug",
    }[level] || "badge-other";
  }

  function rowClass(level, extraClass = "") {
    const severityClass = level === "error" ? "row-error"
      : (level === "warn" || level === "warning") ? "row-warn"
        : "";
    return [severityClass, extraClass].filter(Boolean).join(" ");
  }

  function displayContainerName(containerName) {
    const aliases = deps.containerAliasesProvider?.() || {};
    return aliases[containerName] || containerName;
  }

  function renderLogRowHtml(row, options = {}) {
    const [ts, cname, level, msg, traceId] = row;
    const lvl = normalizeLevel(level, msg);
    const escHtml = deps.escHtml || (value => String(value));
    const ansiToHtml = deps.ansiToHtml || escHtml;
    const formatTs = deps.formatTs || (value => String(value));
    const previewLimit = deps.messagePreviewLimit || 1000;
    const displayName = displayContainerName(cname);
    const cls = rowClass(lvl, options.extraClass || "");
    const msgHtml = ansiToHtml(String(msg).slice(0, previewLimit));
    const tsAttr = escHtml(String(ts));
    const cnameAttr = escHtml(String(cname));
    const actions = options.actions === false ? "" : `<button class="btn-ctx" data-ts="${tsAttr}" data-cname="${cnameAttr}" title="Trace surrounding logs (±30s)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px;"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>Trace</button>${traceId ? `<button class="btn-tid" data-tid="${escHtml(traceId)}" title="TraceId Correlation: all logs with trace ${escHtml(traceId)}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>Link</button>` : ""}`;

    return `<tr class="${cls}">
      <td class="td-ts">${formatTs(ts)}</td>
      <td class="td-cid" title="${escHtml(cname)}">${escHtml(displayName)}</td>
      <td><span class="badge ${badgeClass(lvl)}">${escHtml(lvl || "—")}</span></td>
      <td class="td-msg">${msgHtml}</td>
      <td class="td-ctx">${actions}</td>
    </tr>`;
  }

  function trimTableRows(tbody, limit) {
    if (!tbody || !Number.isFinite(limit) || limit <= 0) return;
    while (tbody.rows.length > limit) tbody.deleteRow(tbody.rows.length - 1);
  }

  window.LogDashLogs = {
    init,
    normalizeLevel,
    renderLogRowHtml,
    trimTableRows,
  };
})();
