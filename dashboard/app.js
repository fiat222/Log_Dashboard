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

/**
 * Execute a DDL/DML statement (TRUNCATE, ALTER DELETE, etc.) via HTTP POST.
 * ClickHouse only accepts write statements via POST, not GET.
 */
async function chExec(sql, authKey) {
  const params = new URLSearchParams({ database: CH_DB });
  const res = await fetch(`/clickhouse-admin/?${params}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-ClickHouse-Key": authKey || ""
    },
    body: sql,
  });
  if (!res.ok) {
    const err = await res.text();
    // Return the response object to handle auth errors carefully
    throw { status: res.status, message: `ClickHouse error (${res.status}): ${err.slice(0, 200)}` };
  }
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
// Escape HTML to prevent XSS


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

// ── State & Storage ─────────────────────────────────────────────────────────────
const STORAGE = {
  getStacks: () => {
    try { 
      let s = JSON.parse(localStorage.getItem("logpipe_custom_stacks"));
      if (!s) throw new Error("empty");
      if (!s["⭐ Watched"]) s["⭐ Watched"] = []; // Ensure Watched exists
      return s;
    } catch { return { "⭐ Watched": [] }; }
  },
  saveStacks: (s) => localStorage.setItem("logpipe_custom_stacks", JSON.stringify(s)),
  
  getAliases: () => {
    try { return JSON.parse(localStorage.getItem("logpipe_aliases") || "{}"); } 
    catch { return {}; }
  },
  saveAliases: (a) => localStorage.setItem("logpipe_aliases", JSON.stringify(a)),
};

let lastSidebarRows = [];

async function loadContainerList() {
  try {
    const rows = await chQuery(`
      SELECT
        container_id,
        container_name,
        max(timestamp)                  AS last_seen,
        count()                         AS log_count,
        countIf(level = 'error')        AS error_count,
        if(isValidJSON(labels) AND JSONExtractString(labels, 'com.docker.compose.project') != '', 
           JSONExtractString(labels, 'com.docker.compose.project'), 
           'Other')                     AS compose_project
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
      GROUP BY container_id, container_name, compose_project
      ORDER BY last_seen DESC
      LIMIT 100
    `);
    lastSidebarRows = rows;
    renderSidebar();
  } catch (e) {
    console.error("Container list error:", e);
  }
}

// Global mapped data for lazy rendering
let folderDataMap = {}; 

function renderSidebar() {
  const folderList = el("folder-list");
  folderList.innerHTML = "";
  folderDataMap = {};

  const customStacks = STORAGE.getStacks();
  const aliases = STORAGE.getAliases();

  // Special "All" item
  const allItem = makeContainerItem(null, "All Containers", null, "", 0);
  if (!state.selectedContainer) allItem.classList.add("active");
  folderList.appendChild(allItem);

  if (!lastSidebarRows.length) return;

  const now = Date.now();

  // Populate folderDataMap
  lastSidebarRows.forEach(row => {
    const [cid, cname, lastSeen, logCount, errorCount, rawProject] = row;
    const lastMs = new Date(lastSeen).getTime();
    const ageSec = (now - lastMs) / 1000;
    const dot = ageSec < 60 ? "green" : ageSec < 300 ? "amber" : "red";
    
    let displayName = cname;
    if (!displayName || String(displayName).toLowerCase() === "unknown") {
      displayName = String(cid).slice(0, 12);
    }

    const itemData = { cid, displayName, dot, errorCount, fullId: cid };

    // 1. Assign to its default compose stack (with possible alias)
    const displayProject = aliases[rawProject] || rawProject;
    if (!folderDataMap[displayProject]) folderDataMap[displayProject] = [];
    folderDataMap[displayProject].push(itemData);

    // 2. Assign to any Custom Stacks it belongs to
    for (const [stackName, cids] of Object.entries(customStacks)) {
      if (cids.includes(cid)) {
        if (!folderDataMap[stackName]) folderDataMap[stackName] = [];
        folderDataMap[stackName].push(itemData);
      }
    }
  });

  // Ensure all custom stacks exist visually, even if empty
  for (const stackName of Object.keys(customStacks)) {
    if (!folderDataMap[stackName]) folderDataMap[stackName] = [];
  }

  // Render Folders
  const sortedNames = Object.keys(folderDataMap).sort((a,b) => {
    if (a === "⭐ Watched") return -1;
    if (b === "⭐ Watched") return 1;
    return a.localeCompare(b);
  });

  sortedNames.forEach(stackName => {
    const group = document.createElement("div");
    // Only open the "Watched" and the active container's stack by default, others closed to save DOM
    const hasActive = folderDataMap[stackName].some(d => d.cid === state.selectedContainer);
    const isOpen = stackName === "⭐ Watched" || hasActive;
    
    group.className = "folder-group " + (isOpen ? "open" : "");
    group.innerHTML = `
      <div class="folder-header">
        <span class="folder-icon">▶</span>
        <span>${escHtml(stackName)}</span>
        <button class="btn-ghost btn-icon action-rename" title="Rename Stack" style="margin-left:auto; display:none; font-size:10px;">✏️</button>
      </div>
      <div class="folder-children" ${isOpen ? '' : 'data-loaded="false"'} ></div>
    `;

    const header = group.querySelector(".folder-header");
    const childrenContainer = group.querySelector(".folder-children");

    // Rename logic
    header.addEventListener("mouseenter", () => group.querySelector(".action-rename").style.display = "block");
    header.addEventListener("mouseleave", () => group.querySelector(".action-rename").style.display = "none");
    
    group.querySelector(".action-rename").addEventListener("click", (e) => {
      e.stopPropagation();
      const newName = prompt("Rename stack to:", stackName);
      if (newName && newName.trim() !== "" && newName !== stackName) {
        if (customStacks[stackName]) {
          customStacks[newName] = customStacks[stackName];
          delete customStacks[stackName];
          STORAGE.saveStacks(customStacks);
        } else {
          // It's a compose stack, save an alias
          const rawMatches = Object.entries(aliases).filter(([k, v]) => v === stackName);
          if (rawMatches.length) {
            aliases[rawMatches[0][0]] = newName; // update existing alias
          } else {
            aliases[stackName] = newName; // create new alias
          }
          STORAGE.saveAliases(aliases);
        }
        renderSidebar();
      }
    });

    // Lazy load logic
    const renderItems = () => {
      childrenContainer.innerHTML = "";
      if (folderDataMap[stackName].length === 0) {
        childrenContainer.innerHTML = `<div class="empty-watched" style="padding-left:0; font-size:11px;">Empty Stack</div>`;
        return;
      }
      folderDataMap[stackName].forEach(data => {
        const dItem = makeContainerItem(data.cid, data.displayName, data.dot, data.fullId, data.errorCount);
        if (state.selectedContainer === data.cid) dItem.classList.add("active");
        childrenContainer.appendChild(dItem);
      });
      childrenContainer.removeAttribute("data-loaded"); // Mark as loaded
    };

    if (isOpen) renderItems();

    header.addEventListener("click", () => {
      const willOpen = !group.classList.contains("open");
      group.classList.toggle("open");
      if (willOpen && childrenContainer.getAttribute("data-loaded") === "false") {
        renderItems();
      }
    });
    
    folderList.appendChild(group);
  });
}

function selectContainer(cid) {
  state.selectedContainer = cid;
  state.page = 0;
  loadLogs();
  
  if (state.view === "analytics") {
    loadAnalytics(); // Refresh charts if in analytics mode
  }
  
  renderSidebar(); // updates active class
}

function makeContainerItem(cid, name, dotClass, fullId, errorCount) {
  const div = document.createElement("div");
  div.className = "container-item";
  div.innerHTML = `
    ${dotClass ? `<span class="c-dot ${dotClass}"></span>` : `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span>`}
    <span class="c-name" title="${escHtml(fullId)}">${escHtml(name || fullId)}</span>
    ${errorCount > 0 ? `<span class="c-badge">${fmt(errorCount)}</span>` : ""}
    ${cid ? `<span class="c-star" title="Add to Stack">➕</span>` : ""}
  `;
  div.addEventListener("click", () => selectContainer(cid));

  const addBtn = div.querySelector(".c-star");
  if (addBtn) {
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const stacks = STORAGE.getStacks();
      const stackNames = Object.keys(stacks);
      const target = prompt(`Add to which stack?\nAvailable: ${stackNames.join(", ")}`, "⭐ Watched");
      if (target && target.trim() !== "") {
        if (!stacks[target]) stacks[target] = [];
        if (!stacks[target].includes(cid)) stacks[target].push(cid);
        STORAGE.saveStacks(stacks);
        renderSidebar();
      }
    });
  }

  return div;
}

// ── Dashboard Modes & Events ──────────────────────────────────────────────────
el("btn-new-stack").addEventListener("click", () => {
  const name = prompt("Enter new Stack name:");
  if (name && name.trim()) {
    const s = STORAGE.getStacks();
    if (!s[name]) s[name] = [];
    STORAGE.saveStacks(s);
    renderSidebar();
  }
});

el("tab-logs").addEventListener("click", () => {
  state.view = "logs";
  el("tab-logs").classList.add("active");
  el("tab-analytics").classList.remove("active");
  el("logs-view-wrapper").classList.remove("hidden");
  el("analytics-section").classList.add("hidden");
});

el("tab-analytics").addEventListener("click", () => {
  state.view = "analytics";
  el("tab-analytics").classList.add("active");
  el("tab-logs").classList.remove("active");
  el("analytics-section").classList.remove("hidden");
  el("logs-view-wrapper").classList.add("hidden");
  loadAnalytics();
});

// ── Analytics Module ──────────────────────────────────────────────────────────
let chartVol = null;
let chartSev = null;

async function loadAnalytics() {
  if (!window.Chart) {
    console.error("Chart.js not loaded.");
    return;
  }
  
  const cidFilter = state.selectedContainer ? `AND container_id = '${esc(state.selectedContainer)}'` : "";

  try {
    // 1. Volume Chart (Hourly)
    const volData = await chQuery(`
      SELECT 
        toStartOfHour(timestamp) as t,
        count() as total,
        countIf(level = 'error') as errors,
        countIf(level = 'warn' OR level = 'warning') as warnings
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
      ${cidFilter}
      GROUP BY t
      ORDER BY t ASC
    `);

    const labels = volData.map(r => {
      const d = new Date(r[0]);
      return `${String(d.getHours()).padStart(2, '0')}:00`;
    });
    const totalSeries = volData.map(r => r[1]);
    const errorSeries = volData.map(r => r[2]);
    const warnSeries = volData.map(r => r[3]);

    if (chartVol) chartVol.destroy();
    
    Chart.defaults.color = '#64748b';
    Chart.defaults.font.family = "'Inter', sans-serif";

    chartVol = new Chart(document.getElementById('chart-volume'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Errors', data: errorSeries, borderColor: '#e11d48', backgroundColor: 'rgba(225, 29, 72, 0.1)', fill: true, tension: 0.3 },
          { label: 'Warnings', data: warnSeries, borderColor: '#d97706', backgroundColor: 'rgba(217, 119, 6, 0.1)', fill: true, tension: 0.3 },
          { label: 'Total', data: totalSeries, borderColor: '#4f46e5', backgroundColor: 'rgba(79, 70, 229, 0.05)', fill: true, tension: 0.3, borderDash: [5, 5] }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: { beginAtZero: true, grid: { color: '#e2e8f0' } },
          x: { grid: { display: false } }
        }
      }
    });

    // 2. Severity Distribution
    const sevData = await chQuery(`
      SELECT if(level='', 'unknown', level) as lvl, count() as c
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
      ${cidFilter}
      GROUP BY lvl
      ORDER BY c DESC
    `);

    const sLabels = sevData.map(r => r[0]);
    const sValues = sevData.map(r => r[1]);
    
    const bgColors = sLabels.map(l => {
      l = String(l).toLowerCase();
      if (l === 'error') return '#e11d48';
      if (l === 'warn' || l === 'warning') return '#d97706';
      if (l === 'info') return '#0ea5e9';
      if (l === 'debug') return '#7c3aed';
      return '#94a3b8';
    });

    if (chartSev) chartSev.destroy();
    chartSev = new Chart(document.getElementById('chart-severity'), {
      type: 'doughnut',
      data: {
        labels: sLabels,
        datasets: [{
          data: sValues,
          backgroundColor: bgColors,
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: { position: 'right' }
        }
      }
    });

  } catch (e) {
    console.error("Analytics load error:", e);
  }
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
  el("admin-password").value = "";
  el("modal-error").classList.add("hidden");
  updateModalPreview();
  setTimeout(() => el("admin-password").focus(), 100);
}

function closeClearModal() {
  el("modal-overlay").classList.add("hidden");
  el("admin-password").value = "";
  el("modal-error").classList.add("hidden");
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
  const pwd = el("admin-password").value;
  if (!pwd) {
    el("modal-error").textContent = "Please enter the admin password.";
    el("modal-error").classList.remove("hidden");
    return;
  }
  
  el("modal-error").classList.add("hidden");

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
    el("admin-password").disabled = true;
    
    await chExec(sql, pwd);
    
    closeClearModal();
    await Promise.all([loadMetrics(), loadContainerList(), loadLogs()]);
  } catch (e) {
    el("modal-error").classList.remove("hidden");
    if (e.status === 401 || (e.message && e.message.toLowerCase().includes("authentication failed"))) {
      el("modal-error").textContent = "❌ Incorrect password. Please check your .env file.";
    } else {
      el("modal-error").textContent = "⚠ " + (e.message || "An error occurred");
    }
  } finally {
    el("btn-modal-confirm").disabled = false;
    el("btn-modal-confirm").textContent = "Confirm Delete";
    el("admin-password").disabled = false;
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
