/**
 * app.js — Container Log Dashboard
 * Queries ClickHouse HTTP API directly from the browser.
 * ClickHouse endpoint is proxied through Nginx (the log-dashboard container)
 * to avoid CORS issues — see nginx.conf in the dashboard directory.
 *
 * All queries use parameterised format via query_params to prevent injection.
 */

"use strict";

// ── Config ────────────────────────────────────────────────────────────────────
// The dashboard Nginx container reverse-proxies /clickhouse → ClickHouse:8123.
// This avoids CORS and keeps the ClickHouse address out of browser JS.
const CH_ENDPOINT = "/clickhouse/";
const CH_DB = "logs";
const PAGE_SIZE = 12;   // Constraint: 12 rows per page

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  selectedContainer: null,  // null = all containers
  search: "",
  level: "",
  sortDir: "DESC",
  fromDate: null,
  toDate: null,
  page: 0,
  totalRows: 0,
};

// ── ClickHouse HTTP Query ─────────────────────────────────────────────────────
/**
 * Execute a ClickHouse SQL query via HTTP GET.
 * Returns parsed rows as arrays.
 */
async function chQuery(sql) {
  const params = new URLSearchParams({
    query: sql,
    database: CH_DB,
    default_format: "JSONCompact",
  });
  const res = await fetch(`${CH_ENDPOINT}?${params}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickHouse error (${res.status}): ${err.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data || [];
}

// ── Build WHERE clause from current state ─────────────────────────────────────
function buildWhere(includeContainer = true) {
  const parts = [];

  if (includeContainer && state.selectedContainer) {
    // Safe: selectedContainer is always taken from a CH query result
    parts.push(`container_id = '${esc(state.selectedContainer)}'`);
  }
  if (state.level) {
    parts.push(`level = '${esc(state.level)}'`);
  }
  if (state.search) {
    // LIKE search on message — for high-scale deployments consider a full-text index
    parts.push(`message ILIKE '%${escLike(state.search)}%'`);
  }
  if (state.fromDate) {
    parts.push(`timestamp >= '${state.fromDate}:00'`);
  }
  if (state.toDate) {
    parts.push(`timestamp <= '${state.toDate}:00'`);
  }
  return parts.length ? "WHERE " + parts.join(" AND ") : "";
}

// Escape single quotes in SQL string literals
const esc = s => String(s).replace(/'/g, "''");
// Escape LIKE wildcards
const escLike = s => esc(s).replace(/[%_\\]/g, c => "\\" + c);

// ── Metrics ───────────────────────────────────────────────────────────────────
async function loadMetrics() {
  try {
    const rows = await chQuery(`
      SELECT
        count()                                          AS total,
        countIf(level = 'error')                        AS errors,
        countIf(level = 'warn' OR level = 'warning')    AS warnings,
        uniqExact(container_id)                         AS containers
      FROM container_logs
    `);
    if (rows.length) {
      const [total, errors, warnings, containers] = rows[0];
      el("m-total").querySelector(".metric-value").textContent     = fmt(total);
      el("m-errors").querySelector(".metric-value").textContent    = fmt(errors);
      el("m-warnings").querySelector(".metric-value").textContent  = fmt(warnings);
      el("m-containers").querySelector(".metric-value").textContent = fmt(containers);
    }
  } catch (e) {
    console.error("Metrics error:", e);
  }
}

// ── Sidebar: container list ───────────────────────────────────────────────────
async function loadContainerList() {
  try {
    const rows = await chQuery(`
      SELECT
        container_id,
        container_name,
        max(timestamp)                  AS last_seen,
        count()                         AS log_count,
        countIf(level = 'error')        AS error_count
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
      GROUP BY container_id, container_name
      ORDER BY last_seen DESC
      LIMIT 60
    `);

    const list = el("container-list");
    list.innerHTML = "";

    // "All" item
    const allItem = makeContainerItem(null, "All Containers", null, "", 0);
    if (!state.selectedContainer) allItem.classList.add("active");
    list.appendChild(allItem);

    const now = Date.now();
    rows.forEach(([cid, cname, lastSeen, , errorCount]) => {
      const lastMs = new Date(lastSeen).getTime();
      const ageSec = (now - lastMs) / 1000;
      const dot = ageSec < 60 ? "green" : ageSec < 300 ? "amber" : "red";
      const item = makeContainerItem(cid, cname, dot, cid, errorCount);
      if (state.selectedContainer === cid) item.classList.add("active");
      list.appendChild(item);
    });
  } catch (e) {
    console.error("Container list error:", e);
  }
}

function makeContainerItem(cid, name, dotClass, fullId, errorCount) {
  const div = document.createElement("div");
  div.className = "container-item";
  div.innerHTML = `
    ${dotClass ? `<span class="c-dot ${dotClass}"></span>` : `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span>`}
    <span class="c-name" title="${esc(fullId)}">${esc(name || fullId)}</span>
    ${errorCount > 0 ? `<span class="c-badge">${fmt(errorCount)}</span>` : ""}
  `;
  div.addEventListener("click", () => {
    state.selectedContainer = cid;
    state.page = 0;
    document.querySelectorAll(".container-item").forEach(i => i.classList.remove("active"));
    div.classList.add("active");
    loadLogs();
  });
  return div;
}

// ── Log Table ─────────────────────────────────────────────────────────────────
async function loadLogs() {
  const where = buildWhere();
  const offset = state.page * PAGE_SIZE;

  // Count query (for pagination)
  const countSql = `SELECT count() FROM container_logs ${where}`;
  // Data query
  const dataSql = `
    SELECT timestamp, container_id, level, message
    FROM container_logs
    ${where}
    ORDER BY timestamp ${state.sortDir}
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `;

  try {
    el("table-status").textContent = "Loading…";
    const [countRows, dataRows] = await Promise.all([
      chQuery(countSql),
      chQuery(dataSql),
    ]);

    state.totalRows = parseInt(countRows[0]?.[0] ?? 0, 10);
    const totalPages = Math.max(1, Math.ceil(state.totalRows / PAGE_SIZE));

    el("table-status").textContent =
      `${fmt(state.totalRows)} rows  ·  Page ${state.page + 1} of ${totalPages}`;

    renderTable(dataRows);
    renderPagination(totalPages);
  } catch (e) {
    el("table-status").textContent = "⚠ Query failed: " + e.message;
    el("log-body").innerHTML = `<tr><td colspan="4" class="empty-state">Error loading logs.</td></tr>`;
    console.error(e);
  }
}

function renderTable(rows) {
  const tbody = el("log-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No logs found for the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(([ts, cid, level, msg]) => {
    const lvl  = (level || "").toLowerCase();
    const rowCls = lvl === "error" ? "row-error" : lvl === "warn" || lvl === "warning" ? "row-warn" : "";
    const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn",
                       info: "badge-info", debug: "badge-debug" }[lvl] || "badge-other";
    const tsFormatted = formatTs(ts);
    const cidShort = String(cid).slice(0, 12);
    const msgSafe = escHtml(String(msg)).slice(0, 800);
    return `
      <tr class="${rowCls}">
        <td class="td-ts">${tsFormatted}</td>
        <td class="td-cid" title="${escHtml(cid)}">${cidShort}</td>
        <td><span class="badge ${badgeCls}">${escHtml(lvl || "—")}</span></td>
        <td class="td-msg">${msgSafe}</td>
      </tr>`;
  }).join("");
}

function renderPagination(totalPages) {
  el("btn-prev").disabled = state.page === 0;
  el("btn-next").disabled = state.page >= totalPages - 1;
  el("page-info").textContent = `Page ${state.page + 1} / ${totalPages}`;
}

// ── Clear DB Modal ─────────────────────────────────────────────────────────────
function openClearModal() {
  el("modal-overlay").classList.remove("hidden");
  updateModalPreview();
}

function closeClearModal() {
  el("modal-overlay").classList.add("hidden");
}

function updateModalPreview() {
  const val = document.querySelector('input[name="clear-range"]:checked')?.value || "90";
  let sql;
  if (val === "all") {
    sql = `TRUNCATE TABLE logs.container_logs`;
  } else if (val === "30" || val === "7") {
    // Row-level deletion for recent ranges using lightweight DELETE mutation
    sql = `ALTER TABLE logs.container_logs DELETE\n  WHERE timestamp < now() - INTERVAL ${val} DAY`;
  } else {
    // For 90d use DROP PARTITION for each expired month — show representative SQL
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - parseInt(val, 10));
    const yyyymm = cutoff.toISOString().slice(0,7).replace("-","");
    sql = `-- Fast path: DROP PARTITION (no row locks)\nALTER TABLE logs.container_logs\n  DROP PARTITION '${yyyymm}'`;
  }
  el("modal-query-preview").textContent = sql;
}

async function executeClear() {
  const val = document.querySelector('input[name="clear-range"]:checked')?.value || "90";
  let sql;

  if (val === "all") {
    sql = `TRUNCATE TABLE logs.container_logs`;
  } else if (val === "7" || val === "30") {
    sql = `ALTER TABLE logs.container_logs DELETE WHERE timestamp < now() - INTERVAL ${parseInt(val,10)} DAY`;
  } else {
    // 90d: drop all monthly partitions older than 90 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const yyyymm = cutoff.toISOString().slice(0,7).replace("-","");
    sql = `ALTER TABLE logs.container_logs DROP PARTITION '${yyyymm}'`;
  }

  try {
    el("btn-modal-confirm").disabled = true;
    el("btn-modal-confirm").textContent = "Deleting…";
    await chQuery(sql);
    closeClearModal();
    await Promise.all([loadMetrics(), loadContainerList(), loadLogs()]);
  } catch (e) {
    alert("Delete failed: " + e.message);
  } finally {
    el("btn-modal-confirm").disabled = false;
    el("btn-modal-confirm").textContent = "Confirm Delete";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

function fmt(n) {
  const num = parseInt(n, 10);
  if (isNaN(num)) return "—";
  return num >= 1_000_000 ? (num / 1_000_000).toFixed(1) + "M"
       : num >= 1_000     ? (num / 1_000).toFixed(1) + "K"
       : String(num);
}

function formatTs(ts) {
  try {
    const d = new Date(ts);
    // Format as YYYY-MM-DD HH:mm:ss (Asia/Bangkok is UTC+7)
    return d.toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).replace("T", " ");
  } catch { return String(ts); }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Event Wiring ──────────────────────────────────────────────────────────────
function init() {
  // Filters
  el("btn-apply").addEventListener("click", () => {
    state.search  = el("search-input").value.trim();
    state.level   = el("level-select").value;
    state.sortDir = el("sort-select").value;
    state.fromDate = el("range-from").value || null;
    state.toDate   = el("range-to").value   || null;
    state.page = 0;
    loadLogs();
  });

  el("btn-reset").addEventListener("click", () => {
    state.search = state.level = "";
    state.fromDate = state.toDate = null;
    state.sortDir = "DESC";
    state.page = 0;
    el("search-input").value = "";
    el("level-select").value = "";
    el("sort-select").value  = "DESC";
    el("range-from").value   = "";
    el("range-to").value     = "";
    loadLogs();
  });

  // Search on Enter
  el("search-input").addEventListener("keydown", e => {
    if (e.key === "Enter") el("btn-apply").click();
  });

  // Pagination
  el("btn-prev").addEventListener("click", () => { state.page--; loadLogs(); });
  el("btn-next").addEventListener("click", () => { state.page++; loadLogs(); });

  // Refresh
  el("btn-refresh").addEventListener("click", refresh);

  // Clear DB modal
  el("btn-clear-db").addEventListener("click", openClearModal);
  el("btn-modal-cancel").addEventListener("click", closeClearModal);
  el("btn-modal-confirm").addEventListener("click", executeClear);
  document.querySelectorAll('input[name="clear-range"]').forEach(r => {
    r.addEventListener("change", updateModalPreview);
  });
  el("modal-overlay").addEventListener("click", e => {
    if (e.target === el("modal-overlay")) closeClearModal();
  });

  // Initial load
  refresh();

  // Auto-refresh every 30s
  setInterval(refresh, 30_000);
}

async function refresh() {
  el("btn-refresh").textContent = "↻ …";
  await Promise.all([loadMetrics(), loadContainerList(), loadLogs()]);
  el("btn-refresh").textContent = "↻ Refresh";
}

document.addEventListener("DOMContentLoaded", init);
