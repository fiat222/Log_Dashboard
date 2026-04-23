/**
 * app.js — Container Log Dashboard v2
 * =====================================
 * - Auth: JWT cookie via /logstore/api/auth, redirects to /logstore/login if not authenticated
 * - ClickHouse queries proxied through FastAPI /logstore/api/query (role-filtered)
 * - Export: JSV via /logstore/api/export with stack/time selection
 * - Notifications: SSE via /logstore/api/notifications/stream + in-memory history
 * - Admin panel: user management, container ownership (super_admin / admin only)
 */

"use strict";

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = "/logstore/api";
const PAGE_SIZE = 12;

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  user: null,             // { username, role, user_id, display_name }
  selectedStack: null,
  stackNames: [],
  search: "",
  level: "",
  sortDir: "DESC",
  fromDate: null,
  toDate: null,
  page: 0,
  totalRows: 0,
  view: "logs",           // "logs" | "analytics" | "admin"
  settings: {},
  notifications: [],
  unreadCount: 0,
  notifFilter: "all",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);
const esc = s => String(s).replace(/'/g, "''");
const escLike = s => esc(s).replace(/[%_\\]/g, c => "\\" + c);
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmt(n) {
  const num = parseInt(n, 10);
  if (isNaN(num)) return "—";
  return num >= 1_000_000 ? (num / 1_000_000).toFixed(1) + "M"
    : num >= 1_000 ? (num / 1_000).toFixed(1) + "K"
      : String(num);
}
function formatTs(ts) {
  try {
    return new Date(ts).toLocaleString("sv-SE", { timeZone: "Asia/Bangkok" }).replace("T", " ");
  } catch { return String(ts); }
}

function toLocalISO(date) {
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60000);
  return localDate.toISOString().slice(0, 19);
}
function getCustomDateTime(prefix) {
  const d = el(`${prefix}-date`).value;
  if (!d) return null;
  const h = el(`${prefix}-hour`).value || "00";
  const m = el(`${prefix}-minute`).value || "00";
  return `${d}T${h}:${m}`; // Do not append :00 since buildWhere appends it
}
function setCustomDateTime(prefix, dateStr) {
  if (!dateStr) {
    el(`${prefix}-date`).value = "";
    el(`${prefix}-hour`).value = "00";
    el(`${prefix}-minute`).value = "00";
    return;
  }
  const iso = dateStr.includes("Z") ? toLocalISO(new Date(dateStr)) : dateStr.slice(0, 19);
  const [dp, tp] = iso.split("T");
  el(`${prefix}-date`).value = dp;
  const [h, m] = tp.split(":");
  el(`${prefix}-hour`).value = h;
  el(`${prefix}-minute`).value = m;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: "include" });
    console.log("[SSO/AUTH] /auth/me response", {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      redirected: res.redirected,
      url: res.url,
      type: res.type,
      headers: Object.fromEntries(res.headers.entries()),
    });
    if (res.status === 401) {
      console.log("[SSO/AUTH] unauthenticated, redirecting to /logstore/login");
      window.location.href = "/logstore/login";
      return false;
    }
    state.user = await res.json();
    console.log("[SSO/AUTH] session payload (/auth/me)", state.user);
    renderUserPill();
    applyRoleUI();
    return true;
  } catch (err) {
    console.log("[SSO/AUTH] checkAuth error", err);
    // If backend is down, fall through with limited functionality
    console.warn("Backend unreachable, running in limited mode");
    return true;
  }
}

function renderUserPill() {
  const u = state.user;
  if (!u) return;
  const pill = el("user-pill");
  const badge = el("user-role-badge");
  const nameEl = el("user-display-name");
  if (!pill) return;
  const roleColors = {
    super_admin: "role-super",
    admin: "role-admin",
    developer: "role-dev",
  };
  badge.className = "role-badge " + (roleColors[u.role] || "role-dev");
  badge.textContent = u.role === "super_admin" ? "Super Admin"
    : u.role === "admin" ? "Admin"
      : "Developer";
  nameEl.textContent = u.username;
  pill.style.display = "flex";
  const logoutBtn = el("btn-logout");
  if (logoutBtn) logoutBtn.style.display = "inline-flex";
}

function applyRoleUI() {
  const role = state.user?.role;
  const isAdmin = role === "super_admin" || role === "admin";
  const isSuper = role === "super_admin";

  // Clear DB button — admin + super_admin only
  const clearBtn = el("btn-clear-db");
  if (clearBtn) clearBtn.classList.toggle("hidden", !isAdmin);

  // Admin tab — admin + super_admin
  const adminTab = el("tab-admin");
  if (adminTab) adminTab.classList.toggle("hidden", !isAdmin);

  // Nginx tab — admin + super_admin only
  const nginxTab = el("tab-nginx");
  if (nginxTab) nginxTab.classList.toggle("hidden", !isAdmin);

  // Settings panel — admin + super_admin
  const settingsPanel = el("sidebar-settings");
  if (settingsPanel) settingsPanel.classList.toggle("hidden", !isAdmin);
}

el("btn-logout").addEventListener("click", async () => {
  await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  window.location.href = "/logstore/login";
});

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiQuery(sql) {
  const res = await fetch(`${API_BASE}/query?q=${encodeURIComponent(sql)}`, {
    credentials: "include"
  });
  if (res.status === 401) { window.location.href = "/logstore/login"; return []; }
  if (!res.ok) throw new Error(`Query failed (${res.status})`);
  const json = await res.json();
  return json.data || [];
}

async function apiExec(sql) {
  const res = await fetch(`${API_BASE}/exec`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "text/plain" },
    body: sql,
  });
  if (res.status === 401) { window.location.href = "/logstore/login"; return; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { status: res.status, message: err.detail || `Error ${res.status}` };
  }
}

// ── Build WHERE clause ────────────────────────────────────────────────────────
function buildWhere(includeStack = true) {
  const parts = [];
  if (includeStack && state.selectedStack && state.stackNames.length > 0) {
    const cnames = state.stackNames.map(c => `'${esc(c)}'`).join(",");
    parts.push(`container_name IN (${cnames})`);
  }
  if (state.level) parts.push(`level = '${esc(state.level)}'`);
  if (state.search) parts.push(`message ILIKE '%${escLike(state.search)}%'`);
  if (state.fromDate) parts.push(`timestamp >= '${state.fromDate}:00'`);
  if (state.toDate) parts.push(`timestamp <= '${state.toDate}:00'`);

  // DEFAULT: If no dates are selected, always restrict to last 24h 
  // to avoid scanning the entire database history (Heavy full-table scan).
  if (!state.fromDate && !state.toDate) {
    parts.push(`timestamp > now() - INTERVAL 24 HOUR`);
  }

  return parts.length ? "WHERE " + parts.join(" AND ") : "";
}

// ── Metrics ───────────────────────────────────────────────────────────────────
async function loadMetrics() {
  try {
    const rows = await apiQuery(`
      SELECT count(), countIf(level='error'),
             countIf(level='warn' OR level='warning'),
             uniqExact(container_id)
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
    `);
    if (rows.length) {
      const [total, errors, warnings, containers] = rows[0];
      el("m-total").querySelector(".metric-value").textContent = fmt(total);
      el("m-errors").querySelector(".metric-value").textContent = fmt(errors);
      el("m-warnings").querySelector(".metric-value").textContent = fmt(warnings);
      el("m-containers").querySelector(".metric-value").textContent = fmt(containers);
    }
  } catch (e) { console.error("Metrics error:", e); }
}

// ── Sidebar / Container List ──────────────────────────────────────────────────
const STORAGE = {
  getStacks: () => {
    try {
      let s = JSON.parse(localStorage.getItem("logpipe_custom_stacks"));
      if (!s) throw new Error("empty");
      if (!s["⭐ Watched"]) s["⭐ Watched"] = [];
      return s;
    } catch { return { "⭐ Watched": [] }; }
  },
  saveStacks: s => localStorage.setItem("logpipe_custom_stacks", JSON.stringify(s)),
};

let containerAliases = {};

async function loadContainerAliases() {
  try {
    const res = await fetch(`${API_BASE}/user/containers`, { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      containerAliases = {};
      data.forEach(d => {
        if (d.custom_name) containerAliases[d.container_name] = d.custom_name;
      });
    }
  } catch (e) { console.error("Error loading container aliases", e); }
}

let lastSidebarRows = [];
let folderDataMap = {};
let openStacks = new Set();   // tracks manually-opened stacks across re-renders

async function loadContainerList() {
  try {
    const rows = await apiQuery(`
      SELECT container_name, max(timestamp) AS last_seen,
             count() AS log_count, countIf(level='error') AS error_count,
             if(isValidJSON(labels),
               if(JSONExtractString(labels,'com.docker.compose.project') != '',
                  JSONExtractString(labels,'com.docker.compose.project'),
                  if(JSONExtractString(labels,'com_docker_compose_project') != '',
                     JSONExtractString(labels,'com_docker_compose_project'),'Other')),
               'Other') AS compose_project
      FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR
      GROUP BY container_name, compose_project
      ORDER BY compose_project ASC, last_seen DESC LIMIT 100
    `);
    lastSidebarRows = rows;
    renderSidebar();
  } catch (e) { console.error("Container list error:", e); }
}

function renderSidebar() {
  const folderList = el("folder-list");
  folderList.innerHTML = "";
  folderDataMap = {};
  const customStacks = STORAGE.getStacks();
  const isAdmin = state.user?.role === "super_admin" || state.user?.role === "admin";

  const allItem = document.createElement("div");
  allItem.className = "container-item" + (!state.selectedStack ? " active" : "");
  allItem.innerHTML = `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span><span class="c-name">All Containers</span>`;
  allItem.addEventListener("click", () => {
    state.selectedStack = null; state.stackNames = []; state.page = 0;
    stopLogsSSE();
    if (state.view === "logs") startLogsSSE();
    loadLogs(); if (state.view === "analytics") loadAnalytics(); renderSidebar();
  });
  folderList.appendChild(allItem);
  if (!lastSidebarRows.length) return;

  const dotThresholds = {
    green: parseInt(state.settings.dot_green_threshold_sec || "60"),
    amber: parseInt(state.settings.dot_amber_threshold_sec || "300"),
  };
  const now = Date.now();

  lastSidebarRows.forEach(row => {
    const [cname, lastSeen, , errorCount, rawProject] = row;
    const ageSec = (now - new Date(lastSeen).getTime()) / 1000;
    const dot = ageSec < dotThresholds.green ? "green"
      : ageSec < dotThresholds.amber ? "amber" : "red";
    let displayName = containerAliases[cname] || cname;
    const itemData = { displayName, cname, dot, errorCount };
    const displayProject = rawProject;
    if (!folderDataMap[displayProject]) folderDataMap[displayProject] = { items: [], rawProject };
    folderDataMap[displayProject].items.push(itemData);
    for (const [stackName, names] of Object.entries(customStacks)) {
      if (names.includes(cname)) {
        if (!folderDataMap[stackName]) folderDataMap[stackName] = { items: [], rawProject: null };
        folderDataMap[stackName].items.push(itemData);
      }
    }
  });

  for (const stackName of Object.keys(customStacks))
    if (!folderDataMap[stackName]) folderDataMap[stackName] = { items: [], rawProject: null };

  const sortedNames = Object.keys(folderDataMap).sort((a, b) => {
    if (a === "⭐ Watched") return -1;
    if (b === "⭐ Watched") return 1;
    return a.localeCompare(b);
  });

  sortedNames.forEach(stackName => {
    const group = document.createElement("div");
    const isActive = stackName === state.selectedStack;
    // Always open: the active stack, ⭐ Watched, or any stack the user manually expanded
    if (isActive) openStacks.add(stackName);
    const isOpen = stackName === "⭐ Watched" || openStacks.has(stackName);
    const isCustom = !!customStacks[stackName];
    const { items: stackItems, rawProject } = folderDataMap[stackName];
    group.className = "folder-group " + (isOpen ? "open" : "") + (isActive ? " active-stack" : "");

    group.innerHTML = `
      <div class="folder-header" style="cursor:pointer;display:flex;align-items:center;">
        <span class="folder-icon">▶</span>
        <span>${escHtml(stackName)}</span>
        <div class="stack-actions" style="margin-left:auto;display:flex;gap:4px;">
          <button class="btn-ghost btn-icon action-rename" title="Rename" style="font-size:10px;padding:2px 4px;">✏️</button>
          ${isAdmin ? `<button class="btn-ghost btn-icon action-purge-stack" title="Permanently Delete Logs" style="font-size:10px;padding:2px 4px;">🗑️</button>` : ""}
          ${isCustom ? `<button class="btn-ghost btn-icon action-delete" title="Delete" style="font-size:10px;padding:2px 4px;">🗑️</button>` : ""}
        </div>
      </div>
      <div class="folder-children" ${isOpen ? "" : 'data-loaded="false"'}></div>
    `;

    const header = group.querySelector(".folder-header");
    const childrenContainer = group.querySelector(".folder-children");

    const renderItems = () => {
      childrenContainer.innerHTML = "";
      if (!stackItems.length) {
        childrenContainer.innerHTML = `<div class="empty-watched" style="padding-left:0;font-size:11px;">Empty Stack</div>`;
        return;
      }
      stackItems.forEach(data => {
        childrenContainer.appendChild(makeContainerItem(data.displayName, data.cname, data.dot, data.errorCount));
      });
      childrenContainer.removeAttribute("data-loaded");
    };
    if (isOpen) renderItems();

    // Stack actions
    group.querySelector(".action-rename").addEventListener("click", e => {
      e.stopPropagation();
      const newName = prompt("Rename stack to:", stackName);
      if (newName?.trim() && newName !== stackName) {
        if (isCustom) {
          // Custom stack: rename the key in localStorage
          const s = STORAGE.getStacks(); s[newName] = s[stackName]; delete s[stackName]; STORAGE.saveStacks(s);
        } else {
          // Folder renaming (compose projects) disabled for now to avoid local storage
          alert("ไม่อนุญาตให้เปลี่ยนชื่อ stack!!! \nหากต้องการจะเปลี่ยนชื่อ stack กรุณาสร้าง stack ใหม่เป็นของตัวเอง");
        }
        renderSidebar();
      }
    });
    const delBtn = group.querySelector(".action-delete");
    if (delBtn) delBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (confirm(`Delete stack "${stackName}"?`)) {
        const s = STORAGE.getStacks(); delete s[stackName]; STORAGE.saveStacks(s); renderSidebar();
      }
    });

    const purgeStackBtn = group.querySelector(".action-purge-stack");
    if (purgeStackBtn) purgeStackBtn.addEventListener("click", async e => {
      e.stopPropagation();
      if (confirm(`PERMANENT DELETE: Are you sure you want to delete ALL logs for stack "${stackName}"? This is a heavy operation and cannot be undone.`)) {
        try {
          purgeStackBtn.disabled = true;
          const res = await fetch(`${API_BASE}/admin/purge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ type: "stack", name: rawProject || stackName })
          });
          if (res.ok) {
            alert("Purge mutation started. Data will disappear shortly.");
            refresh();
          } else {
            const err = await res.json();
            alert("Purge failed: " + (err.detail || "Unknown error"));
          }
        } catch (err) { console.error(err); }
        finally { purgeStackBtn.disabled = false; }
      }
    });

    group.querySelector(".folder-icon").addEventListener("click", e => {
      e.stopPropagation();
      const willOpen = !group.classList.contains("open");
      group.classList.toggle("open");
      // Persist open/close state so re-renders don't reset it
      if (willOpen) openStacks.add(stackName);
      else openStacks.delete(stackName);
      if (willOpen && childrenContainer.getAttribute("data-loaded") === "false") renderItems();
    });

    header.addEventListener("click", e => {
      if (e.target.closest(".stack-actions")) return;
      if (e.target.closest(".folder-icon")) return;   // icon has its own toggle handler
      if (stackItems.length > 0)
        selectStack(stackName, stackItems.map(d => d.cname));
    });

    folderList.appendChild(group);
  });
}

function selectStack(stackName, containerNames) {
  state.selectedStack = stackName; state.stackNames = containerNames || []; state.page = 0;
  stopLogsSSE();
  if (state.view === "logs") startLogsSSE();
  loadLogs(); if (state.view === "analytics") loadAnalytics(); renderSidebar();
}

function makeContainerItem(name, realName, dotClass, errorCount) {
  const div = document.createElement("div");
  const isSelected = state.selectedStack === realName || state.selectedStack === name;
  const isAdmin = state.user?.role === "super_admin" || state.user?.role === "admin";
  div.className = "container-item" + (isSelected ? " active" : "");
  div.innerHTML = `
    ${dotClass ? `<span class="c-dot ${dotClass}"></span>` : `<span class="c-dot" style="background:var(--accent)"></span>`}
    <span class="c-name">${escHtml(name)}</span>
    ${errorCount > 0 ? `<span class="c-badge">${fmt(errorCount)}</span>` : ""}
    <div class="c-actions" style="margin-left:auto;display:flex;gap:4px;">
      ${isAdmin ? `<span class="c-purge" title="Permanently Delete Logs" style="cursor:pointer;font-size:10px;">🗑️</span>` : ""}
      ${realName ? `<span class="c-edit" title="Rename Container" style="cursor:pointer;font-size:10px;">✏️</span>` : ""}
      ${realName ? `<span class="c-star" title="Add to Stack" style="cursor:pointer;">➕</span>` : ""}
    </div>
  `;
  div.addEventListener("click", () => {
    selectStack(name, [realName]);
  });
  div.querySelector(".c-star")?.addEventListener("click", e => {
    e.stopPropagation(); openAddToStackModal(realName);
  });
  div.querySelector(".c-purge")?.addEventListener("click", async e => {
    e.stopPropagation();
    if (confirm(`PERMANENT DELETE: Delete all logs for container "${realName || name}"? Data will be wiped from database.`)) {
      try {
        const res = await fetch(`${API_BASE}/admin/purge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ type: "container", name: realName || name })
        });
        if (res.ok) {
          alert("Purge mutation started.");
          refresh();
        } else {
          const err = await res.json();
          alert("Purge failed: " + (err.detail || "Unknown error"));
        }
      } catch (err) { console.error(err); }
    }
  });
  div.querySelector(".c-edit")?.addEventListener("click", async e => {
    e.stopPropagation();
    const newName = prompt(`Rename container "${realName}" to:`, name);
    if (newName !== null && newName !== name) {
      try {
        const res = await fetch(`${API_BASE}/user/containers/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ container_name: realName, custom_name: newName.trim() })
        });
        if (res.ok) {
          await loadContainerAliases();
          renderSidebar();
        } else {
          alert("Failed to rename container.");
        }
      } catch (err) {
        console.error(err);
      }
    }
  });
  return div;
}

function openAddToStackModal(containerName) {
  const stacks = STORAGE.getStacks();
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal" style="width:400px;">
      <h2>Add to Stack</h2>
      <p>Select a stack for <strong>${escHtml(containerName)}</strong></p>
      <div style="margin:20px 0;">
        <input type="text" id="stack-search" placeholder="Search stacks..." style="width:100%;padding:8px;border:1px solid var(--border);border-radius:4px;font-size:14px;background:var(--bg-elevated);color:var(--text);">
      </div>
      <div id="stack-options" style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;">
        ${Object.keys(stacks).map(n => `
          <div class="stack-option" data-stack="${escHtml(n)}"
               style="padding:12px;border-bottom:1px solid var(--border);cursor:pointer;">
            <div style="font-weight:500;">${escHtml(n)}</div>
          </div>`).join("")}
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button id="stack-modal-cancel" class="btn-ghost">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const searchInput = modal.querySelector("#stack-search");
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    modal.querySelectorAll(".stack-option").forEach(o =>
      o.style.display = o.dataset.stack.toLowerCase().includes(q) ? "block" : "none");
  });
  modal.querySelectorAll(".stack-option").forEach(o => {
    o.addEventListener("click", () => {
      const s = STORAGE.getStacks(); const sn = o.dataset.stack;
      if (!s[sn]) s[sn] = [];
      if (!s[sn].includes(containerName)) { s[sn].push(containerName); STORAGE.saveStacks(s); renderSidebar(); }
      modal.remove();
    });
    o.addEventListener("mouseenter", () => o.style.background = "var(--bg-elevated)");
    o.addEventListener("mouseleave", () => o.style.background = "");
  });
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  modal.querySelector("#stack-modal-cancel").addEventListener("click", () => modal.remove());
  searchInput.focus();
}

// ── Log Table ─────────────────────────────────────────────────────────────────
async function loadLogs() {
  const where = buildWhere();
  const offset = state.page * PAGE_SIZE;
  try {
    el("table-status").textContent = "Loading…";
    const [countRows, dataRows] = await Promise.all([
      apiQuery(`SELECT count() FROM container_logs ${where}`),
      apiQuery(`SELECT timestamp, container_name, level, message FROM container_logs ${where} ORDER BY timestamp ${state.sortDir} LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    ]);
    state.totalRows = parseInt(countRows[0]?.[0] ?? 0, 10);
    const totalPages = Math.max(1, Math.ceil(state.totalRows / PAGE_SIZE));
    el("table-status").textContent = `${fmt(state.totalRows)} rows  ·  Page ${state.page + 1} of ${totalPages}`;
    renderTable(dataRows);
    renderPagination(totalPages);
  } catch (e) {
    el("table-status").textContent = "⚠ Query failed: " + e.message;
    el("log-body").innerHTML = `<tr><td colspan="4" class="empty-state">Error loading logs.</td></tr>`;
  }
}

function renderTable(rows) {
  const tbody = el("log-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No logs found for the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(([ts, cname, level, msg]) => {
    const lvl = (level || "").toLowerCase();
    const rowCls = lvl === "error" ? "row-error" : (lvl === "warn" || lvl === "warning") ? "row-warn" : "";
    const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvl] || "badge-other";
    const displayName = containerAliases[cname] || cname;
    return `<tr class="${rowCls}">
      <td class="td-ts">${formatTs(ts)}</td>
      <td class="td-cid" title="${escHtml(cname)}">${escHtml(displayName)}</td>
      <td><span class="badge ${badgeCls}">${escHtml(lvl || "—")}</span></td>
      <td class="td-msg">${escHtml(String(msg)).slice(0, 800)}</td>
    </tr>`;
  }).join("");
}

function renderPagination(totalPages) {
  el("btn-prev").disabled = state.page === 0;
  el("btn-next").disabled = state.page >= totalPages - 1;
  el("page-info").textContent = `Page ${state.page + 1} / ${totalPages}`;
}

// ── Nginx Logs ───────────────────────────────────────────────────────────────
const NGINX_PAGE_SIZE = 50;
let nginxPage = 0;
let nginxTotalRows = 0;
let logsSSE = null;
let nginxSSE = null;

function canLiveLogs() {
  return state.sortDir === "DESC" && state.page === 0 && !state.fromDate && !state.toDate;
}

function setLiveBadge(tableStatusId, active) {
  const statusEl = el(tableStatusId);
  if (!statusEl) return;
  const existing = statusEl.querySelector(".live-badge");
  if (active && !existing) {
    const badge = document.createElement("span");
    badge.className = "live-badge";
    badge.textContent = "● LIVE";
    statusEl.appendChild(badge);
  } else if (!active && existing) {
    existing.remove();
  }
}

function startLogsSSE() {
  stopLogsSSE();
  if (state.view !== "logs" || !canLiveLogs()) return;
  const params = new URLSearchParams();
  if (state.stackNames.length > 0) params.set("container_names", state.stackNames.join(","));
  if (state.level) params.set("level", state.level);
  if (state.search) params.set("search", state.search);
  logsSSE = new EventSource(`${API_BASE}/logs/stream?${params}`, { withCredentials: true });
  logsSSE.onopen = () => setLiveBadge("table-status", true);
  logsSSE.onmessage = (e) => {
    try {
      const { rows } = JSON.parse(e.data);
      if (rows?.length) prependLogRows(rows);
    } catch { }
  };
  logsSSE.onerror = () => {
    setLiveBadge("table-status", false);
    logsSSE?.close(); logsSSE = null;
    setTimeout(() => { if (state.view === "logs") startLogsSSE(); }, 10_000);
  };
}

function stopLogsSSE() {
  if (logsSSE) { logsSSE.close(); logsSSE = null; }
  setLiveBadge("table-status", false);
}

function prependLogRows(newRows) {
  const tbody = el("log-body");
  if (!tbody || tbody.querySelector(".empty-state")) return;
  [...newRows].reverse().forEach(([ts, cname, level, msg]) => {
    const lvl = (level || "").toLowerCase();
    const rowCls = lvl === "error" ? "row-error" : (lvl === "warn" || lvl === "warning") ? "row-warn" : "";
    const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvl] || "badge-other";
    const displayName = containerAliases[cname] || cname;
    const tr = document.createElement("tr");
    tr.className = (rowCls + " row-new").trim();
    tr.innerHTML = `<td class="td-ts">${formatTs(ts)}</td><td class="td-cid" title="${escHtml(cname)}">${escHtml(displayName)}</td><td><span class="badge ${badgeCls}">${escHtml(lvl || "—")}</span></td><td class="td-msg">${escHtml(String(msg)).slice(0, 800)}</td>`;
    tbody.insertBefore(tr, tbody.firstChild);
  });
  while (tbody.rows.length > PAGE_SIZE) tbody.deleteRow(tbody.rows.length - 1);
  state.totalRows += newRows.length;
  const totalPages = Math.max(1, Math.ceil(state.totalRows / PAGE_SIZE));
  const statusEl = el("table-status");
  if (statusEl) {
    const textNode = statusEl.childNodes[0];
    if (textNode?.nodeType === Node.TEXT_NODE)
      textNode.textContent = `${fmt(state.totalRows)} rows  ·  Page ${state.page + 1} of ${totalPages}`;
  }
}

function startNginxSSE() {
  stopNginxSSE();
  if (state.view !== "nginx") return;
  nginxSSE = new EventSource(`${API_BASE}/nginx/stream`, { withCredentials: true });
  nginxSSE.onopen = () => setLiveBadge("nginx-table-status", true);
  nginxSSE.onmessage = (e) => {
    try {
      const { rows } = JSON.parse(e.data);
      if (rows?.length) prependNginxRows(rows);
    } catch { }
  };
  nginxSSE.onerror = () => {
    setLiveBadge("nginx-table-status", false);
    nginxSSE?.close(); nginxSSE = null;
    setTimeout(() => { if (state.view === "nginx") startNginxSSE(); }, 10_000);
  };
}

function stopNginxSSE() {
  if (nginxSSE) { nginxSSE.close(); nginxSSE = null; }
  setLiveBadge("nginx-table-status", false);
}

function prependNginxRows(newRows) {
  const tbody = el("nginx-log-body");
  if (!tbody || tbody.querySelector(".empty-state")) return;
  [...newRows].reverse().forEach(([ts, ip, method, referer, path, status, bytes, time]) => {
    const statusNum = parseInt(status) || 0;
    const cls = statusNum >= 500 ? "row-error" : statusNum >= 400 ? "row-warn" : "";
    const refStr = String(referer);
    const refDisplay = refStr === "-" || !refStr ? "-" : escHtml(refStr.slice(0, 100));
    const tr = document.createElement("tr");
    tr.className = (cls + " row-new").trim();
    tr.innerHTML = `<td class="td-ip">${escHtml(String(ip))}</td><td class="td-ts">${formatTs(ts)}</td><td>${escHtml(method)}</td><td class="td-referer" title="${refStr === "-" ? "" : escHtml(refStr)}">${refDisplay}</td><td class="td-path" title="${escHtml(path)}">${escHtml(String(path).slice(0, 80))}</td><td><span class="badge ${statusNum >= 500 ? "badge-error" : statusNum >= 400 ? "badge-warn" : "badge-info"}">${statusNum}</span></td><td>${fmt(bytes)}</td><td>${parseFloat(time || 0).toFixed(4)}s</td>`;
    tbody.insertBefore(tr, tbody.firstChild);
  });
  while (tbody.rows.length > NGINX_PAGE_SIZE) tbody.deleteRow(tbody.rows.length - 1);
  nginxTotalRows += newRows.length;
  const totalPages = Math.max(1, Math.ceil(nginxTotalRows / NGINX_PAGE_SIZE));
  const statusEl = el("nginx-table-status");
  if (statusEl) {
    const textNode = statusEl.childNodes[0];
    if (textNode?.nodeType === Node.TEXT_NODE)
      textNode.textContent = `${fmt(nginxTotalRows)} rows  ·  Page ${nginxPage + 1} of ${totalPages}`;
  }
}

function buildNginxWhere() {
  const cond = ["timestamp >= now() - INTERVAL 24 HOUR"];
  const status = el("nginx-status-select")?.value;
  if (status) cond.push(`status = ${status}`);
  const method = el("nginx-method-select")?.value;
  if (method) cond.push(`method = '${method}'`);
  const path = el("nginx-search-input")?.value?.trim();
  if (path) cond.push(`path LIKE '%${esc(path)}%'`);
  const fromDate = el("nginx-range-from-date")?.value;
  const fromHour = el("nginx-range-from-hour")?.value;
  const fromMin = el("nginx-range-from-minute")?.value;
  if (fromDate) {
    const fromTs = `${fromDate} ${fromHour || "00"}:${fromMin || "00"}`;
    cond.push(`timestamp >= toDateTime('${fromTs}', 'Asia/Bangkok')`);
  }
  const toDate = el("nginx-range-to-date")?.value;
  const toHour = el("nginx-range-to-hour")?.value;
  const toMin = el("nginx-range-to-minute")?.value;
  if (toDate) {
    const toTs = `${toDate} ${toHour || "23"}:${toMin || "59"}`;
    cond.push(`timestamp <= toDateTime('${toTs}', 'Asia/Bangkok')`);
  }
  return cond.length > 1 ? cond.join(" AND ") : cond[0];
}

async function loadNginxLogs() {
  const params = new URLSearchParams();
  const status = el("nginx-status-select")?.value;
  const method = el("nginx-method-select")?.value;
  const path = el("nginx-search-input")?.value?.trim();
  const order = el("nginx-sort-select")?.value || "desc";
  const fromDate = el("nginx-range-from-date")?.value;
  const fromHour = el("nginx-range-from-hour")?.value;
  const fromMin = el("nginx-range-from-minute")?.value;
  const toDate = el("nginx-range-to-date")?.value;
  const toHour = el("nginx-range-to-hour")?.value;
  const toMin = el("nginx-range-to-minute")?.value;

  params.set("page", String(nginxPage + 1));
  params.set("page_size", String(NGINX_PAGE_SIZE));
  params.set("order", order);
  params.set("hours", "24");
  if (status) params.set("status", status);
  if (method) params.set("method", method);
  if (path) params.set("path_contains", path);
  if (fromDate) {
    const fromTs = `${fromDate} ${fromHour || "00"}:${fromMin || "00"}:00`;
    params.set("from_time", fromTs);
  }
  if (toDate) {
    const toTs = `${toDate} ${toHour || "23"}:${toMin || "59"}:59`;
    params.set("to_time", toTs);
  }

  try {
    el("nginx-table-status").textContent = "Loading…";
    const res = await fetch(`${API_BASE}/admin/nginx-logs/logs?${params}`, { credentials: "include" });
    if (!res.ok) throw new Error(res.statusText);
    const json = await res.json();
    nginxTotalRows = json.total || 0;
    const totalPages = Math.max(1, Math.ceil(nginxTotalRows / NGINX_PAGE_SIZE));
    el("nginx-table-status").textContent = `${fmt(nginxTotalRows)} rows  ·  Page ${nginxPage + 1} of ${totalPages}`;
    renderNginxTable(json.data || []);
    renderNginxPagination(totalPages);
  } catch (e) {
    el("nginx-table-status").textContent = "⚠ Query failed: " + e.message;
    el("nginx-log-body").innerHTML = `<tr><td colspan="7" class="empty-state">Error loading nginx logs.</td></tr>`;
  }
}

function renderNginxTable(rows) {
  const tbody = el("nginx-log-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No nginx logs found for the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(([ts, ip, method, referer, path, status, bytes, time]) => {
    const statusNum = parseInt(status) || 0;
    const cls = statusNum >= 500 ? "row-error" : statusNum >= 400 ? "row-warn" : "";
    referer = String(referer);
    const refererDisplay = referer === "-" || !referer ? "-" : escHtml(referer.slice(0, 100));
    return `<tr class="${cls}">
      <td class="td-ip">${escHtml(String(ip))}</td>
      <td class="td-ts">${formatTs(ts)}</td>
      <td>${escHtml(method)}</td>
      <td class="td-referer" title="${referer === "-" ? "" : escHtml(referer)}">${refererDisplay}</td>
      <td class="td-path" title="${escHtml(path)}">${escHtml(String(path).slice(0, 80))}</td>
      <td><span class="badge ${statusNum >= 500 ? "badge-error" : statusNum >= 400 ? "badge-warn" : "badge-info"}">${statusNum}</span></td>
      <td>${fmt(bytes)}</td>
      <td>${parseFloat(time || 0).toFixed(4)}s</td>
    </tr>`;
  }).join("");
}

function renderNginxPagination(totalPages) {
  el("btn-nginx-prev").disabled = nginxPage === 0;
  el("btn-nginx-next").disabled = nginxPage >= totalPages - 1;
  el("nginx-page-info").textContent = `Page ${nginxPage + 1} / ${totalPages}`;
}

// ── Nginx Analytics ───────────────────────────────────────────────────────────
let nginxChartTraffic = null;
let nginxAnalyticsHours = 24;

function fmtBytes(b) {
  b = parseInt(b) || 0;
  if (b >= 1e9) return (b / 1e9).toFixed(1) + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
  if (b >= 1e3) return (b / 1e3).toFixed(1) + " KB";
  return b + " B";
}

async function loadNginxOverview() {
  try {
    const res = await fetch(`${API_BASE}/admin/nginx-logs/overview?hours=${nginxAnalyticsHours}`, { credentials: "include" });
    if (!res.ok) return;
    const d = await res.json();
    el("nx-total").textContent = fmt(d.total_requests || 0);
    const errRate = parseFloat(d.error_rate || 0);
    el("nx-error-rate").textContent = errRate.toFixed(1) + "%";
    el("nx-error-rate").closest(".metric-card").className = "metric-card" + (errRate > 5 ? " error" : errRate > 1 ? " warn" : "");
    el("nx-bytes").textContent = fmtBytes(d.total_bytes || 0);
  } catch (e) { console.error("nginx overview:", e); }
}

async function loadNginxTraffic() {
  if (!window.Chart) return;
  try {
    const res = await fetch(`${API_BASE}/admin/nginx-logs/traffic?hours=${Math.min(nginxAnalyticsHours, 48)}`, { credentials: "include" });
    if (!res.ok) return;
    const rows = await res.json();
    const minuteMap = {};
    for (const r of rows) {
      const k = String(r.minute);
      if (!minuteMap[k]) minuteMap[k] = { ok: 0, warn: 0, err: 0 };
      const s = parseInt(r.status);
      const c = parseInt(r.count) || 0;
      if (s >= 500) minuteMap[k].err += c;
      else if (s >= 400) minuteMap[k].warn += c;
      else minuteMap[k].ok += c;
    }
    const keys = Object.keys(minuteMap).sort();
    const fmtLbl = k => {
      const d = new Date(k.includes("T") ? k : k.replace(" ", "T") + "Z");
      return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    };
    if (nginxChartTraffic) nginxChartTraffic.destroy();
    Chart.defaults.color = "#64748b"; Chart.defaults.font.family = "'Inter', sans-serif";
    nginxChartTraffic = new Chart(el("nginx-chart-traffic"), {
      type: "line",
      data: {
        labels: keys.map(fmtLbl),
        datasets: [
          { label: "2xx", data: keys.map(k => minuteMap[k].ok),   borderColor: "#059669", backgroundColor: "rgba(5,150,105,0.1)",   fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: "4xx", data: keys.map(k => minuteMap[k].warn), borderColor: "#d97706", backgroundColor: "rgba(217,119,6,0.08)",   fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: "5xx", data: keys.map(k => minuteMap[k].err),  borderColor: "#e11d48", backgroundColor: "rgba(225,29,72,0.12)", fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: {
          y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } },
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 10 } } }
        }
      }
    });
  } catch (e) { console.error("nginx traffic:", e); }
}

async function loadNginxTopPaths() {
  try {
    const res = await fetch(`${API_BASE}/admin/nginx-logs/top-paths?hours=${nginxAnalyticsHours}&limit=15`, { credentials: "include" });
    if (!res.ok) return;
    const rows = await res.json();
    const tbody = el("nginx-top-paths-body");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No data</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => {
      const errs = parseInt(r.errors || 0);
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:4px 8px; font-family:monospace; word-break:break-all; max-width:400px;">${escHtml(String(r.path || ""))}</td>
        <td style="padding:4px 8px; text-align:right;">${fmt(parseInt(r.total || 0))}</td>
        <td style="padding:4px 8px; text-align:right; color:${errs > 0 ? "var(--error)" : "inherit"}">${fmt(errs)}</td>
        <td style="padding:4px 8px; text-align:right;">${Math.round(parseFloat(r.avg_time || 0) * 1000)} ms</td>
        <td style="padding:4px 8px; text-align:right;">${Math.round(parseFloat(r.p95_time || 0) * 1000)} ms</td>
      </tr>`;
    }).join("");
  } catch (e) { console.error("nginx top paths:", e); }
}

async function loadNginxTopIPs() {
  try {
    const res = await fetch(`${API_BASE}/admin/nginx-logs/top-ips?hours=${nginxAnalyticsHours}&limit=10`, { credentials: "include" });
    if (!res.ok) return;
    const rows = await res.json();
    const container = el("nginx-top-ips-list");
    if (!rows.length) { container.innerHTML = `<div style="padding:8px;color:var(--text-muted)">No data</div>`; return; }
    const maxTotal = Math.max(...rows.map(r => parseInt(r.total || 0)), 1);
    container.innerHTML = rows.map(r => {
      const total = parseInt(r.total || 0);
      const errs  = parseInt(r.errors || 0);
      const pct   = Math.round(total / maxTotal * 100);
      const errPct = Math.round(errs / Math.max(total, 1) * 100);
      return `<div style="padding:5px 8px; border-bottom:1px solid var(--border);">
        <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
          <span style="font-family:monospace; font-size:11px;">${escHtml(String(r.remote_addr || ""))}</span>
          <span style="color:var(--text-muted); font-size:11px;">${fmt(total)}</span>
        </div>
        <div style="height:3px; background:var(--border); border-radius:2px;">
          <div style="height:3px; width:${pct}%; background:${errPct > 30 ? "var(--error)" : errPct > 10 ? "var(--warn)" : "var(--accent)"}; border-radius:2px;"></div>
        </div>
      </div>`;
    }).join("");
  } catch (e) { console.error("nginx top IPs:", e); }
}

async function loadNginxAnalytics() {
  await Promise.all([loadNginxOverview(), loadNginxTraffic(), loadNginxTopPaths(), loadNginxTopIPs()]);
}

function resetNginxFilters() {
  if (el("nginx-search-input")) el("nginx-search-input").value = "";
  if (el("nginx-status-select")) el("nginx-status-select").value = "";
  if (el("nginx-method-select")) el("nginx-method-select").value = "";
  if (el("nginx-sort-select")) el("nginx-sort-select").value = "desc";
  if (el("nginx-range-from-date")) el("nginx-range-from-date").value = "";
  if (el("nginx-range-from-hour")) el("nginx-range-from-hour").value = "00";
  if (el("nginx-range-from-minute")) el("nginx-range-from-minute").value = "00";
  if (el("nginx-range-to-date")) el("nginx-range-to-date").value = "";
  if (el("nginx-range-to-hour")) el("nginx-range-to-hour").value = "23";
  if (el("nginx-range-to-minute")) el("nginx-range-to-minute").value = "59";
  nginxPage = 0;
  loadNginxLogs();
}

// ── Analytics ─────────────────────────────────────────────────────────────────
let chartVol = null, chartSev = null;
async function loadAnalytics() {
  if (!window.Chart) return;
  const cidFilter = state.selectedStack && state.stackNames.length > 0
    ? `AND container_name IN (${state.stackNames.map(c => `'${esc(c)}'`).join(",")})`
    : "";
  try {
    const volData = await apiQuery(`
      SELECT toStartOfHour(timestamp) as t, count(), countIf(level='error'), countIf(level='warn' OR level='warning')
      FROM container_logs WHERE timestamp > now() - INTERVAL 24 HOUR ${cidFilter}
      GROUP BY t ORDER BY t ASC
    `);
    const labels = volData.map(r => {
      const s = String(r[0]);
      const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
      return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }).format(d) + ":00";
    });
    if (chartVol) chartVol.destroy();
    Chart.defaults.color = "#64748b"; Chart.defaults.font.family = "'Inter', sans-serif";
    chartVol = new Chart(el("chart-volume"), {
      type: "line",
      data: {
        labels, datasets: [
          { label: "Errors", data: volData.map(r => r[2]), borderColor: "#e11d48", backgroundColor: "rgba(225,29,72,0.1)", fill: true, tension: 0.3 },
          { label: "Warnings", data: volData.map(r => r[3]), borderColor: "#d97706", backgroundColor: "rgba(217,119,6,0.1)", fill: true, tension: 0.3 },
          { label: "Total", data: volData.map(r => r[1]), borderColor: "#4f46e5", backgroundColor: "rgba(79,70,229,0.05)", fill: true, tension: 0.3, borderDash: [5, 5] },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        scales: { y: { beginAtZero: true, grid: { color: "#e2e8f0" } }, x: { grid: { display: false } } }
      }
    });
    const sevData = await apiQuery(`
      SELECT if(level='','unknown',level) as lvl, count() as c FROM container_logs
      WHERE timestamp > now() - INTERVAL 24 HOUR ${cidFilter} GROUP BY lvl ORDER BY c DESC
    `);
    if (chartSev) chartSev.destroy();
    const sLabels = sevData.map(r => r[0]);
    const bgColors = sLabels.map(l => {
      l = String(l).toLowerCase();
      if (l === "error") return "#e11d48"; if (l === "warn" || l === "warning") return "#d97706";
      if (l === "info") return "#0ea5e9"; if (l === "debug") return "#7c3aed"; return "#94a3b8";
    });
    chartSev = new Chart(el("chart-severity"), {
      type: "doughnut",
      data: { labels: sLabels, datasets: [{ data: sevData.map(r => r[1]), backgroundColor: bgColors, borderWidth: 0, hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: "65%", plugins: { legend: { position: "right" } } }
    });
  } catch (e) { console.error("Analytics error:", e); }
}

// ── Clear DB Modal ────────────────────────────────────────────────────────────
function openClearModal() {
  el("modal-overlay").classList.remove("hidden");
  el("modal-error").classList.add("hidden");
  updateModalPreview();
}
function closeClearModal() { el("modal-overlay").classList.add("hidden"); }
function updateModalPreview() {
  const val = document.querySelector('input[name="clear-range"]:checked')?.value || "90";
  let sql;
  if (val === "all") sql = `TRUNCATE TABLE logs.container_logs`;
  else if (val === "7" || val === "30") sql = `ALTER TABLE logs.container_logs DELETE\n  WHERE timestamp < now() - INTERVAL ${val} DAY`;
  else { const d = new Date(); d.setDate(d.getDate() - 90); sql = `ALTER TABLE logs.container_logs\n  DROP PARTITION '${d.toISOString().slice(0, 7).replace("-", "")}'`; }
  el("modal-query-preview").textContent = sql;
}
async function executeClear() {
  const val = document.querySelector('input[name="clear-range"]:checked')?.value || "90";
  let sql;
  if (val === "all") sql = `TRUNCATE TABLE logs.container_logs`;
  else if (val === "7" || val === "30") sql = `ALTER TABLE logs.container_logs DELETE WHERE timestamp < now() - INTERVAL ${parseInt(val, 10)} DAY`;
  else { const d = new Date(); d.setDate(d.getDate() - 90); sql = `ALTER TABLE logs.container_logs DROP PARTITION '${d.toISOString().slice(0, 7).replace("-", "")}'`; }
  try {
    el("btn-modal-confirm").disabled = true; el("btn-modal-confirm").textContent = "Deleting…";
    await apiExec(sql);
    closeClearModal();
    await Promise.all([loadMetrics(), loadContainerList(), loadLogs()]);
  } catch (e) {
    el("modal-error").classList.remove("hidden");
    el("modal-error").textContent = "⚠ " + (e.message || "An error occurred");
  } finally {
    el("btn-modal-confirm").disabled = false; el("btn-modal-confirm").textContent = "Confirm Delete";
  }
}

// ── Export Panel ──────────────────────────────────────────────────────────────
// Tracks which container_names are selected for export
let exportSelectedContainers = [];   // [ { name, label } ]

function openExportPanel() {
  // Pre-fill with current context
  exportSelectedContainers = [];

  if (state.selectedStack && state.stackNames.length > 0) {
    exportSelectedContainers = state.stackNames.map(name => ({
      name: name, label: name
    }));
  }

  setCustomDateTime("export-from", getCustomDateTime("range-from"));
  setCustomDateTime("export-to", getCustomDateTime("range-to"));
  el("export-all-time").checked = false;
  el("export-status").classList.add("hidden");

  renderExportTags();
  el("export-overlay").classList.remove("hidden");
  el("export-stack-search").value = "";
  el("export-stack-results").classList.add("hidden");
  el("export-stack-search").focus();
}

function renderExportTags() {
  const container = el("export-selected-tags");
  container.innerHTML = "";
  if (!exportSelectedContainers.length) {
    container.innerHTML = `<span class="export-all-tag">All containers (no filter)</span>`;
    return;
  }
  exportSelectedContainers.forEach(({ name, label }) => {
    const tag = document.createElement("span");
    tag.className = "export-tag";
    tag.innerHTML = `${escHtml(label)} <button class="export-tag-remove" data-name="${escHtml(name)}">&times;</button>`;
    tag.querySelector(".export-tag-remove").addEventListener("click", () => {
      exportSelectedContainers = exportSelectedContainers.filter(c => c.name !== name);
      renderExportTags();
    });
    container.appendChild(tag);
  });
}

// Auto-search for export stack selection
el("export-stack-search").addEventListener("input", () => {
  const q = el("export-stack-search").value.toLowerCase().trim();
  const results = el("export-stack-results");
  if (!q) { results.classList.add("hidden"); return; }

  const matches = [];
  // Search stacks
  for (const [stackName, items] of Object.entries(folderDataMap)) {
    if (stackName.toLowerCase().includes(q))
      matches.push({ type: "stack", label: `📁 ${stackName}`, names: items.map(d => d.displayName), name: stackName });
  }
  // Search individual containers
  lastSidebarRows.forEach(([cname]) => {
    if (cname.toLowerCase().includes(q))
      matches.push({ type: "container", label: `📦 ${cname}`, names: [cname], name: cname });
  });

  if (!matches.length) { results.innerHTML = `<div class="export-no-result">No matches</div>`; results.classList.remove("hidden"); return; }

  results.innerHTML = "";
  matches.slice(0, 10).forEach(m => {
    const item = document.createElement("div");
    item.className = "export-result-item";
    item.textContent = m.label;
    item.addEventListener("click", () => {
      m.names.forEach(name => {
        if (!exportSelectedContainers.find(c => c.name === name))
          exportSelectedContainers.push({ name, label: name });
      });
      renderExportTags();
      el("export-stack-search").value = "";
      results.classList.remove("hidden");
    });
    results.appendChild(item);
  });
  results.classList.remove("hidden");
});

document.addEventListener("click", e => {
  if (!e.target.closest("#export-stack-search") && !e.target.closest("#export-stack-results"))
    el("export-stack-results").classList.add("hidden");
});

el("export-all-time").addEventListener("change", () => {
  const checked = el("export-all-time").checked;
  el("export-from").disabled = checked;
  el("export-to").disabled = checked;
});

el("btn-export-confirm").addEventListener("click", async () => {
  const btn = el("btn-export-confirm");
  const status = el("export-status");
  const allTime = el("export-all-time").checked;

  const params = new URLSearchParams();
  if (exportSelectedContainers.length > 0)
    params.set("container_names", exportSelectedContainers.map(c => c.name).join(","));

  const fromTs = getCustomDateTime("export-from");
  const toTs = getCustomDateTime("export-to");

  if (!allTime && fromTs)
    params.set("from_ts", fromTs.replace("T", " ") + ":00");
  if (!allTime && toTs)
    params.set("to_ts", toTs.replace("T", " ") + ":00");

  btn.disabled = true;
  btn.textContent = "Preparing…";
  status.textContent = "⏳ Generating export from ClickHouse…";
  status.className = "export-status";
  status.classList.remove("hidden");

  // Using direct location change for standard browser download handling
  // This is better for large files and works well since we use cookies for auth
  const downloadUrl = `${API_BASE}/export?${params.toString()}`;
  window.location.href = downloadUrl;

  status.textContent = "✅ Download started (check your browser downloads)";
  status.classList.add("success");
  setTimeout(() => el("export-overlay").classList.add("hidden"), 3000);
  btn.disabled = false;
  btn.textContent = "⬇ Download JSV";
});

el("btn-export-cancel").addEventListener("click", () => el("export-overlay").classList.add("hidden"));
el("export-overlay").addEventListener("click", e => {
  if (e.target === el("export-overlay")) el("export-overlay").classList.add("hidden");
});

// ── Notifications (SSE) ───────────────────────────────────────────────────────
let sseSource = null;

function initSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(`${API_BASE}/notifications/stream`, { withCredentials: true });
  sseSource.onmessage = (event) => {
    try {
      const notif = JSON.parse(event.data);
      addNotification(notif);
    } catch { }
  };
  sseSource.onerror = () => {
    // Reconnect after 10s if connection drops
    sseSource.close();
    setTimeout(initSSE, 10_000);
  };
}

async function loadNotifications() {
  try {
    const res = await fetch(`${API_BASE}/notifications`, { credentials: "include" });
    if (!res.ok) return;
    const notifs = await res.json();
    state.notifications = notifs;
    state.unreadCount = notifs.filter(n => !n.read).length;
    renderNotifications();
    updateNotifBadge();
  } catch { }
}

function addNotification(notif) {
  // Prevent duplicates
  if (state.notifications.find(n => n.id === notif.id)) return;
  state.notifications.unshift({ ...notif, read: false });
  state.unreadCount++;
  renderNotifications();
  updateNotifBadge();
  // Flash the bell
  const bell = el("btn-notif");
  bell.classList.add("bell-ring");
  setTimeout(() => bell.classList.remove("bell-ring"), 1000);
}

function updateNotifBadge() {
  const badge = el("notif-badge");
  if (state.unreadCount > 0) {
    badge.textContent = state.unreadCount > 99 ? "99+" : state.unreadCount;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderNotifications() {
  const list = el("notif-list");
  list.innerHTML = `
    <div class="notif-filter" style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:10px;font-size:11px;">
      <label><input type="radio" name="notif-filter" value="all" ${state.notifFilter === "all" ? "checked" : ""}> All</label>
      <label><input type="radio" name="notif-filter" value="container_down" ${state.notifFilter === "container_down" ? "checked" : ""}> Downtime</label>
      <label><input type="radio" name="notif-filter" value="log_spam" ${state.notifFilter === "log_spam" ? "checked" : ""}> Spam/DDOS</label>
      <label><input type="radio" name="notif-filter" value="container_recovered" ${state.notifFilter === "container_recovered" ? "checked" : ""}> Recovered</label>
    </div>
    <div id="notif-items-container">
      ${renderNotifItems(state.notifFilter)}
    </div>
  `;

  // Filter events
  list.querySelectorAll('input[name="notif-filter"]').forEach(r => {
    r.addEventListener("change", () => {
      state.notifFilter = r.value;
      el("notif-items-container").innerHTML = renderNotifItems(state.notifFilter);
    });
  });
}

function renderNotifItems(filter = "all") {
  const filtered = filter === "all" ? state.notifications : state.notifications.filter(n => n.type === filter);
  if (!filtered.length) return `<div class="notif-empty">No ${filter === "all" ? "" : "relevant"} critical alerts</div>`;

  return filtered.slice(0, 20).map(n => `
    <div class="notif-item ${n.read ? "notif-read" : "notif-unread"}" data-id="${n.id}">
      <div class="notif-item-title">${escHtml(n.title)}</div>
      <div class="notif-item-msg">${escHtml(n.message)}</div>
      <div class="notif-item-meta">
        ${n.container_name ? `<span class="notif-container">${escHtml(n.container_name)}</span>` : ""}
        <span class="notif-time">${formatTs(n.created_at || new Date().toISOString())}</span>
      </div>
    </div>
  `).join("");
}

el("btn-notif").addEventListener("click", (e) => {
  e.stopPropagation();
  el("notif-dropdown").classList.toggle("hidden");
});
document.addEventListener("click", e => {
  if (!e.target.closest("#notif-wrapper")) el("notif-dropdown").classList.add("hidden");
});

el("btn-mark-read").addEventListener("click", async () => {
  await fetch(`${API_BASE}/notifications/read`, { method: "POST", credentials: "include" });
  state.notifications.forEach(n => n.read = true);
  state.unreadCount = 0;
  updateNotifBadge();
  renderNotifications();
});

// ── Admin Panel ───────────────────────────────────────────────────────────────
async function loadAdminPanel() {
  await Promise.all([loadUserList(), loadOwnershipList()]);
}

async function loadUserList(q = "") {
  try {
    const res = await fetch(`${API_BASE}/admin/users?q=${encodeURIComponent(q)}`, { credentials: "include" });
    if (!res.ok) return;
    const users = await res.json();
    const list = el("user-list");
    if (!users.length) { list.innerHTML = `<div class="admin-empty">No users found</div>`; return; }

    // Also populate assign dropdown
    const sel = el("assign-user-select");
    sel.innerHTML = `<option value="">— Select user —</option>`;
    users.forEach(u => {
      const opt = document.createElement("option");
      opt.value = u.id; opt.textContent = `${u.username} (${u.role})`;
      sel.appendChild(opt);
    });

    list.innerHTML = users.map(u => `
      <div class="admin-user-row">
        <div class="admin-user-info">
          <span class="admin-username">${escHtml(u.username)}</span>
          <span class="admin-email">${escHtml(u.email || "—")}</span>
        </div>
        <div class="admin-user-actions">
          <select class="role-select" data-uid="${u.id}" ${state.user?.role !== "super_admin" ? "disabled" : ""}>
            <option value="developer" ${u.role === "developer" ? "selected" : ""}>Developer</option>
            <option value="admin"     ${u.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
          <button class="btn-save-role btn-primary" data-uid="${u.id}"
                  style="font-size:11px;padding:4px 8px;"
                  ${state.user?.role !== "super_admin" ? "disabled" : ""}>
            Save
          </button>
        </div>
      </div>
    `).join("");

    list.querySelectorAll(".btn-save-role").forEach(btn => {
      btn.addEventListener("click", async () => {
        const uid = parseInt(btn.dataset.uid);
        const role = list.querySelector(`.role-select[data-uid="${uid}"]`).value;
        try {
          await fetch(`${API_BASE}/admin/users/role`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: uid, role }),
          });
          btn.textContent = "✓ Saved";
          setTimeout(() => btn.textContent = "Save", 2000);
        } catch { btn.textContent = "❌ Error"; }
      });
    });
  } catch (e) { el("user-list").innerHTML = `<div class="admin-empty">Error loading users</div>`; }
}

// Container Ownership State
let currentOwnership = [];
let assignSelectedContainers = []; // [ { name, label } ]

async function loadOwnershipList() {
  try {
    const res = await fetch(`${API_BASE}/admin/containers/ownership`, { credentials: "include" });
    if (res.ok) currentOwnership = await res.json();
    renderOwnershipList();
  } catch { }
}

function renderOwnershipList() {
  const list = el("ownership-list");
  const uid = el("assign-user-select").value;

  if (!uid) {
    list.innerHTML = `<div class="admin-empty">Select a user above to see their containers</div>`;
    el("container-assign-search").disabled = true;
    el("btn-assign-container").disabled = true;
    return;
  }

  el("container-assign-search").disabled = false;
  el("btn-assign-container").disabled = assignSelectedContainers.length === 0;

  const rows = currentOwnership.filter(r => String(r.user_id) === String(uid));
  if (!rows.length) {
    list.innerHTML = `<div class="admin-empty">No ownership assignments for this user</div>`;
    return;
  }

  list.innerHTML = rows.map(r => {
    const displayName = r.container_name || r.container_id;
    const cid = r.container_id || r.container_name;
    return `
      <div class="admin-ownership-row">
        <span class="admin-uname" style="font-weight:600;">${escHtml(displayName)}</span>
        <span class="admin-arrow">→</span>
        <span class="admin-uname">${escHtml(r.username)}</span>
        <button class="btn-revoke btn-danger" data-cid="${escHtml(cid)}" data-uid="${r.user_id}"
                style="font-size:11px;padding:3px 8px;margin-left:auto;">Revoke</button>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".btn-revoke").forEach(btn => {
    btn.addEventListener("click", async () => {
      await fetch(`${API_BASE}/admin/containers/assign?container_name=${encodeURIComponent(btn.dataset.cid)}&user_id=${btn.dataset.uid}`, { method: "DELETE", credentials: "include" });
      loadOwnershipList();
    });
  });
}

el("assign-user-select").addEventListener("change", () => {
  assignSelectedContainers = [];
  renderAssignTags();
  renderOwnershipList();
});

function renderAssignTags() {
  const container = el("assign-selected-tags");
  container.innerHTML = "";
  assignSelectedContainers.forEach(({ id, label }) => {
    const tag = document.createElement("span");
    tag.className = "export-tag";
    tag.innerHTML = `${escHtml(label)} <button class="export-tag-remove" data-id="${escHtml(id)}">&times;</button>`;
    tag.querySelector(".export-tag-remove").addEventListener("click", () => {
      assignSelectedContainers = assignSelectedContainers.filter(c => c.id !== id);
      renderAssignTags();
      el("btn-assign-container").disabled = assignSelectedContainers.length === 0;
    });
    container.appendChild(tag);
  });
  el("btn-assign-container").disabled = assignSelectedContainers.length === 0 || !el("assign-user-select").value;
}

el("container-assign-search").addEventListener("input", () => {
  const q = el("container-assign-search").value.toLowerCase().trim();
  const results = el("assign-container-results");
  const uid = el("assign-user-select").value;
  if (!q || !uid) { results.classList.add("hidden"); return; }

  const ownedIds = currentOwnership.filter(r => String(r.user_id) === String(uid)).map(r => r.container_id || r.container_name);

  const matches = [];
  lastSidebarRows.forEach(row => {
    const [cname] = row;
    if (ownedIds.includes(cname) || assignSelectedContainers.find(c => c.id === cname)) return;
    if (cname.toLowerCase().includes(q)) {
      matches.push({ type: "container", label: `📦 ${cname}`, id: cname, name: cname });
    }
  });

  if (!matches.length) { results.innerHTML = `<div class="export-no-result">No matches</div>`; results.classList.remove("hidden"); return; }

  results.innerHTML = "";
  matches.slice(0, 10).forEach(m => {
    const item = document.createElement("div");
    item.className = "export-result-item";
    item.textContent = m.label;
    item.addEventListener("click", () => {
      assignSelectedContainers.push({ id: m.id, label: m.name });
      renderAssignTags();
      el("container-assign-search").value = "";
      results.classList.add("hidden");
    });
    results.appendChild(item);
  });
  results.classList.remove("hidden");
});

document.addEventListener("click", e => {
  if (!e.target.closest("#container-assign-search") && !e.target.closest("#assign-container-results"))
    el("assign-container-results")?.classList.add("hidden");
});

el("btn-assign-container").addEventListener("click", async () => {
  const uid = parseInt(el("assign-user-select").value);
  if (!uid || assignSelectedContainers.length === 0) return;

  el("btn-assign-container").disabled = true;
  el("btn-assign-container").textContent = "Assigning...";

  try {
    for (const c of assignSelectedContainers) {
      const res = await fetch(`${API_BASE}/admin/containers/assign`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ container_name: c.id, user_id: uid }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Assign failed for ${c.id}`);
      }
    }
    assignSelectedContainers = [];
    renderAssignTags();
    loadOwnershipList();
  } catch (err) {
    alert(`Failed to assign some containers.\n${err?.message || ""}`.trim());
  } finally {
    el("btn-assign-container").disabled = false;
    el("btn-assign-container").textContent = "Assign Containers";
  }
});

// User search debounce
let userSearchTimer = null;
el("user-search").addEventListener("input", () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(() => loadUserList(el("user-search").value), 300);
});

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings`, { credentials: "include" });
    if (!res.ok) return;
    state.settings = await res.json();

    // Populate settings inputs
    if (el("setting-ttl")) el("setting-ttl").value = state.settings.ttl_days || "90";
    if (el("setting-green")) el("setting-green").value = state.settings.dot_green_threshold_sec || "60";
    if (el("setting-amber")) el("setting-amber").value = state.settings.dot_amber_threshold_sec || "300";
    if (el("setting-color-green")) el("setting-color-green").value = state.settings.active_color_green || "#059669";
  } catch { }
}

document.querySelectorAll(".btn-save-setting").forEach(btn => {
  btn.addEventListener("click", async () => {
    const key = btn.dataset.key;
    const val = el(btn.dataset.src).value;
    try {
      await fetch(`${API_BASE}/settings`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: val }),
      });
      btn.textContent = "✓";
      setTimeout(() => btn.textContent = "Save", 1500);
      // Update local state
      state.settings[key] = val;
      if (key === "active_color_green") document.documentElement.style.setProperty("--success", val);
    } catch { btn.textContent = "❌"; }
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────
document.querySelectorAll(".btn-save-setting").forEach(btn => {
  btn.addEventListener("click", async () => {
    const key = btn.dataset.key;
    const inputId = btn.dataset.src;
    const val = el(inputId).value;
    try {
      btn.textContent = "⌛";
      await fetch(`${API_BASE}/settings?key=${key}&value=${encodeURIComponent(val)}`, {
        method: "POST", credentials: "include"
      });
      btn.textContent = "✅";
      setTimeout(() => btn.textContent = "Save", 1500);
      state.settings[key] = val;
      if (key === "active_color_green") document.documentElement.style.setProperty("--success", val);
    } catch { btn.textContent = "❌"; }
  });
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
el("tab-logs").addEventListener("click", () => {
  state.view = "logs";
  el("tab-logs").classList.add("active");
  el("tab-analytics").classList.remove("active");
  el("tab-admin").classList.remove("active");
  el("tab-nginx").classList.remove("active");
  el("logs-view-wrapper").classList.remove("hidden");
  el("analytics-section").classList.add("hidden");
  el("admin-section").classList.add("hidden");
  el("nginx-view-wrapper").classList.add("hidden");
  stopNginxSSE();
  startLogsSSE();
});

el("tab-analytics").addEventListener("click", () => {
  state.view = "analytics";
  el("tab-analytics").classList.add("active");
  el("tab-logs").classList.remove("active");
  el("tab-admin").classList.remove("active");
  el("tab-nginx").classList.remove("active");
  el("analytics-section").classList.remove("hidden");
  el("logs-view-wrapper").classList.add("hidden");
  el("admin-section").classList.add("hidden");
  el("nginx-view-wrapper").classList.add("hidden");
  loadAnalytics();
  stopLogsSSE();
});

el("tab-admin").addEventListener("click", () => {
  state.view = "admin";
  el("tab-admin").classList.add("active");
  el("tab-logs").classList.remove("active");
  el("tab-analytics").classList.remove("active");
  el("tab-nginx").classList.remove("active");
  el("admin-section").classList.remove("hidden");
  el("logs-view-wrapper").classList.add("hidden");
  el("analytics-section").classList.add("hidden");
  el("nginx-view-wrapper").classList.add("hidden");
  loadAdminPanel();
  stopNginxSSE();
  stopLogsSSE();
});

el("tab-nginx").addEventListener("click", () => {
  state.view = "nginx";
  el("tab-nginx").classList.add("active");
  el("tab-logs").classList.remove("active");
  el("tab-analytics").classList.remove("active");
  el("tab-admin").classList.remove("active");
  el("nginx-view-wrapper").classList.remove("hidden");
  el("logs-view-wrapper").classList.add("hidden");
  el("analytics-section").classList.add("hidden");
  loadNginxAnalytics();
  el("admin-section").classList.add("hidden");
  startNginxSSE();
  loadNginxLogs();
  stopLogsSSE();
});

// ── Tooltip helpers ───────────────────────────────────────────────────────────
function _ensureStackTooltip() {
  if (window._stackTooltip) return window._stackTooltip;
  const t = document.createElement("div");
  t.className = "stack-tooltip";
  Object.assign(t.style, {
    position: "fixed", zIndex: "1200", padding: "8px 10px",
    background: "rgba(15,23,42,0.95)", color: "#fff", borderRadius: "6px",
    fontSize: "12px", maxWidth: "320px", boxShadow: "0 6px 18px rgba(2,6,23,0.45)",
    display: "none", pointerEvents: "none"
  });
  document.body.appendChild(t);
  window._stackTooltip = t;
  return t;
}
function showStackTooltip(el, text, evt, isHtml = false) {
  try {
    const t = _ensureStackTooltip();
    if (isHtml) t.innerHTML = text; else t.textContent = text;
    t.style.display = "block";
    const x = evt?.clientX ? evt.clientX + 12 : el.getBoundingClientRect().left + 8;
    const y = evt?.clientY ? evt.clientY + 12 : el.getBoundingClientRect().bottom + 6;
    const rect = t.getBoundingClientRect();
    t.style.left = Math.max(8, x + rect.width > window.innerWidth - 8 ? window.innerWidth - rect.width - 8 : x) + "px";
    t.style.top = Math.max(8, y + rect.height > window.innerHeight - 8 ? el.getBoundingClientRect().top - rect.height - 8 : y) + "px";
  } catch { }
}
function hideStackTooltip() { if (window._stackTooltip) window._stackTooltip.style.display = "none"; }

// ── New Stack button ──────────────────────────────────────────────────────────
el("btn-new-stack").addEventListener("click", () => {
  const name = prompt("Enter new Stack name:");
  if (name?.trim()) {
    const s = STORAGE.getStacks(); if (!s[name]) s[name] = []; STORAGE.saveStacks(s); renderSidebar();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  try {
    console.log("[INIT] Starting dashboard initialization...");
    // Populate hour and minute select options
    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    const mins = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

    ["range-from-hour", "range-to-hour", "export-from-hour", "export-to-hour"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = hours.map(v => `<option value="${v}">${v}</option>`).join("");
    });
    ["range-from-minute", "range-to-minute", "export-from-minute", "export-to-minute"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = mins.map(v => `<option value="${v}">${v}</option>`).join("");
    });

    // Nginx time selects
    ["nginx-range-from-hour", "nginx-range-to-hour"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = hours.map(v => `<option value="${v}">${v}</option>`).join("");
    });
    ["nginx-range-from-minute", "nginx-range-to-minute"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = mins.map(v => `<option value="${v}">${v}</option>`).join("");
    });

    // Filter bar
    const applyBtn = el("btn-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        state.search = (el("search-input")?.value || "").trim();
        state.level = el("level-select")?.value || "";
        state.sortDir = el("sort-select")?.value || "DESC";
        state.fromDate = getCustomDateTime("range-from");
        state.toDate = getCustomDateTime("range-to");
        state.page = 0;
        stopLogsSSE();
        startLogsSSE();
        loadLogs();
      });
    }
    el("btn-reset").addEventListener("click", () => {
      state.search = state.level = ""; state.fromDate = state.toDate = null;
      state.sortDir = "DESC"; state.page = 0;
      ["search-input", "level-select", "sort-select"].forEach(id => el(id).value = "");
      setCustomDateTime("range-from", null);
      setCustomDateTime("range-to", null);
      el("sort-select").value = "DESC";
      stopLogsSSE();
      startLogsSSE();
      loadLogs();
    });
    el("search-input").addEventListener("keydown", e => { if (e.key === "Enter") el("btn-apply").click(); });

    // Admin Panel listeners (User search, etc.)
    const userSearch = el("user-search");
    if (userSearch) {
      userSearch.addEventListener("input", (e) => {
        loadUserList(e.target.value.trim());
      });
    }

    // Container Assignment search
    const assignSearch = el("container-assign-search");
    if (assignSearch) {
      assignSearch.addEventListener("input", () => {
        const q = assignSearch.value.toLowerCase().trim();
        const results = el("assign-container-results");
        if (!q) { results.classList.add("hidden"); return; }

        const matches = [];
        lastSidebarRows.forEach(([cname]) => {
          if (cname.toLowerCase().includes(q))
            matches.push({ id: cname, label: cname });
        });

        if (!matches.length) { results.innerHTML = `<div class="export-no-result">No containers found</div>`; results.classList.remove("hidden"); return; }

        results.innerHTML = "";
        matches.slice(0, 10).forEach(m => {
          const item = document.createElement("div");
          item.className = "export-result-item";
          item.textContent = m.label;
          item.addEventListener("click", () => {
            if (!assignSelectedContainers.find(c => c.id === m.id)) {
              assignSelectedContainers.push(m);
              renderAssignTags();
              el("btn-assign-container").disabled = false;
            }
            assignSearch.value = "";
            results.classList.add("hidden");
          });
          results.appendChild(item);
        });
        results.classList.remove("hidden");
      });
    }

    el("btn-assign-container").addEventListener("click", async () => {
      const uid = el("assign-user-select").value;
      if (!uid || !assignSelectedContainers.length) return;
      const btn = el("btn-assign-container");
      btn.disabled = true; btn.textContent = "Assigning…";
      try {
        for (const c of assignSelectedContainers) {
          await fetch(`${API_BASE}/admin/containers/assign?container_name=${encodeURIComponent(c.id)}&user_id=${uid}`, {
            method: "POST", credentials: "include"
          });
        }
        assignSelectedContainers = [];
        renderAssignTags();
        loadOwnershipList();
        btn.textContent = "✓ Assigned";
      } catch { btn.textContent = "❌ Error"; }
      finally {
        setTimeout(() => { btn.disabled = false; btn.textContent = "Assign"; }, 2000);
      }
    });

    document.addEventListener("click", e => {
      if (!e.target.closest("#container-assign-search") && !e.target.closest("#assign-container-results"))
        el("assign-container-results").classList.add("hidden");
    });

    // Pagination
    el("btn-prev").addEventListener("click", () => { stopLogsSSE(); state.page--; startLogsSSE(); loadLogs(); });
    el("btn-next").addEventListener("click", () => { stopLogsSSE(); state.page++; loadLogs(); });

    // Nginx filters
    el("btn-nginx-apply")?.addEventListener("click", () => { stopNginxSSE(); nginxPage = 0; startNginxSSE(); loadNginxLogs(); });
    el("btn-nginx-reset")?.addEventListener("click", () => { stopNginxSSE(); resetNginxFilters(); startNginxSSE(); });
    el("btn-nginx-refresh")?.addEventListener("click", () => { stopNginxSSE(); startNginxSSE(); loadNginxLogs(); });
    el("btn-nginx-prev")?.addEventListener("click", () => { stopNginxSSE(); nginxPage--; loadNginxLogs(); });
    el("btn-nginx-next")?.addEventListener("click", () => { stopNginxSSE(); nginxPage++; loadNginxLogs(); });
    // Nginx analytics controls
    el("nginx-hours-select")?.addEventListener("change", e => { nginxAnalyticsHours = parseInt(e.target.value); loadNginxAnalytics(); });
    el("btn-nginx-analytics-refresh")?.addEventListener("click", loadNginxAnalytics);

    // Refresh
    el("btn-refresh").addEventListener("click", refresh);

    // Clear DB (admin only)
    el("btn-clear-db").addEventListener("click", openClearModal);
    el("btn-modal-cancel").addEventListener("click", closeClearModal);
    el("btn-modal-confirm").addEventListener("click", executeClear);
    document.querySelectorAll('input[name="clear-range"]').forEach(r => r.addEventListener("change", updateModalPreview));
    el("modal-overlay").addEventListener("click", e => { if (e.target === el("modal-overlay")) closeClearModal(); });

    // Backup button
    const backupBtn = el("btn-trigger-backup");
    if (backupBtn) {
      backupBtn.addEventListener("click", async () => {
        if (!confirm("คุณต้องการเริ่มกระบวนการ Backup ทันทีหรือไม่?\n(PostgreSQL + ClickHouse)")) return;

        backupBtn.disabled = true;
        backupBtn.textContent = "⏳ Processing...";

        try {
          const res = await fetch(`${API_BASE}/admin/backup/trigger`, {
            method: "POST",
            credentials: "include"
          });
          if (res.ok) {
            alert("🚀 Backup started!\nระบบกำลังทำงานในพื้นหลัง (Background)\nไฟล์จะถูกเก็บไว้ใน /mnt");
          } else {
            const data = await res.json().catch(() => ({}));
            alert(`❌ Backup failed: ${data.detail || "Unknown error"}`);
          }
        } catch (err) {
          alert(`❌ Error connecting to server: ${err.message}`);
        } finally {
          backupBtn.disabled = false;
          backupBtn.textContent = "🚀 Start Backup";
        }
      });
    }

    // Export
    el("btn-export").addEventListener("click", openExportPanel);

    // Info icon tooltip
    const infoIcon = document.querySelector(".sidebar-legend .info-icon");
    if (infoIcon) {
      const legend = infoIcon.closest(".sidebar-legend");
      if (legend?.hasAttribute("title")) { legend.setAttribute("aria-label", legend.getAttribute("title")); legend.removeAttribute("title"); }
      infoIcon.removeAttribute("title");
      const infoHtml = `
      <div style="margin-bottom:6px;font-weight:600;">Dot Color Legend:</div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-dot green" style="width:10px;height:10px;"></span><span>&lt; 1m (Active)</span></span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-dot amber" style="width:10px;height:10px;"></span><span>&lt; 5m (Recent)</span></span>
        <span style="display:inline-flex;align-items:center;gap:6px;"><span class="legend-dot red" style="width:10px;height:10px;"></span><span>&gt; 5m (Inactive)</span></span>
      </div>`;
      infoIcon.addEventListener("mouseenter", e => showStackTooltip(infoIcon, infoHtml, e, true));
      infoIcon.addEventListener("mousemove", e => showStackTooltip(infoIcon, infoHtml, e, true));
      infoIcon.addEventListener("mouseleave", () => hideStackTooltip());
    }

    // Check auth, then load data
    checkAuth().then(ok => {
      if (!ok) return;
      loadSettings();
      loadNotifications();
      loadContainerAliases();
      initSSE();
      startLogsSSE();
      refresh();
      setInterval(refresh, 30_000);
      setInterval(loadNotifications, 60_000);
    }).catch(e => console.error("[INIT] Auth/Load chain failed", e));
  } catch (err) {
    console.error("[INIT] Critical initialization error", err);
  }
}

async function refresh() {
  try {
    const btn = el("btn-refresh");
    if (btn) btn.textContent = "↻ …";
    await Promise.all([
      loadContainerAliases(),
      loadMetrics(),
      loadContainerList(),
      loadLogs()
    ]);
    if (btn) btn.textContent = "↻ Refresh";
  } catch (e) {
    console.error("[REFRESH] failed", e);
    const btn = el("btn-refresh");
    if (btn) btn.textContent = "↻ Error";
  }
}

document.addEventListener("DOMContentLoaded", init);
