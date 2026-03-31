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
  selectedStack: null,      // null = all stacks/containers; name of stack when selected
  stackContainers: [],      // array of container_ids belonging to selected stack
  search: "",
  level: "",
  sortDir: "DESC",
  fromDate: null,
  toDate: null,
  page: 0,
  totalRows: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);

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
function buildWhere(includeStack = true) {
  const parts = [];

  if (includeStack && state.selectedStack && state.stackContainers.length > 0) {
    // Filter by stack's containers
    const cids = state.stackContainers.map(cid => `'${esc(cid)}'`).join(",");
    parts.push(`container_id IN (${cids})`);
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
        if(isValidJSON(labels),
           if(JSONExtractString(labels, 'com.docker.compose.project') != '',
              JSONExtractString(labels, 'com.docker.compose.project'),
              if(JSONExtractString(labels, 'com_docker_compose_project') != '',
                 JSONExtractString(labels, 'com_docker_compose_project'),
                 'Other')),
           'Other')                     AS compose_project
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
      GROUP BY container_id, container_name, compose_project
      ORDER BY compose_project ASC, last_seen DESC
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
  const allItem = document.createElement("div");
  allItem.className = "container-item" + (!state.selectedStack ? " active" : "");
  allItem.innerHTML = `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span><span class="c-name">All Containers</span>`;
  allItem.addEventListener("click", () => {
    state.selectedStack = null;
    state.stackContainers = [];
    state.page = 0;
    loadLogs();
    if (state.view === "analytics") loadAnalytics();
    renderSidebar();
  });
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
    for (const [stackName, containerIds] of Object.entries(customStacks)) {
      if (containerIds.includes(cid)) {
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
    // Only open the "Watched" and the active stack by default, others closed to save DOM
    const isActive = stackName === state.selectedStack;
    const isOpen = stackName === "⭐ Watched" || isActive;
    
    group.className = "folder-group " + (isOpen ? "open" : "") + (isActive ? " active-stack" : "");
    
    // Check if this is a custom stack (user-created) or compose stack
    const isCustomStack = customStacks[stackName];
    
    // Generate tooltip based on stack type
    let tooltip = "";
    if (stackName === "⭐ Watched") {
      tooltip = "Your favorite containers - mark them by clicking the + button";
    } else if (isCustomStack) {
      tooltip = "Custom stack - click to view logs from all containers in this stack";
    } else {
      tooltip = `Docker Compose project: ${stackName}\\nClick to view logs from all services`;
    }
    
    group.innerHTML = `
      <div class="folder-header" style="cursor: pointer; display: flex; align-items: center;" aria-label="${escHtml(tooltip)}" data-tooltip="${escHtml(tooltip)}">
        <span class="folder-icon">▶</span>
        <span>${escHtml(stackName)}</span>
        <div class="stack-actions" style="margin-left:auto; display:none; gap:4px; display:flex;">
          <button class="btn-ghost btn-icon action-rename" title="Rename Stack" style="font-size:10px; padding:2px 4px;">✏️</button>
          ${isCustomStack ? `<button class="btn-ghost btn-icon action-delete" title="Delete Stack" style="font-size:10px; padding:2px 4px;">🗑️</button>` : ''}
        </div>
      </div>
      <div class="folder-children" ${isOpen ? '' : 'data-loaded="false"'} ></div>
    `;

    const header = group.querySelector(".folder-header");
    const childrenContainer = group.querySelector(".folder-children");
    const stackActions = group.querySelector(".stack-actions");

    // Show/hide action buttons
    header.addEventListener("mouseenter", () => {
      if (stackActions) stackActions.style.display = "flex";
    });
    header.addEventListener("mouseleave", () => {
      if (stackActions) stackActions.style.display = "none";
    });
    
    // Rename logic
    const renameBtn = group.querySelector(".action-rename");
    if (renameBtn) {
      renameBtn.addEventListener("click", (e) => {
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
    }
    
    // Delete logic (only for custom stacks)
    const deleteBtn = group.querySelector(".action-delete");
    if (deleteBtn && isCustomStack) {
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const confirm = window.confirm(`Delete stack "${stackName}"?\n\nContainers will remain, just removed from this stack.`);
        if (confirm) {
          delete customStacks[stackName];
          STORAGE.saveStacks(customStacks);
          renderSidebar();
        }
      });
    }

    // Lazy load logic
    const renderItems = () => {
      childrenContainer.innerHTML = "";
      if (folderDataMap[stackName].length === 0) {
        childrenContainer.innerHTML = `<div class="empty-watched" style="padding-left:0; font-size:11px;">Empty Stack</div>`;
        return;
      }
      folderDataMap[stackName].forEach(data => {
        const dItem = makeContainerItem(data.cid, data.displayName, data.dot, data.fullId, data.errorCount, stackName);
        childrenContainer.appendChild(dItem);
      });
      childrenContainer.removeAttribute("data-loaded"); // Mark as loaded
    };

    if (isOpen) renderItems();

    // Expand/collapse and select on header click
    const arrowIcon = group.querySelector(".folder-icon");
    if (arrowIcon) {
      arrowIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !group.classList.contains("open");
        group.classList.toggle("open");
        if (willOpen && childrenContainer.getAttribute("data-loaded") === "false") {
          renderItems();
        }
      });
    }

    // Select stack when clicking the header (except buttons)
    header.addEventListener("click", (e) => {
      // Don't select if clicking action buttons
      if (e.target.closest(".stack-actions")) return;
      
      if (folderDataMap[stackName].length > 0) {
        selectStack(stackName, folderDataMap[stackName].map(d => d.cid));
      }
    });

    // Custom tooltip interactions (richer than native title)
    header.addEventListener('mouseenter', (e) => {
      showStackTooltip(header, tooltip, e);
    });
    header.addEventListener('mousemove', (e) => {
      showStackTooltip(header, tooltip, e);
    });
    header.addEventListener('mouseleave', () => {
      hideStackTooltip();
    });
    
    folderList.appendChild(group);
  });
}

function selectStack(stackName, containerIds) {
  state.selectedStack = stackName;
  state.stackContainers = containerIds || [];
  state.page = 0;
  loadLogs();
  
  if (state.view === "analytics") {
    loadAnalytics(); // Refresh charts if in analytics mode
  }
  
  renderSidebar(); // updates active class
}

function makeContainerItem(cid, name, dotClass, fullId, errorCount, parentStack) {
  const div = document.createElement("div");
  div.className = "container-item";
  div.innerHTML = `
    ${dotClass ? `<span class="c-dot ${dotClass}"></span>` : `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span>`}
    <span class="c-name" title="${escHtml(fullId)}">${escHtml(name || fullId)}</span>
    ${errorCount > 0 ? `<span class="c-badge">${fmt(errorCount)}</span>` : ""}
    ${cid ? `<span class="c-star" title="Add to Stack">➕</span>` : ""}
  `;
  div.addEventListener("click", () => {
    // When clicking a container item, select its parent stack
    if (parentStack && folderDataMap[parentStack]) {
      const containerIds = folderDataMap[parentStack].map(d => d.cid);
      selectStack(parentStack, containerIds);
    }
  });

  const addBtn = div.querySelector(".c-star");
  if (addBtn) {
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAddToStackModal(cid, name);
    });
  }

  return div;
}

// ── Add to Stack Modal ─────────────────────────────────────────────────────────
function openAddToStackModal(containerId, containerName) {
  const stacks = STORAGE.getStacks();
  const stackNames = Object.keys(stacks);
  
  // Create dynamic modal HTML
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.id = "add-stack-modal-overlay";
  modal.innerHTML = `
    <div class="modal" style="width: 400px;">
      <h2>Add to Stack</h2>
      <p>Select a stack for <strong>${escHtml(containerName)}</strong></p>
      
      <div style="margin: 20px 0;">
        <input type="text" id="stack-search" placeholder="Search stacks..." 
               style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px;">
      </div>
      
      <div id="stack-options" style="max-height: 300px; overflow-y: auto; border: 1px solid #eee; border-radius: 4px;">
        ${stackNames.map(stackName => {
          const description = stackName === "⭐ Watched" 
            ? "Your favorite containers" 
            : "Custom stack for organizing logs";
          return `
            <div class="stack-option" data-stack="${escHtml(stackName)}" 
                 style="padding: 12px; border-bottom: 1px solid #eee; cursor: pointer; hover: background: #f5f5f5;">
              <div style="font-weight: 500;">${escHtml(stackName)}</div>
              <div style="font-size: 12px; color: #666;">${description}</div>
            </div>
          `;
        }).join("")}
      </div>
      
      <div class="modal-actions" style="margin-top: 20px;">
        <button id="stack-modal-cancel" class="btn-ghost">Cancel</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const cancelBtn = modal.querySelector("#stack-modal-cancel");
  const searchInput = modal.querySelector("#stack-search");
  const stackOptions = modal.querySelectorAll(".stack-option");
  
  // Search functionality
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
    stackOptions.forEach(option => {
      const stackName = option.getAttribute("data-stack").toLowerCase();
      option.style.display = stackName.includes(query) ? "block" : "none";
    });
  });
  
  // Stack selection
  stackOptions.forEach(option => {
    option.addEventListener("click", () => {
      const stackName = option.getAttribute("data-stack");
      const stacks = STORAGE.getStacks();
      if (!stacks[stackName]) stacks[stackName] = [];
      if (!stacks[stackName].includes(containerId)) {
        stacks[stackName].push(containerId);
        STORAGE.saveStacks(stacks);
        renderSidebar();
      }
      modal.remove();
    });
  });
  
  // Close modal
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
  
  cancelBtn.addEventListener("click", () => modal.remove());
  searchInput.focus();
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
  
  const cidFilter = state.selectedStack && state.stackContainers.length > 0 
    ? `AND container_id IN (${state.stackContainers.map(c => `'${esc(c)}'`).join(",")})`
    : "";

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

// ── Additional Helpers ────────────────────────────────────────────────────────
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

// Tooltip helpers for richer, multi-line tooltips on stack headers
function _ensureStackTooltip() {
  if (window._stackTooltip) return window._stackTooltip;
  const t = document.createElement('div');
  t.className = 'stack-tooltip';
  t.setAttribute('role', 'tooltip');
  t.style.position = 'fixed';
  t.style.zIndex = 1200;
  t.style.padding = '8px 10px';
  t.style.background = 'rgba(15,23,42,0.95)';
  t.style.color = '#fff';
  t.style.borderRadius = '6px';
  t.style.fontSize = '12px';
  t.style.maxWidth = '320px';
  t.style.boxShadow = '0 6px 18px rgba(2,6,23,0.45)';
  t.style.display = 'none';
  t.style.pointerEvents = 'none';
  document.body.appendChild(t);
  window._stackTooltip = t;
  return t;
}

function showStackTooltip(targetEl, text, evt, isHtml = false) {
  try {
    const t = _ensureStackTooltip();
    if (isHtml) t.innerHTML = text; else t.textContent = text;
    t.style.display = 'block';
    // Position near mouse if available, otherwise below the element
    const x = evt && evt.clientX ? evt.clientX + 12 : (targetEl.getBoundingClientRect().left + 8);
    const y = evt && evt.clientY ? evt.clientY + 12 : (targetEl.getBoundingClientRect().bottom + 6);
    let left = x;
    let top = y;
    // Keep on-screen
    const rect = t.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = targetEl.getBoundingClientRect().top - rect.height - 8;
    t.style.left = Math.max(8, left) + 'px';
    t.style.top = Math.max(8, top) + 'px';
  } catch (e) { /* ignore */ }
}

function hideStackTooltip() {
  if (!window._stackTooltip) return;
  window._stackTooltip.style.display = 'none';
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

  // Sidebar 'STACKS' info icon rich tooltip
  const infoIcon = document.querySelector('.sidebar-legend .info-icon');
  if (infoIcon) {
    const infoText = `
      <div style="margin-bottom:6px;font-weight:600;">Dot Color Legend:</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-dot green" style="width:10px;height:10px;"></span><span>&lt; 1m (Active)</span></span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-dot amber" style="width:10px;height:10px;"></span><span>&lt; 5m (Recent)</span></span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-dot red" style="width:10px;height:10px;"></span><span>&gt; 5m (Inactive)</span></span>
      </div>
      <div style="font-weight:600;margin-bottom:4px;">Stacks:</div>
      <div style="line-height:1.3;">
        <div>⭐ Watched: your starred containers</div>
        <div>Compose projects: detected from Docker labels</div>
        <div>Custom stacks: user-created groups</div>
      </div>
    `;
    // Remove any native title on the parent .sidebar-legend to avoid double tooltips
    const legend = infoIcon.closest('.sidebar-legend');
    if (legend && legend.hasAttribute('title')) {
      // preserve accessible name via aria-label
      legend.setAttribute('aria-label', legend.getAttribute('title'));
      legend.removeAttribute('title');
    }
    // Also clear native title on the icon itself
    infoIcon.removeAttribute('title');

    infoIcon.addEventListener('mouseenter', (e) => showStackTooltip(infoIcon, infoText, e, true));
    infoIcon.addEventListener('mousemove', (e) => showStackTooltip(infoIcon, infoText, e, true));
    infoIcon.addEventListener('mouseleave', () => hideStackTooltip());
  }

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
