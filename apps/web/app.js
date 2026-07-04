/**
 * app.js - Container Log Dashboard v2
 * =====================================
 * - Auth: Redis session cookie via /logstore/api/auth, redirects to /logstore/login if not authenticated
 * - ClickHouse queries proxied through FastAPI /logstore/api/query (role-filtered)
 * - Export: JSV via /logstore/api/export with stack/time selection
 * - Notifications: SSE via /logstore/api/notifications/stream + in-memory history
 * - Admin panel: user management, container ownership (super_admin / admin only)
 */

"use strict";

//  Config 
const API_BASE = "/logstore/api";
if (window.LogDashApi) window.LogDashApi.configure({ apiBase: API_BASE });

// Legacy/optional surfaces kept in code for future platform expansion.
// They are hidden by default while the product focuses on centralized
// observability: Overview, Logs, Analytics, and Admin.
const UI_FEATURES = Object.freeze({
  analytics: true,
  gateway: true,        // formerly Nginx/Gateway tab
  patterns: true,       // experimental log-pattern clustering
  externalTools: false, // old Grafana/ClickHouse UI shortcuts
});

function isFeatureEnabled(name) {
  return UI_FEATURES[name] === true;
}

//  Cross-tab session sync 
const _authChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("logdash_auth") : null;
if (_authChannel) {
  _authChannel.onmessage = (e) => {
    if (e.data?.type === "logout") window.location.href = "/logstore/login";
    if (e.data?.type === "login") window.location.reload();
  };
}

// Re-verify session when tab regains focus (catches expiry / logout from another tab)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    fetch(`${API_BASE}/auth/me`, { credentials: "include" })
      .then(r => { if (r.status === 401) window.location.href = "/logstore/login"; })
      .catch(() => { });
  }
});
const PAGE_SIZE = Math.max(20, Math.floor((window.innerHeight - 220) / 32));
const MAX_LOG_ROWS_IN_DOM = PAGE_SIZE;
const LOG_MESSAGE_PREVIEW_LIMIT = 1000;

//  State 
let state = {
  user: null,             // { username, role, user_id, display_name }
  selectedStack: null,
  stackNames: [],
  selectedProject: null,
  selectedService: null,   // { service_key, host_id, compose_project, compose_service }
  search: "",
  level: "",
  sortDir: "DESC",
  fromDate: null,
  toDate: null,
  page: 0,
  totalRows: 0,
  view: "overview",       // "overview" | "logs" | "analytics" | "admin"
  overview: null,
  platformHealth: null,
  platformRuntime: null,
  platformUptime: null,
  platformIncidentBundle: null,
  settings: {},
  notifications: [],
  alertRules: [],
  unreadCount: 0,
  notifFilter: "all",
  analyticsDetail: null,  // { fromDate, toDate, level, label }
  analyticsHourFilter: null,  // { fromDate, toDate } for selected hour
  analyticsLevelFilter: null, // level string for donut click
  analyticsPendingViewLogs: null,  // { fromDate, toDate, level } - saved before navigating to Logs
  lastBackupId: null,  // Track last backup ID for animation
};

//  Helpers 
const el = id => document.getElementById(id);
const esc = s => String(s).replace(/'/g, "''");
const escLike = s => esc(s).replace(/[%_\\]/g, c => "\\" + c);
function ansiToHtml(str) {
  if (!str) return "";
  const colors = {
    "30": "var(--text-dim)", // black
    "31": "#ef4444",         // red
    "32": "#22c55e",         // green
    "33": "#f59e0b",         // yellow
    "34": "#3b82f6",         // blue
    "35": "#a855f7",         // magenta
    "36": "#06b6d4",         // cyan
    "37": "#f8fafc",         // white
    "90": "#94a3b8",         // gray
  };
  let result = escHtml(str);
  // Basic ANSI color/style support
  // 1. Bold: [1m
  result = result.replace(/\[1m/g, "<strong>");
  // 2. Colors: [31m, [90m, etc.
  result = result.replace(/\[(\d+)m/g, (match, code) => {
    if (colors[code]) return `<span style="color:${colors[code]}">`;
    if (code === "0") return "</span></strong>"; // Reset
    return "";
  });
  // Close any tags that might still be open (rough safety)
  const openSpans = (result.match(/<span/g) || []).length;
  const closeSpans = (result.match(/<\/span/g) || []).length;
  for (let i = 0; i < openSpans - closeSpans; i++) result += "</span>";
  const openStrong = (result.match(/<strong/g) || []).length;
  const closeStrong = (result.match(/<\/strong/g) || []).length;
  for (let i = 0; i < openStrong - closeStrong; i++) result += "</strong>";

  result = result.replace(/\n/g, "<br>");
  return result;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmt(n) {
  const num = parseInt(n, 10);
  if (isNaN(num)) return "--";
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
    el(`${prefix}-hour`).value = "";
    el(`${prefix}-minute`).value = "";
    return;
  }
  const iso = dateStr.includes("Z") ? toLocalISO(new Date(dateStr)) : dateStr.slice(0, 19);
  const [dp, tp] = iso.split("T");
  el(`${prefix}-date`).value = dp;
  const [h, m] = tp.split(":");
  el(`${prefix}-hour`).value = h;
  el(`${prefix}-minute`).value = m;
}

//  Auth 
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
    if (state.user.sso_raw) {
      console.log("[SSO/AUTH] Raw SSO UserInfo:", state.user.sso_raw);
    }
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

  // Clear DB button  admin + super_admin only
  const clearBtn = el("btn-clear-db");
  if (clearBtn) clearBtn.classList.toggle("hidden", !isAdmin);

  // Admin tab  admin + super_admin
  const adminTab = el("tab-admin");
  if (adminTab) adminTab.classList.toggle("hidden", !isAdmin);

  // Nginx tab  admin + super_admin only
  const nginxTab = el("tab-nginx");
  if (nginxTab) nginxTab.classList.toggle("hidden", !(isAdmin && isFeatureEnabled("gateway")));

  // Patterns tab  all authenticated users
  el("tab-patterns")?.classList.toggle("hidden", !isFeatureEnabled("patterns"));

  // Settings panel  admin + super_admin
  const settingsPanel = el("sidebar-settings");
  if (settingsPanel) settingsPanel.classList.toggle("hidden", !isAdmin);

  // Monitor dashboard button  admin + super_admin only
  const monitorBtn = el("btn-monitor-linked");
  if (monitorBtn) monitorBtn.classList.toggle("hidden", !(isAdmin && isFeatureEnabled("externalTools")));

  // ClickHouse UI button  admin + super_admin only
  const chBtn = el("btn-clickhouse-linked");
  if (chBtn) chBtn.classList.toggle("hidden", !(isAdmin && isFeatureEnabled("externalTools")));
}

el("btn-logout").addEventListener("click", async () => {
  await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  if (_authChannel) _authChannel.postMessage({ type: "logout" });
  window.location.href = "/logstore/login";
});

//  API helpers 
async function apiQuery(sql, signal) {
  const res = await fetch(`${API_BASE}/query?q=${encodeURIComponent(sql)}`, {
    credentials: "include",
    signal,
  });
  if (res.status === 401) { window.location.href = "/logstore/login"; return []; }
  if (!res.ok) throw new Error(`Query failed (${res.status})`);
  const json = await res.json();
  return json.data || [];
}

let _logsAbortController = null;
let _metricsAbortController = null;
let _containerListAbortController = null;
let _selectStackTimer = null;

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

//  Build WHERE clause 
function buildWhere(includeStack = true) {
  const parts = [];
  if (includeStack && state.selectedService) {
    const svc = state.selectedService;
    if (svc.host_id) parts.push(`HostName = '${esc(svc.host_id)}'`);
    if (svc.compose_project) parts.push(`ComposeProject = '${esc(svc.compose_project)}'`);
    if (svc.compose_service) {
      parts.push(`ResourceAttributes['container.label.com.docker.compose.service'] = '${esc(svc.compose_service)}'`);
    }
  } else if (includeStack && state.selectedStack && state.stackNames.length > 0) {
    const cnames = state.stackNames.map(c => `'${esc(c)}'`).join(",");
    parts.push(`ContainerName IN (${cnames})`);
    if (state.selectedProject) {
      parts.push(`ComposeProject = '${esc(state.selectedProject)}'`);
    }
  }
  if (state.level) {
    const lvl = state.level.toLowerCase();
    const isError = "Body ILIKE '%ERR%' OR Body ILIKE '%ERROR%'";
    const isWarn = "Body ILIKE '%WARN%' OR Body ILIKE '%WARNING%' OR Body ILIKE '%WRN%'";

    if (lvl === "error") {
      parts.push(`(lower(SeverityText) = 'error' OR ${isError})`);
    } else if (lvl === "warn" || lvl === "warning") {
      parts.push(`(lower(SeverityText) IN ('warn', 'warning') OR ${isWarn}) AND NOT (lower(SeverityText) = 'error' OR ${isError})`);
    } else if (lvl === "info") {
      parts.push(`lower(SeverityText) = 'info' AND NOT (${isError}) AND NOT (${isWarn})`);
    } else if (lvl === "debug") {
      parts.push(`lower(SeverityText) = 'debug' AND NOT (${isError}) AND NOT (${isWarn})`);
    } else {
      parts.push(`lower(SeverityText) = '${esc(lvl)}'`);
    }
  }
  if (state.search) parts.push(`(Body ILIKE '%${escLike(state.search)}%' OR ContainerName ILIKE '%${escLike(state.search)}%')`);
  if (state.fromDate) {
    const dt = state.fromDate.replace("T", " ");
    parts.push(`Timestamp >= '${dt}'`);
  }
  if (state.toDate) {
    const dt = state.toDate.replace("T", " ");
    parts.push(`Timestamp <= '${dt}'`);
  }

  // DEFAULT: If no dates are selected, always restrict to last 24h
  // to avoid scanning the entire database history (Heavy full-table scan).
  if (!state.fromDate && !state.toDate) {
    parts.push(`Timestamp > now() - INTERVAL 24 HOUR`);
  }

  return parts.length ? "WHERE " + parts.join(" AND ") : "";
}

//  Metrics 
async function loadMetrics() {
  if (_metricsAbortController) _metricsAbortController.abort();
  _metricsAbortController = new AbortController();
  const { signal: metricsSig } = _metricsAbortController;
  try {
    const isError = "Body ILIKE '%ERR%' OR Body ILIKE '%ERROR%'";
    const isWarn = "Body ILIKE '%WARN%' OR Body ILIKE '%WARNING%' OR Body ILIKE '%WRN%'";
    const rows = await apiQuery(`
      SELECT count(),
             countIf(lower(SeverityText)='error' OR ${isError}),
             countIf((lower(SeverityText) IN ('warn', 'warning') OR ${isWarn}) AND NOT (${isError})),
             uniqExact(ContainerName)
      FROM observability.otel_logs_local
      WHERE Timestamp > now() - INTERVAL 24 HOUR AND ServiceName != 'nginx'
    `, metricsSig);
    if (rows.length) {
      const [total, errors, warnings, containers] = rows[0];
      el("m-total").querySelector(".metric-value").textContent = fmt(total);
      el("m-errors").querySelector(".metric-value").textContent = fmt(errors);
      el("m-warnings").querySelector(".metric-value").textContent = fmt(warnings);
      el("m-containers").querySelector(".metric-value").textContent = fmt(containers);
    }
  } catch (e) { if (e.name !== "AbortError") console.error("Metrics error:", e); }
}

//  Sidebar / Container List 
const STORAGE = {
  getStacks: () => {
    try {
      let s = JSON.parse(localStorage.getItem("logpipe_custom_stacks"));
      if (!s) throw new Error("empty");
      if (!s["Watched"]) s["Watched"] = [];
      return s;
    } catch { return { "Watched": [] }; }
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
  if (_containerListAbortController) _containerListAbortController.abort();
  _containerListAbortController = new AbortController();
  const { signal: clSig } = _containerListAbortController;
  try {
    const servicesRes = await fetch(`${API_BASE}/services?hours=24`, {
      credentials: "include",
      signal: clSig,
    });
    if (servicesRes.status === 401) { window.location.href = "/logstore/login"; return; }
    if (servicesRes.ok) {
      const payload = await servicesRes.json();
      if (Array.isArray(payload.data) && payload.data.length > 0) {
        lastSidebarRows = payload.data.map(row => ({ ...row, __kind: "service" }));
        renderSidebar();
        renderPlatformCockpit();
        return;
      }
    }

    const rows = await apiQuery(`
      SELECT ContainerName, max(Timestamp) AS last_seen,
             count() AS log_count, countIf(lower(SeverityText)='error') AS error_count,
             if(ComposeProject != '', ComposeProject, 'Other') AS compose_project
      FROM observability.otel_logs_local
      WHERE Timestamp > now() - INTERVAL 24 HOUR AND ServiceName != 'nginx'
      GROUP BY ContainerName, compose_project
      ORDER BY compose_project ASC, last_seen DESC LIMIT 100
    `, clSig);
    lastSidebarRows = rows;
    renderSidebar();
  } catch (e) { if (e.name !== "AbortError") console.error("Container list error:", e); }
}

async function loadOverview() {
  return getOverviewModule().loadOverview();
}

function renderOverview() {
  return getOverviewModule().renderOverview();
}

function renderOverviewServiceList(id, services, mode) {
  return getOverviewModule().renderOverviewServiceList(id, services, mode);
}

function normalizePlatformService(row) {
  row = row || {};
  return {
    service_key: row.service_key || "",
    host_id: row.host_id || "unknown-host",
    compose_project: row.compose_project || "standalone",
    compose_service: row.compose_service || row.sample_container_name || "unknown-service",
    error_count: Number(row.error_count || 0),
    log_count: Number(row.log_count || 0),
    active_instance_count: Number(row.active_instance_count || 0),
    instance_count: Number(row.instance_count || 0),
    last_seen: row.last_seen || "",
  };
}

function getPlatformServices() {
  if (lastSidebarRows[0]?.__kind !== "service") return [];
  return lastSidebarRows.map(normalizePlatformService);
}

function getPlatformFocusService() {
  if (state.selectedService) return normalizePlatformService(state.selectedService);
  return getPlatformServices()
    .sort((a, b) => (b.error_count - a.error_count) || (b.log_count - a.log_count))[0] || null;
}

function renderPlatformCockpit() {
  const title = el("platform-cockpit-title");
  if (!title) return;

  const service = getPlatformFocusService();
  const services = getPlatformServices();
  const openServiceBtn = el("platform-open-service-logs");

  if (!service) {
    title.textContent = "No services loaded yet";
    el("platform-cockpit-copy").textContent = "Open Logs to confirm the log pipeline is receiving data, then return here for service-level investigation.";
    el("platform-cockpit-host").textContent = "Host: --";
    el("platform-cockpit-project").textContent = "Stack: --";
    el("platform-cockpit-errors").textContent = "Errors: --";
    if (openServiceBtn) openServiceBtn.disabled = true;
    return;
  }

  const selected = !!state.selectedService;
  title.textContent = selected ? "Investigating " + service.compose_service : "Next service to inspect: " + service.compose_service;
  el("platform-cockpit-copy").textContent = service.host_id + " / " + service.compose_project + " has " + fmt(service.log_count) + " logs across " + fmt(service.instance_count) + " instances in the last 24 hours.";
  el("platform-cockpit-host").textContent = "Host: " + service.host_id;
  el("platform-cockpit-project").textContent = "Stack: " + service.compose_project;
  el("platform-cockpit-errors").textContent = "Errors: " + fmt(service.error_count) + " / Services: " + fmt(services.length);
  if (openServiceBtn) {
    openServiceBtn.disabled = false;
    openServiceBtn.textContent = selected ? "Open selected service logs" : "Open top service logs";
  }
}


function platformHealthFallback(status, detail) {
  const serviceStatus = status || "unknown";
  const message = detail || "Waiting for platform health check.";
  return {
    status: serviceStatus === "ok" ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    services: [
      { id: "backend", label: "Backend API", status: serviceStatus, detail: message },
      { id: "clickhouse", label: "ClickHouse", status: "unknown", detail: "No check result yet" },
      { id: "postgres", label: "PostgreSQL", status: "unknown", detail: "No check result yet" },
      { id: "redis", label: "Redis", status: "unknown", detail: "No check result yet" },
      { id: "otel_gateway", label: "OTel Gateway", status: "unknown", detail: "No check result yet" },
    ],
  };
}

function healthCardId(id) {
  return id === "otel_gateway" ? "platform-health-gateway" : "platform-health-" + id;
}

function renderPlatformHealth(payload) {
  const data = payload || platformHealthFallback("unknown");
  const overall = el("platform-health-overall");
  const status = data.status === "ok" ? "ok" : data.status === "checking" ? "unknown" : "fail";
  if (overall) {
    overall.className = "platform-health-overall is-" + status;
    overall.textContent = data.status === "ok" ? "Healthy" : data.status === "checking" ? "Checking" : "Degraded";
  }

  (data.services || []).forEach(item => {
    const card = el(healthCardId(item.id));
    if (!card) return;
    const itemStatus = item.status === "ok" ? "ok" : item.status === "unknown" ? "unknown" : "fail";
    card.className = "platform-health-card is-" + itemStatus;
    const title = card.querySelector("h3");
    const copy = card.querySelector("p");
    if (title) title.textContent = item.label || item.id;
    if (copy) copy.textContent = item.detail || "No detail available";
  });
}

async function loadPlatformHealth() {
  renderPlatformHealth(platformHealthFallback("unknown", "Checking central stack health..."));
  try {
    const res = await (window.LogDashApi?.apiGet ? window.LogDashApi.apiGet("/platform/health") : fetch(API_BASE + "/platform/health", { credentials: "include" }));
    if (res.status === 401) { window.location.href = "/logstore/login"; return; }
    const payload = await res.json();
    state.platformHealth = payload;
    renderPlatformHealth(payload);
  } catch (e) {
    state.platformHealth = platformHealthFallback("fail", "Backend health endpoint unreachable");
    renderPlatformHealth(state.platformHealth);
  }
}

function platformRuntimeFallback(status, detail) {
  return {
    status: status || 'checking',
    timestamp: new Date().toISOString(),
    error: detail || '',
    totals: { total: 0, running: 0, healthy: 0, unhealthy: 0 },
    diagnostics: { restarted: 0, oom_killed: 0, exited: 0, unhealthy: 0, signals: [] },
    containers: []
  };
}

function runtimeSignalState(container) {
  if (container?.oom_killed) return 'unhealthy';
  if (container?.state && container.state !== 'running') return 'stopped';
  if (Number(container?.restart_count || 0) > 0) return 'restarted';
  if (container?.health === 'unhealthy') return 'unhealthy';
  return 'running';
}

function renderPlatformRuntimeDiagnostics(diagnostics, status, error) {
  const list = el('platform-runtime-diagnostics');
  if (!list) return;
  list.innerHTML = '';
  const signals = diagnostics?.signals || [];
  if (!signals.length) {
    const row = document.createElement('div');
    row.className = 'platform-runtime-row is-muted';
    row.textContent = status === 'unavailable' ? 'Docker diagnostics unavailable: ' + (error || 'proxy not reachable') : 'No restart, OOM, exit, or unhealthy container signal detected.';
    list.appendChild(row);
    return;
  }
  signals.slice(0, 8).forEach(container => {
    const state = runtimeSignalState(container);
    const row = document.createElement('div');
    row.className = 'platform-runtime-row is-' + state;
    row.innerHTML = "<span class='platform-runtime-dot'></span><div><strong></strong><p></p></div><span class='platform-runtime-badge'></span>";
    row.querySelector('strong').textContent = container.name || container.short_id || 'container';
    row.querySelector('p').textContent = container.diagnostic || container.status || 'Runtime signal detected';
    row.querySelector('.platform-runtime-badge').textContent = container.oom_killed ? 'OOM' : Number(container.restart_count || 0) > 0 ? 'restart ' + container.restart_count : container.state || container.health || 'signal';
    list.appendChild(row);
  });
}

function renderPlatformRuntime(payload) {
  const data = payload || platformRuntimeFallback('checking');
  const totals = data.totals || {};
  const setRuntimeText = (id, value) => { const target = el(id); if (target) target.textContent = fmt(value || 0); };
  setRuntimeText('platform-runtime-total', totals.total);
  setRuntimeText('platform-runtime-running', totals.running);
  setRuntimeText('platform-runtime-unhealthy', totals.unhealthy);
  setRuntimeText('platform-runtime-restarted', data.diagnostics?.restarted || 0);
  setRuntimeText('platform-runtime-oom', data.diagnostics?.oom_killed || 0);
  setRuntimeText('platform-runtime-exited', data.diagnostics?.exited || 0);
  renderPlatformRuntimeDiagnostics(data.diagnostics, data.status, data.error);

  const list = el('platform-runtime-list');
  if (!list) return;
  list.innerHTML = '';
  const containers = data.containers || [];
  if (!containers.length) {
    const row = document.createElement('div');
    row.className = 'platform-runtime-row is-muted';
    row.textContent = data.status === 'unavailable' ? 'Docker runtime unavailable: ' + (data.error || 'proxy not reachable') : 'No containers returned yet.';
    list.appendChild(row);
    return;
  }

  containers.slice(0, 12).forEach(container => {
    const health = container.health === 'healthy' ? 'healthy' : container.health === 'unhealthy' ? 'unhealthy' : container.state === 'running' ? 'running' : 'stopped';
    const row = document.createElement('div');
    row.className = 'platform-runtime-row is-' + health;
    const meta = [container.image, container.status].filter(Boolean).join(' | ');
    row.innerHTML = '<span class=\'platform-runtime-dot\'></span><div><strong></strong><p></p></div><span class=\'platform-runtime-badge\'></span>';
    row.querySelector('strong').textContent = container.name || container.short_id || 'container';
    row.querySelector('p').textContent = meta || 'No runtime detail';
    row.querySelector('.platform-runtime-badge').textContent = health;
    list.appendChild(row);
  });
}

async function loadPlatformRuntime() {
  renderPlatformRuntime(platformRuntimeFallback('checking'));
  try {
    const res = await (window.LogDashApi?.apiGet ? window.LogDashApi.apiGet('/platform/runtime') : fetch(API_BASE + '/platform/runtime', { credentials: 'include' }));
    if (res.status === 401) { window.location.href = '/logstore/login'; return; }
    const payload = await res.json();
    state.platformRuntime = payload;
    renderPlatformRuntime(payload);
  } catch (e) {
    state.platformRuntime = platformRuntimeFallback('unavailable', 'Backend runtime endpoint unreachable');
    renderPlatformRuntime(state.platformRuntime);
  }
}


function renderPlatformWorkloadDatabases(payload) {
  const data = payload || { status: "checking", databases: [], supported: [] };
  const status = el("platform-workload-db-status");
  if (status) {
    const stateClass = data.status === "ok" ? "is-ok" : data.status === "degraded" ? "is-degraded" : data.status === "not_configured" ? "is-unknown" : "is-unknown";
    status.textContent = data.status || "checking";
    status.className = "platform-health-overall " + stateClass;
  }
  const list = el("platform-workload-db-list");
  if (list) {
    const databases = Array.isArray(data.databases) ? data.databases : [];
    if (!databases.length) {
      const hint = data.setup_hint || "No workload database profiles configured.";
      list.innerHTML = '<div class="platform-runtime-row is-muted">' + escHtml(hint) + '</div>';
    } else {
      list.innerHTML = databases.map(db => {
        const cls = db.status === "ok" ? "is-running" : db.status === "not_supported" ? "is-restarted" : "is-unhealthy";
        const badge = db.status || "unknown";
        return '<div class="platform-runtime-row ' + cls + '"><span class="platform-runtime-dot"></span><div><strong>' + escHtml(db.name || db.id || "database") + '</strong><p>' + escHtml((db.type || "unknown") + ' - ' + (db.target || "target hidden") + ' - ' + (db.detail || "No detail")) + '</p></div><span class="platform-runtime-badge">' + escHtml(badge) + '</span></div>';
      }).join("");
    }
  }
  const supported = el("platform-workload-db-supported");
  if (supported) {
    const rows = Array.isArray(data.supported) ? data.supported : [];
    supported.innerHTML = rows.length ? rows.map(item => '<span>' + escHtml(item.label || item.type) + '</span>').join("") : "";
  }
}

async function loadPlatformWorkloadDatabases() {
  renderPlatformWorkloadDatabases({ status: "checking", databases: [], supported: [] });
  try {
    const res = await fetch(API_BASE + "/platform/workload-databases", { credentials: "include" });
    if (!res.ok) {
      renderPlatformWorkloadDatabases({ status: "unavailable", databases: [], supported: [], setup_hint: "Workload database monitoring is unavailable for this user." });
      return;
    }
    renderPlatformWorkloadDatabases(await res.json());
  } catch (e) {
    renderPlatformWorkloadDatabases({ status: "unavailable", databases: [], supported: [], setup_hint: "Workload database monitoring could not be loaded." });
    console.error("workload databases:", e);
  }
}

function platformUptimeFallback(status, detail) {
  return {
    status: status || 'checking',
    timestamp: new Date().toISOString(),
    services: [
      { id: 'dashboard', label: 'Dashboard UI', status: status || 'unknown', detail: detail || 'Waiting for uptime check.' },
      { id: 'backend_api', label: 'Backend API', status: 'unknown', detail: 'No check result yet' },
      { id: 'clickhouse_ui', label: 'ClickHouse UI', status: 'unknown', detail: 'No check result yet' },
    ],
  };
}

function uptimeCardId(id) {
  if (id === 'backend_api') return 'platform-uptime-backend';
  if (id === 'clickhouse_ui') return 'platform-uptime-clickhouse-ui';
  return 'platform-uptime-' + id;
}

function renderPlatformUptime(payload) {
  const data = payload || platformUptimeFallback('checking');
  const overall = el('platform-uptime-overall');
  const status = data.status === 'ok' ? 'ok' : data.status === 'checking' ? 'unknown' : 'fail';
  if (overall) {
    overall.className = 'platform-health-overall is-' + status;
    overall.textContent = data.status === 'ok' ? 'Healthy' : data.status === 'checking' ? 'Checking' : 'Degraded';
  }
  (data.services || []).forEach(item => {
    const card = el(uptimeCardId(item.id));
    if (!card) return;
    const itemStatus = item.status === 'ok' ? 'ok' : item.status === 'unknown' ? 'unknown' : 'fail';
    card.className = 'platform-uptime-card is-' + itemStatus;
    const title = card.querySelector('h3');
    const copy = card.querySelector('p');
    if (title) title.textContent = item.label || item.id;
    if (copy) copy.textContent = item.detail || 'No detail available';
  });
}

async function loadPlatformUptime() {
  renderPlatformUptime(platformUptimeFallback('checking', 'Checking core surfaces...'));
  try {
    const res = await (window.LogDashApi?.apiGet ? window.LogDashApi.apiGet('/platform/uptime') : fetch(API_BASE + '/platform/uptime', { credentials: 'include' }));
    if (res.status === 401) { window.location.href = '/logstore/login'; return; }
    const payload = await res.json();
    state.platformUptime = payload;
    renderPlatformUptime(payload);
  } catch (e) {
    state.platformUptime = platformUptimeFallback('fail', 'Backend uptime endpoint unreachable');
    renderPlatformUptime(state.platformUptime);
  }
}

function focusPlatformDatabase(target) {
  const card = el('platform-health-' + target);
  if (!card) return;
  card.classList.add('is-focused');
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => card.classList.remove('is-focused'), 1800);
}

function openPlatformServiceLogs() {
  const service = getPlatformFocusService();
  if (service) {
    selectService(service);
    activateLogsView();
    return;
  }
  activateLogsView();
}

function openAllLogsFromPlatform() {
  state.selectedStack = null;
  state.stackNames = [];
  state.selectedProject = null;
  state.selectedService = null;
  state.page = 0;
  renderSidebar();
  activateLogsView();
  loadLogs();
}

function getLogsModule() {
  if (!window.LogDashLogs) {
    throw new Error("LogDashLogs module is not loaded");
  }
  window.LogDashLogs.init({
    ansiToHtml,
    escHtml,
    formatTs,
    messagePreviewLimit: LOG_MESSAGE_PREVIEW_LIMIT,
    levelScanLimit: 200,
    containerAliasesProvider: () => containerAliases,
  });
  return window.LogDashLogs;
}

function getOverviewModule() {
  if (!window.LogDashOverview) {
    throw new Error("LogDashOverview module is not loaded");
  }
  window.LogDashOverview.init({
    state,
    el,
    fmt,
    escHtml,
    activateLogsView,
    selectService,
  });
  return window.LogDashOverview;
}

function renderSidebar() {
  if (lastSidebarRows[0]?.__kind === "service") {
    renderServiceSidebar();
    return;
  }

  const folderList = el("folder-list");
  folderList.innerHTML = "";
  folderDataMap = {};
  const customStacks = STORAGE.getStacks();
  const isAdmin = state.user?.role === "super_admin" || state.user?.role === "admin";

  const allItem = document.createElement("div");
  allItem.className = "container-item" + (!state.selectedStack ? " active" : "");
  allItem.innerHTML = `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span><span class="c-name">All Containers</span>`;
  allItem.addEventListener("click", () => {
    state.selectedStack = null; state.stackNames = []; state.selectedProject = null; state.selectedService = null; state.page = 0;
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
    const itemData = { displayName, cname, dot, errorCount, project: rawProject };
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
    if (a === "Watched") return -1;
    if (b === "Watched") return 1;
    return a.localeCompare(b);
  });

  // Count how many folders each displayName appears in  duplicates get project suffix
  const nameProjectCount = {};
  Object.values(folderDataMap).forEach(({ items }) => {
    const seen = new Set();
    items.forEach(({ displayName }) => {
      if (!seen.has(displayName)) {
        seen.add(displayName);
        nameProjectCount[displayName] = (nameProjectCount[displayName] || 0) + 1;
      }
    });
  });

  sortedNames.forEach(stackName => {
    const group = document.createElement("div");
    const isActive = stackName === state.selectedStack;
    // Always open: the active stack,  Watched, or any stack the user manually expanded
    if (isActive) openStacks.add(stackName);
    const isOpen = stackName === "Watched" || openStacks.has(stackName);
    const isCustom = !!customStacks[stackName];
    const { items: stackItems, rawProject } = folderDataMap[stackName];
    group.className = "folder-group " + (isOpen ? "open" : "") + (isActive ? " active-stack" : "");

    group.innerHTML = `
      <div class="folder-header" style="cursor:pointer;display:flex;align-items:center;">
        <span class="folder-icon">[ ]</span>
        <span>${escHtml(stackName)}</span>
        <div class="stack-actions" style="margin-left:auto;display:flex;gap:4px;">
          <button class="btn-ghost btn-icon action-rename" title="Rename" style="font-size:10px;padding:2px 4px;">Rename</button>
          ${isAdmin ? `<button class="btn-ghost btn-icon action-purge-stack" title="Permanently Delete Logs" style="font-size:10px;padding:2px 4px;">Delete</button>` : ""}
          ${isCustom ? `<button class="btn-ghost btn-icon action-delete" title="Delete" style="font-size:10px;padding:2px 4px;">Delete</button>` : ""}
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
        const isDupe = nameProjectCount[data.displayName] > 1;
        childrenContainer.appendChild(makeContainerItem(data.displayName, data.cname, data.dot, data.errorCount, data.project, isDupe));
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
          alert("Built-in stacks cannot be renamed. Create a custom stack if you need a different name.");
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
        selectStack(stackName, stackItems.map(d => d.cname), rawProject);
    });

    folderList.appendChild(group);
  });
}

function renderServiceSidebar() {
  const folderList = el("folder-list");
  folderList.innerHTML = "";
  folderDataMap = {};

  const allItem = document.createElement("div");
  allItem.className = "container-item" + (!state.selectedStack && !state.selectedService ? " active" : "");
  allItem.innerHTML = `<span class="c-dot" style="background:var(--accent);color:var(--accent)"></span><span class="c-name">All Services</span>`;
  allItem.addEventListener("click", () => {
    state.selectedStack = null; state.stackNames = []; state.selectedProject = null; state.selectedService = null; state.page = 0;
    stopLogsSSE();
    if (state.view === "logs") startLogsSSE();
    loadLogs(); if (state.view === "analytics") loadAnalytics(); renderSidebar();
  });
  folderList.appendChild(allItem);

  const dotThresholds = {
    green: parseInt(state.settings.dot_green_threshold_sec || "60"),
    amber: parseInt(state.settings.dot_amber_threshold_sec || "300"),
  };
  const now = Date.now();

  lastSidebarRows.forEach(row => {
    const host = row.host_id || "unknown-host";
    const project = row.compose_project || "standalone";
    const groupName = `${host} / ${project}`;
    const lastSeen = row.last_seen;
    const ageSec = lastSeen ? (now - new Date(lastSeen).getTime()) / 1000 : Number.POSITIVE_INFINITY;
    const dot = ageSec < dotThresholds.green ? "green"
      : ageSec < dotThresholds.amber ? "amber" : "red";
    if (!folderDataMap[groupName]) folderDataMap[groupName] = { items: [], rawProject: project };
    folderDataMap[groupName].items.push({
      service_key: row.service_key,
      host_id: host,
      compose_project: project,
      compose_service: row.compose_service || row.sample_container_name || "unknown-service",
      last_seen: lastSeen,
      dot,
      error_count: Number(row.error_count || 0),
      log_count: Number(row.log_count || 0),
      instance_count: Number(row.instance_count || 0),
      active_instance_count: Number(row.active_instance_count || 0),
      sample_container_name: row.sample_container_name,
    });
  });

  Object.keys(folderDataMap).sort().forEach(groupName => {
    const group = document.createElement("div");
    const { items } = folderDataMap[groupName];
    const isActive = items.some(item => item.service_key === state.selectedService?.service_key);
    if (isActive) openStacks.add(groupName);
    const isOpen = isActive || openStacks.has(groupName);
    group.className = "folder-group " + (isOpen ? "open" : "") + (isActive ? " active-stack" : "");
    group.innerHTML = `
      <div class="folder-header" style="cursor:pointer;display:flex;align-items:center;">
        <span class="folder-icon">[ ]</span>
        <span>${escHtml(groupName)}</span>
        <span style="margin-left:auto;color:var(--text-muted);font-size:10px;">${items.length}</span>
      </div>
      <div class="folder-children" ${isOpen ? "" : 'data-loaded="false"'}></div>
    `;

    const childrenContainer = group.querySelector(".folder-children");
    const renderItems = () => {
      childrenContainer.innerHTML = "";
      items
        .sort((a, b) => (b.error_count - a.error_count) || String(a.compose_service).localeCompare(String(b.compose_service)))
        .forEach(item => childrenContainer.appendChild(makeServiceItem(item)));
      childrenContainer.removeAttribute("data-loaded");
    };
    if (isOpen) renderItems();

    group.querySelector(".folder-icon").addEventListener("click", e => {
      e.stopPropagation();
      const willOpen = !group.classList.contains("open");
      group.classList.toggle("open");
      if (willOpen) openStacks.add(groupName);
      else openStacks.delete(groupName);
      if (willOpen && childrenContainer.getAttribute("data-loaded") === "false") renderItems();
    });

    group.querySelector(".folder-header").addEventListener("click", e => {
      if (e.target.closest(".folder-icon")) return;
      const willOpen = !group.classList.contains("open");
      group.classList.toggle("open");
      if (willOpen) openStacks.add(groupName);
      else openStacks.delete(groupName);
      if (willOpen && childrenContainer.getAttribute("data-loaded") === "false") renderItems();
    });

    folderList.appendChild(group);
  });
}

function selectStack(stackName, containerNames, project = null) {
  state.selectedStack = stackName; state.stackNames = containerNames || []; state.selectedProject = project; state.selectedService = null; state.page = 0;
  stopLogsSSE();
  renderSidebar();
  if (_selectStackTimer) clearTimeout(_selectStackTimer);
  _selectStackTimer = setTimeout(() => {
    if (state.view === "logs") startLogsSSE();
    loadLogs();
    if (state.view === "analytics") loadAnalytics();
  }, 200);
}

function selectService(service) {
  if (state.view === "overview") activateLogsView();
  state.selectedStack = service.compose_service;
  state.stackNames = [];
  state.selectedProject = service.compose_project;
  state.selectedService = service;
  state.page = 0;
  renderPlatformCockpit();
  if (state.view === "platform") loadPlatformIncidentTimeline();
  stopLogsSSE();
  renderSidebar();
  if (_selectStackTimer) clearTimeout(_selectStackTimer);
  _selectStackTimer = setTimeout(() => {
    if (state.view === "logs") startLogsSSE();
    loadLogs();
    if (state.view === "analytics") loadAnalytics();
  }, 200);
}

function makeServiceItem(service) {
  const div = document.createElement("div");
  const isSelected = state.selectedService?.service_key === service.service_key;
  div.className = "container-item" + (isSelected ? " active" : "");
  const badgeText = service.error_count > 0 ? fmt(service.error_count) : "";
  const instanceText = service.active_instance_count > 0
    ? `${service.active_instance_count}/${service.instance_count || service.active_instance_count}`
    : `${service.instance_count || 0}`;
  div.innerHTML = `
    <span class="c-dot ${service.dot}"></span>
    <span class="c-name">${escHtml(service.compose_service)}</span>
    <span class="c-project-tag" title="active/total instances">${escHtml(instanceText)}</span>
    ${badgeText ? `<span class="c-badge">${badgeText}</span>` : ""}
  `;
  div.title = `${service.service_key}\nlogs: ${service.log_count}\nlast seen: ${service.last_seen || "unknown"}`;
  div.addEventListener("click", () => selectService(service));
  return div;
}

function makeContainerItem(name, realName, dotClass, errorCount, project = null, showProject = false) {
  const div = document.createElement("div");
  const isSelected = state.selectedStack === realName || state.selectedStack === name;
  const isAdmin = state.user?.role === "super_admin" || state.user?.role === "admin";
  div.className = "container-item" + (isSelected ? " active" : "");
  const projectSuffix = showProject && project ? `<span class="c-project-tag">${escHtml(project)}</span>` : "";
  div.innerHTML = `
    ${dotClass ? `<span class="c-dot ${dotClass}"></span>` : `<span class="c-dot" style="background:var(--accent)"></span>`}
    <span class="c-name">${escHtml(name)}${projectSuffix}</span>
    ${errorCount > 0 ? `<span class="c-badge">${fmt(errorCount)}</span>` : ""}
    <div class="c-actions" style="margin-left:auto;display:flex;gap:4px;">
      ${isAdmin ? `<span class="c-purge" title="Permanently Delete Logs" style="cursor:pointer;font-size:10px;">Delete</span>` : ""}
      ${realName ? `<span class="c-edit" title="Rename Container" style="cursor:pointer;font-size:10px;">Rename</span>` : ""}
      ${realName ? `<span class="c-star" title="Add to Stack" style="cursor:pointer;">+</span>` : ""}
    </div>
  `;
  div.addEventListener("click", () => {
    selectStack(name, [realName], project);
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

//  Log Table 
async function loadLogs() {
  if (_logsAbortController) _logsAbortController.abort();
  _logsAbortController = new AbortController();
  const { signal } = _logsAbortController;

  const where = buildWhere();
  const offset = state.page * PAGE_SIZE;
  try {
    el("table-status").textContent = "Loading...";
    const [countRows, dataRows] = await Promise.all([
      apiQuery(`SELECT count() FROM observability.otel_logs_local ${where} AND ServiceName != 'nginx'`, signal),
      apiQuery(`SELECT Timestamp, ContainerName, SeverityText, Body, TraceId FROM observability.otel_logs_local ${where} AND ServiceName != 'nginx' ORDER BY Timestamp ${state.sortDir} LIMIT ${PAGE_SIZE} OFFSET ${offset}`, signal),
    ]);
    state.totalRows = parseInt(countRows[0]?.[0] ?? 0, 10);
    const totalPages = Math.max(1, Math.ceil(state.totalRows / PAGE_SIZE));
    el("table-status").textContent = `${fmt(state.totalRows)} rows  -  Page ${state.page + 1} of ${totalPages}`;
    renderTable(dataRows);
    renderPagination(totalPages);
  } catch (e) {
    if (e.name === "AbortError") return;
    el("table-status").textContent = "Query failed: " + e.message + " (showing previous results)";
  }
}

function _drillToLogs({ fromDate, toDate, level, search } = {}) {
  if (fromDate !== undefined) {
    state.fromDate = fromDate;
    const [d, t] = fromDate.split("T");
    el("range-from-date").value   = d;
    el("range-from-hour").value   = t.slice(0, 2);
    el("range-from-minute").value = t.slice(3, 5);
  }
  if (toDate !== undefined) {
    state.toDate = toDate;
    const [d, t] = toDate.split("T");
    el("range-to-date").value   = d;
    el("range-to-hour").value   = t.slice(0, 2);
    el("range-to-minute").value = t.slice(3, 5);
  }
  if (level  !== undefined) { state.level  = level;  const lsel = el("level-select");  if (lsel) lsel.value = level; }
  if (search !== undefined) { state.search = search; const sinp = el("search-input");  if (sinp) sinp.value = search; }
  state.page = 0;
  stopLogsSSE();
  el("tab-logs").click();
  startLogsSSE();
  loadLogs();
}

function renderTable(rows) {
  const tbody = el("log-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No logs found for the current filters.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(row => getLogsModule().renderLogRowHtml(row)).join("");
  bindLogRowActions(tbody);
  /* Legacy inline renderer moved to apps/web/src/logs.js.
  tbody.innerHTML = rows.map(([ts, cname, level, msg, traceId]) => {
    let lvl = (level || "").toLowerCase();

    // Body-scan level override  only scan first 200 chars to avoid false positives
    // from URL-encoded query params in access logs (e.g. %27error%27 deep in body).
    const msgStr = String(msg);
    if (lvl === "info" || lvl === "debug" || lvl === "--" || !lvl) {
      const msgUpper = msgStr.slice(0, 200).toUpperCase();
      if (msgUpper.includes("ERR") || msgUpper.includes("ERROR")) lvl = "error";
      else if (msgUpper.includes("WARN") || msgUpper.includes("WARNING") || msgUpper.includes("WRN")) lvl = "warn";
    }

    const rowCls = lvl === "error" ? "row-error" : (lvl === "warn" || lvl === "warning") ? "row-warn" : "";
    const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvl] || "badge-other";
    const displayName = containerAliases[cname] || cname;
    const tsAttr = escHtml(String(ts));
    const cnameAttr = escHtml(String(cname));
    const msgHtml = ansiToHtml(String(msg).slice(0, LOG_MESSAGE_PREVIEW_LIMIT));
    return `<tr class="${rowCls}">
      <td class="td-ts">${formatTs(ts)}</td>
      <td class="td-cid" title="${escHtml(cname)}">${escHtml(displayName)}</td>
      <td><span class="badge ${badgeCls}">${escHtml(lvl || "--")}</span></td>
      <td class="td-msg">${msgHtml}</td>
      <td class="td-ctx"><button class="btn-ctx" data-ts="${tsAttr}" data-cname="${cnameAttr}" title="Trace surrounding logs (+/-30s)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px;"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>Trace</button>${traceId ? `<button class="btn-tid" data-tid="${escHtml(traceId)}" title="TraceId Correlation: all logs with trace ${escHtml(traceId)}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>Link</button>` : ""}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-ctx").forEach(btn => {
    btn.addEventListener("click", () => {
      openContextModal(btn.dataset.cname, btn.dataset.ts);
    });
  });

  tbody.querySelectorAll(".btn-tid").forEach(btn => {
    btn.addEventListener("click", () => openTraceModal(btn.dataset.tid));
  });
  */
}

function trimTableRows(tbody, limit) {
  if (!tbody || !Number.isFinite(limit) || limit <= 0) return;
  while (tbody.rows.length > limit) tbody.deleteRow(tbody.rows.length - 1);
}

function bindLogRowActions(tbody) {
  tbody.querySelectorAll(".btn-ctx").forEach(btn => {
    btn.addEventListener("click", () => {
      openContextModal(btn.dataset.cname, btn.dataset.ts);
    });
  });

  tbody.querySelectorAll(".btn-tid").forEach(btn => {
    btn.addEventListener("click", () => openTraceModal(btn.dataset.tid));
  });
}

//  Context modal (Phase 12) 
function fmtRelative(deltaMs) {
  const s = deltaMs / 1000;
  const abs = Math.abs(s);
  if (abs < 1) return s === 0 ? "anchor" : `${s > 0 ? "+" : "-"}${abs.toFixed(2)}s`;
  if (abs < 60) return `${s > 0 ? "+" : "-"}${abs.toFixed(1)}s`;
  return `${s > 0 ? "+" : "-"}${(abs / 60).toFixed(1)}m`;
}

async function openContextModal(container, anchorTs, windowSec = 30) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay ctx-overlay";
  overlay.innerHTML = `
    <div class="ctx-modal">
      <header class="ctx-header">
        <div class="ctx-header-left">
          <div class="ctx-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>
            <span>Trace surrounding logs</span>
          </div>
          <div class="ctx-meta">
            <span class="ctx-pill ctx-pill-mono" title="${escHtml(container)}">${escHtml(container)}</span>
            <span class="ctx-pill">+/-<span id="ctx-window">${windowSec}</span>s</span>
            <span class="ctx-pill ctx-pill-muted">around ${formatTs(anchorTs)}</span>
          </div>
        </div>
        <button id="ctx-close" class="ctx-close-btn" aria-label="Close">Close</button>
      </header>

      <div class="ctx-toolbar">
        <div class="ctx-window-toggle" role="tablist">
          <button class="ctx-win" data-win="30">+/-30s</button>
          <button class="ctx-win" data-win="60">+/-60s</button>
          <button class="ctx-win" data-win="120">+/-2m</button>
          <button class="ctx-win" data-win="300">+/-5m</button>
        </div>
        <button id="ctx-goto-anchor" class="ctx-goto-anchor" title="Jump to anchor log">Anchor</button>
        <div id="ctx-status" class="ctx-toolbar-status">Loading...</div>
      </div>

      <div class="ctx-body-wrapper">
        <table id="ctx-table" class="ctx-table">
          <thead>
            <tr>
              <th class="ctx-col-rel">Delta</th>
              <th class="ctx-col-ts">Timestamp</th>
              <th class="ctx-col-lvl">Level</th>
              <th class="ctx-col-msg">Message</th>
            </tr>
          </thead>
          <tbody id="ctx-body"></tbody>
        </table>
      </div>

      <footer class="ctx-footer">
        <div id="ctx-summary" class="ctx-summary"></div>
        <div class="ctx-hint">Esc to close - click outside to dismiss</div>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  overlay.querySelector("#ctx-close").addEventListener("click", close);
  overlay.querySelectorAll(".ctx-win").forEach(b => {
    b.addEventListener("click", () => {
      overlay.querySelectorAll(".ctx-win").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      loadCtx(parseInt(b.dataset.win, 10));
    });
  });
  overlay.querySelector("#ctx-goto-anchor").addEventListener("click", () => {
    const anchorRow = overlay.querySelector("#ctx-body tr[data-anchor='true']");
    if (anchorRow) {
      anchorRow.scrollIntoView({ block: "center", behavior: "smooth" });
      anchorRow.classList.add("row-anchor-flash");
      setTimeout(() => anchorRow.classList.remove("row-anchor-flash"), 1000);
    }
  });

  async function loadCtx(win) {
    overlay.querySelector("#ctx-window").textContent = win;
    overlay.querySelector("#ctx-status").innerHTML = `<span class="ctx-spinner"></span> Loading +/- ${win}s window...`;
    overlay.querySelector("#ctx-body").innerHTML = "";
    overlay.querySelector("#ctx-summary").textContent = "";
    overlay.querySelectorAll(".ctx-win").forEach(x => {
      x.classList.toggle("active", parseInt(x.dataset.win, 10) === win);
    });
    try {
      const url = `/logstore/api/logs/context?container=${encodeURIComponent(container)}&ts=${encodeURIComponent(anchorTs)}&window_sec=${win}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) {
        const txt = await r.text();
        overlay.querySelector("#ctx-status").innerHTML = `<span style="color:var(--error,#e11d48);">Error ${r.status}</span> ${escHtml(txt.slice(0, 140))}`;
        return;
      }
      const data = await r.json();
      const rows = data.rows || [];
      if (!rows.length) {
        overlay.querySelector("#ctx-status").innerHTML = `<span style="color:var(--text-muted);">No surrounding logs in window.</span>`;
        return;
      }
      const anchorMs = new Date(anchorTs).getTime();
      let bestIdx = 0, bestDiff = Infinity;
      rows.forEach((r, i) => {
        const d = Math.abs(new Date(r[0]).getTime() - anchorMs);
        if (d < bestDiff) { bestDiff = d; bestIdx = i; }
      });
      let errCount = 0, warnCount = 0;
      rows.forEach(r => {
        const lvl = (r[2] || "").toLowerCase();
        if (lvl === "error") errCount++;
        else if (lvl === "warn" || lvl === "warning") warnCount++;
      });
      overlay.querySelector("#ctx-status").innerHTML = `<span class="ctx-status-ok">OK</span> Loaded ${rows.length} row${rows.length === 1 ? "" : "s"}`;
      overlay.querySelector("#ctx-summary").innerHTML = `
        <span class="ctx-stat"><strong>${rows.length}</strong> total</span>
        ${errCount > 0 ? `<span class="ctx-stat ctx-stat-error"><strong>${errCount}</strong> error${errCount === 1 ? "" : "s"}</span>` : ""}
        ${warnCount > 0 ? `<span class="ctx-stat ctx-stat-warn"><strong>${warnCount}</strong> warn${warnCount === 1 ? "" : "s"}</span>` : ""}
      `;
      overlay.querySelector("#ctx-body").innerHTML = rows.map(([ts, _cn, level, msg], i) => {
        const lvl = (level || "").toLowerCase();
        const isAnchor = i === bestIdx;
        const rowCls = (isAnchor ? "row-anchor " : "") +
          (lvl === "error" ? "row-error" : (lvl === "warn" || lvl === "warning") ? "row-warn" : "");
        const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvl] || "badge-other";
        const delta = new Date(ts).getTime() - anchorMs;
        const relCls = isAnchor ? "ctx-rel-anchor" : (delta < 0 ? "ctx-rel-before" : "ctx-rel-after");
        const msgHtml = ansiToHtml(String(msg).slice(0, 1500));
        return `<tr class="${rowCls}"${isAnchor ? ' data-anchor="true"' : ''}>
          <td class="ctx-rel ${relCls}">${isAnchor ? "*" : ""} ${fmtRelative(delta)}</td>
          <td class="ctx-ts">${formatTs(ts)}</td>
          <td class="ctx-lvl"><span class="badge ${badgeCls}">${escHtml(lvl || "--")}</span></td>
          <td class="ctx-msg">${msgHtml}</td>
        </tr>`;
      }).join("");
      const anchorRow = overlay.querySelectorAll("#ctx-body tr")[bestIdx];
      if (anchorRow) {
        setTimeout(() => anchorRow.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
      }
    } catch (e) {
      overlay.querySelector("#ctx-status").textContent = "Failed: " + e.message;
    }
  }

  loadCtx(windowSec);
}

//  TraceId Correlation modal (Phase 13) 
async function openTraceModal(traceId) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay ctx-overlay";
  overlay.innerHTML = `
    <div class="ctx-modal">
      <header class="ctx-header">
        <div class="ctx-header-left">
          <span class="ctx-title"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>Trace Correlation</span>
          <span class="ctx-pill ctx-pill-mono">${escHtml(traceId.slice(0, 16))}...</span>
        </div>
        <div class="ctx-header-actions">
          <button id="tid-copy" class="ctx-icon-btn" title="Copy TraceId">Copy</button>
          <button id="tid-close" class="ctx-close-btn">Close</button>
        </div>
      </header>
      <div id="tid-status" class="ctx-status loading">
        <div class="spinner"></div>
        <span>Fetching logs...</span>
      </div>
      <div class="ctx-body-wrapper">
        <table class="ctx-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Service</th>
              <th>Level</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="tid-body"></tbody>
        </table>
      </div>
      <footer class="ctx-footer">
        <div id="tid-summary"></div>
        <div class="ctx-hint">Esc or click outside</div>
      </footer>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector("#tid-close").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
  overlay.querySelector("#tid-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(traceId).catch(() => {});
  });

  try {
    const data = await fetch(`/logstore/api/logs/trace/${encodeURIComponent(traceId)}`).then(r => r.json());
    const rows = data.rows || [];
    const tbody = overlay.querySelector("#tid-body");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-ctx">No logs found for this TraceId.</td></tr>`;
      overlay.querySelector("#tid-status").innerHTML = `<span>No logs found</span>`;
      overlay.querySelector("#tid-status").classList.remove("loading");
      return;
    }
    const badgeMap = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" };
    let errCount = 0, warnCount = 0;
    tbody.innerHTML = rows.map(([ts, svc, lvl, body, cname]) => {
      const l = (lvl || "").toLowerCase();
      const cls = l === "error" ? "row-error" : (l === "warn" || l === "warning") ? "row-warn" : "";
      if (l === "error") errCount++;
      else if (l === "warn" || l === "warning") warnCount++;
      const badgeCls = badgeMap[l] || "badge-other";
      return `<tr class="${cls}">
        <td class="td-ts">${formatTs(ts)}</td>
        <td class="td-cid">${escHtml(cname || svc)}</td>
        <td><span class="badge ${badgeCls}">${escHtml(lvl || "--")}</span></td>
        <td class="td-msg">${ansiToHtml(String(body).slice(0, 1000))}</td>
      </tr>`;
    }).join("");
    overlay.querySelector("#tid-status").innerHTML = `<span style="color:var(--accent)">OK</span> Found ${rows.length} log${rows.length > 1 ? "s" : ""}`;
    overlay.querySelector("#tid-status").classList.remove("loading");
    overlay.querySelector("#tid-summary").innerHTML = `${rows.length} correlated log${rows.length > 1 ? "s" : ""}${errCount ? ` - <span style="color:var(--error)">${errCount} error${errCount > 1 ? "s" : ""}</span>` : ""}${warnCount ? ` - <span style="color:var(--warn)">${warnCount} warn${warnCount > 1 ? "s" : ""}</span>` : ""}`;
  } catch (e) {
    overlay.querySelector("#tid-status").innerHTML = `<span style="color:var(--error)">Error: ${escHtml(e.message)}</span>`;
    overlay.querySelector("#tid-status").classList.remove("loading");
    overlay.querySelector("#tid-body").innerHTML = `<tr><td colspan="4" class="empty-ctx" style="color:var(--error)">Failed to load logs.</td></tr>`;
  }
}

function renderPagination(totalPages) {
  el("btn-prev").disabled = state.page === 0;
  el("btn-next").disabled = state.page >= totalPages - 1;
  el("page-info").textContent = `Page ${state.page + 1} / ${totalPages}`;
}

//  Nginx Logs 
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
    badge.textContent = "LIVE";
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
  if (state.selectedProject) params.set("compose_project", state.selectedProject);
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
    setTimeout(() => { if (state.view === "logs") startLogsSSE(); }, 3_000);
  };
}

function stopLogsSSE() {
  if (logsSSE) { logsSSE.close(); logsSSE = null; }
  setLiveBadge("table-status", false);
}

function prependLogRows(newRows) {
  const tbody = el("log-body");
  if (!tbody) return;
  if (tbody.querySelector(".empty-state")) tbody.innerHTML = "";
  [...newRows].reverse().forEach(([ts, cname, level, msg]) => {
    let lvl = (level || "").toLowerCase();
    const msgStr = String(msg);
    if (lvl === "info" || lvl === "debug" || lvl === "--" || !lvl) {
      const msgUpper = msgStr.toUpperCase();
      if (msgUpper.includes("ERR") || msgUpper.includes("ERROR")) lvl = "error";
      else if (msgUpper.includes("WARN") || msgUpper.includes("WARNING") || msgUpper.includes("WRN")) lvl = "warn";
    }

    const rowCls = lvl === "error" ? "row-error" : (lvl === "warn" || lvl === "warning") ? "row-warn" : "";
    const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvl] || "badge-other";
    const displayName = containerAliases[cname] || cname;
    const tr = document.createElement("tr");
    tr.className = (rowCls + " row-new").trim();
    const msgHtml = ansiToHtml(String(msg).slice(0, LOG_MESSAGE_PREVIEW_LIMIT));
    tr.innerHTML = `<td class="td-ts">${formatTs(ts)}</td><td class="td-cid" title="${escHtml(cname)}">${escHtml(displayName)}</td><td><span class="badge ${badgeCls}">${escHtml(lvl || "--")}</span></td><td class="td-msg">${msgHtml}</td><td class="td-ctx"></td>`;
    tbody.insertBefore(tr, tbody.firstChild);
  });
  trimTableRows(tbody, MAX_LOG_ROWS_IN_DOM);
  state.totalRows += newRows.length;
  const totalPages = Math.max(1, Math.ceil(state.totalRows / PAGE_SIZE));
  const statusEl = el("table-status");
  if (statusEl) {
    const textNode = statusEl.childNodes[0];
    if (textNode?.nodeType === Node.TEXT_NODE)
      textNode.textContent = `${fmt(state.totalRows)} rows  -  Page ${state.page + 1} of ${totalPages}`;
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
    setTimeout(() => { if (state.view === "nginx") startNginxSSE(); }, 3_000);
  };
}

function stopNginxSSE() {
  if (nginxSSE) { nginxSSE.close(); nginxSSE = null; }
  setLiveBadge("nginx-table-status", false);
}

function nginxRowMatchesFilters([ts, , method, , path, status]) {
  const statusFilter = el("nginx-status-select")?.value;
  if (statusFilter && String(status) !== statusFilter) return false;
  const methodFilter = el("nginx-method-select")?.value;
  if (methodFilter && method !== methodFilter) return false;
  const searchFilter = el("nginx-search-input")?.value?.trim();
  if (searchFilter && !String(path).toLowerCase().includes(searchFilter.toLowerCase())) return false;
  const fromDate = el("nginx-range-from-date")?.value;
  if (fromDate) {
    const from = new Date(`${fromDate}T${el("nginx-range-from-hour")?.value || "00"}:${el("nginx-range-from-minute")?.value || "00"}:00`);
    if (new Date(ts) < from) return false;
  }
  const toDate = el("nginx-range-to-date")?.value;
  if (toDate) {
    const to = new Date(`${toDate}T${el("nginx-range-to-hour")?.value || "23"}:${el("nginx-range-to-minute")?.value || "59"}:59`);
    if (new Date(ts) > to) return false;
  }
  return true;
}

function prependNginxRows(newRows) {
  const tbody = el("nginx-log-body");
  if (!tbody) return;
  const filtered = newRows.filter(nginxRowMatchesFilters);
  if (!filtered.length) return;
  if (tbody.querySelector(".empty-state")) tbody.innerHTML = "";
  [...filtered].reverse().forEach(([ts, ip, method, referer, path, status, bytes, time]) => {
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
  nginxTotalRows += filtered.length;
  const totalPages = Math.max(1, Math.ceil(nginxTotalRows / NGINX_PAGE_SIZE));
  const statusEl = el("nginx-table-status");
  if (statusEl) {
    const textNode = statusEl.childNodes[0];
    if (textNode?.nodeType === Node.TEXT_NODE)
      textNode.textContent = `${fmt(nginxTotalRows)} rows  -  Page ${nginxPage + 1} of ${totalPages}`;
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
  nginxSearchTerm = path;
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
  params.set("hours", String(nginxAnalyticsHours));
  if (status) params.set("status", status);
  if (method) params.set("method", method);
  if (path) params.set("search", path);
  if (fromDate) {
    const fromTs = `${fromDate} ${fromHour || "00"}:${fromMin || "00"}:00`;
    params.set("from_time", fromTs);
  }
  if (toDate) {
    const toTs = `${toDate} ${toHour || "23"}:${toMin || "59"}:59`;
    params.set("to_time", toTs);
  }

  try {
    el("nginx-table-status").textContent = "Loading...";
    const res = await fetch(`${API_BASE}/admin/nginx-logs/logs?${params}`, { credentials: "include" });
    if (!res.ok) throw new Error(res.statusText);
    const json = await res.json();
    nginxTotalRows = json.total || 0;
    const totalPages = Math.max(1, Math.ceil(nginxTotalRows / NGINX_PAGE_SIZE));
    el("nginx-table-status").textContent = `${fmt(nginxTotalRows)} rows  -  Page ${nginxPage + 1} of ${totalPages}`;
    renderNginxTable(json.data || []);
    renderNginxPagination(totalPages);
  } catch (e) {
    el("nginx-table-status").textContent = "Query failed: " + e.message;
    el("nginx-log-body").innerHTML = `<tr><td colspan="8" class="empty-state">Error loading network logs.</td></tr>`;
  }
}

function renderNginxTable(rows) {
  const tbody = el("nginx-log-body");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No network logs found for the current filters.</td></tr>`;
    return;
  }
  const hl = (txt) => {
    if (!nginxSearchTerm) return escHtml(String(txt));
    const term = nginxSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${term})`, "gi");
    return escHtml(String(txt)).replace(re, "<mark>$1</mark>");
  };
  tbody.innerHTML = rows.map(([ts, ip, method, referer, path, status, bytes, time]) => {
    const statusNum = parseInt(status) || 0;
    const cls = statusNum >= 500 ? "row-error" : statusNum >= 400 ? "row-warn" : "";
    referer = String(referer);
    const refererDisplay = referer === "-" || !referer ? "-" : hl(referer.slice(0, 100));
    return `<tr class="${cls}">
      <td class="td-ip">${hl(ip)}</td>
      <td class="td-ts">${formatTs(ts)}</td>
      <td>${hl(method)}</td>
      <td class="td-referer" title="${referer === "-" ? "" : escHtml(referer)}">${refererDisplay}</td>
      <td class="td-path" title="${escHtml(path)}">${hl(String(path).slice(0, 80))}</td>
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

//  Nginx Analytics 
let nginxChartTraffic = null;
let nginxAnalyticsHours = 24;
let nginxSearchTerm = "";
let nginxTrafficKeys = [];
let _nginxIPsCache = null;
let _nginxPathsCache = null;

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
    const errCard = el("nx-error-rate")?.closest(".metric-card");
    if (errCard && !errCard._nginxErrBound) {
      errCard._nginxErrBound = true;
      errCard.style.cursor = "pointer";
      errCard.title = "Click to inspect error logs";
      errCard.addEventListener("click", () => openNginxTraceModal({ mode: "errors" }));
    }
  } catch (e) { console.error("nginx overview:", e); }
}

async function loadNginxTraffic() {
  if (!window.Chart) return;
  try {
    const res = await fetch(`${API_BASE}/admin/nginx-logs/traffic?hours=${Math.min(nginxAnalyticsHours, 48)}`, { credentials: "include" });  // cap at 48h per endpoint constraint
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
    nginxTrafficKeys = keys;
    const fmtLbl = k => {
      const d = new Date(k.includes("T") ? k : k.replace(" ", "T"));
      return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
    };
    if (nginxChartTraffic) nginxChartTraffic.destroy();
    Chart.defaults.color = "#64748b"; Chart.defaults.font.family = "'Inter', sans-serif";
    nginxChartTraffic = new Chart(el("nginx-chart-traffic"), {
      type: "line",
      data: {
        labels: keys.map(fmtLbl),
        datasets: [
          { label: "2xx", data: keys.map(k => minuteMap[k].ok), borderColor: "#059669", backgroundColor: "rgba(5,150,105,0.1)", fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: "4xx", data: keys.map(k => minuteMap[k].warn), borderColor: "#d97706", backgroundColor: "rgba(217,119,6,0.08)", fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
          { label: "5xx", data: keys.map(k => minuteMap[k].err), borderColor: "#e11d48", backgroundColor: "rgba(225,29,72,0.12)", fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top", labels: { boxWidth: 10, font: { size: 11 } } } },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          const dsIdx = elements[0].datasetIndex;
          const statusBucket = ["2xx", "4xx", "5xx"][dsIdx] ?? "2xx";
          openNginxTraceModal({ mode: "time", minuteKey: nginxTrafficKeys[idx], statusBucket, chartIdx: idx });
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? "pointer" : "default";
        },
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
    const now = Date.now();
    if (!_nginxPathsCache || _nginxPathsCache.hours !== nginxAnalyticsHours || now - _nginxPathsCache.ts > 60000) {
      const res = await fetch(`${API_BASE}/admin/nginx-logs/top-paths?hours=${nginxAnalyticsHours}&limit=15`, { credentials: "include" });
      if (!res.ok) return;
      _nginxPathsCache = { data: await res.json(), ts: now, hours: nginxAnalyticsHours };
    }
    const rows = _nginxPathsCache.data;
    const tbody = el("nginx-top-paths-body");
    if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" style="padding:8px;color:var(--text-muted)">No data</td></tr>`; return; }
    tbody.innerHTML = rows.map(r => {
      const errs = parseInt(r.errors || 0);
      return `<tr class="nginx-path-row" data-path="${escHtml(String(r.path || ""))}" style="border-bottom:1px solid var(--border); cursor:pointer;">
        <td style="padding:4px 8px; color:var(--text-muted);">${escHtml(String(r.referer || "-"))}</td>
        <td style="padding:4px 8px; font-family:monospace; word-break:break-all; max-width:400px;">${escHtml(String(r.path || ""))}</td>
        <td style="padding:4px 8px; text-align:right;">${fmt(parseInt(r.total || 0))}</td>
        <td style="padding:4px 8px; text-align:right; color:${errs > 0 ? "var(--error)" : "inherit"}">${fmt(errs)}</td>
      </tr>`;
    }).join("");
    tbody.querySelectorAll(".nginx-path-row").forEach(tr => {
      tr.addEventListener("click", () => openNginxTraceModal({ mode: "path", path: tr.dataset.path }));
    });
  } catch (e) { console.error("nginx top paths:", e); }
}

async function loadNginxTopIPs() {
  try {
    const now = Date.now();
    if (!_nginxIPsCache || _nginxIPsCache.hours !== nginxAnalyticsHours || now - _nginxIPsCache.ts > 60000) {
      const res = await fetch(`${API_BASE}/admin/nginx-logs/top-ips?hours=${nginxAnalyticsHours}&limit=10`, { credentials: "include" });
      if (!res.ok) return;
      _nginxIPsCache = { data: await res.json(), ts: now, hours: nginxAnalyticsHours };
    }
    const rows = _nginxIPsCache.data;
    const container = el("nginx-top-ips-list");
    if (!rows.length) { container.innerHTML = `<div style="padding:8px;color:var(--text-muted)">No data</div>`; return; }
    const maxTotal = Math.max(...rows.map(r => parseInt(r.total || 0)), 1);
    container.innerHTML = rows.map(r => {
      const total = parseInt(r.total || 0);
      const errs = parseInt(r.errors || 0);
      const pct = Math.round(total / maxTotal * 100);
      const errPct = Math.round(errs / Math.max(total, 1) * 100);
      return `<div class="nginx-ip-row" data-ip="${escHtml(String(r.remote_addr || ""))}" style="padding:5px 8px; border-bottom:1px solid var(--border); cursor:pointer;">
        <div style="display:flex; justify-content:space-between; margin-bottom:3px;">
          <span style="font-family:monospace; font-size:11px;">${escHtml(String(r.remote_addr || ""))}</span>
          <span style="color:var(--text-muted); font-size:11px;">${fmt(total)}</span>
        </div>
        <div style="height:3px; background:var(--border); border-radius:2px;">
          <div style="height:3px; width:${pct}%; background:${errPct > 30 ? "var(--error)" : errPct > 10 ? "var(--warn)" : "var(--accent)"}; border-radius:2px;"></div>
        </div>
      </div>`;
    }).join("");
    container.querySelectorAll(".nginx-ip-row").forEach(div => {
      div.addEventListener("click", () => openNginxTraceModal({ mode: "ip", remote_addr: div.dataset.ip }));
    });
  } catch (e) { console.error("nginx top IPs:", e); }
}

async function loadNginxAnalytics() {
  await Promise.all([loadNginxOverview(), loadNginxTraffic(), loadNginxTopPaths(), loadNginxTopIPs()]);
}


function setPlatformMetricCard(id, value, stateClass = "") {
  const card = el(id);
  if (!card) return;
  card.classList.remove("is-warn", "is-danger", "is-empty");
  if (stateClass) card.classList.add(stateClass);
  const target = card.querySelector("strong");
  if (target) target.textContent = value;
}

function renderPlatformMetricsUnavailable(message) {
  ["platform-metric-request-rate", "platform-metric-error-rate", "platform-metric-p95", "platform-metric-5xx"].forEach(id => {
    setPlatformMetricCard(id, "--", "is-empty");
  });
  const paths = el("platform-metrics-paths");
  if (paths) paths.innerHTML = `<div class="platform-runtime-row is-muted">${escHtml(message)}</div>`;
  const empty = el("platform-metrics-empty");
  if (empty) {
    empty.textContent = message;
    empty.classList.remove("hidden");
  }
}

async function loadPlatformMetrics() {
  const windowHours = 24;
  const windowLabel = el("platform-metrics-window");
  if (windowLabel) {
    windowLabel.textContent = "loading";
    windowLabel.className = "platform-health-overall is-unknown";
  }
  try {
    const [overviewRes, pathsRes] = await Promise.all([
      fetch(`${API_BASE}/admin/nginx-logs/overview?hours=${windowHours}`, { credentials: "include" }),
      fetch(`${API_BASE}/admin/nginx-logs/top-paths?hours=${windowHours}&limit=5`, { credentials: "include" }),
    ]);
    if (!overviewRes.ok) {
      renderPlatformMetricsUnavailable("Network metrics are unavailable for this user or source.");
      if (windowLabel) windowLabel.textContent = "unavailable";
      return;
    }
    const overview = await overviewRes.json();
    const paths = pathsRes.ok ? await pathsRes.json() : [];
    const total = Number(overview.total_requests || 0);
    const errorRate = Number(overview.error_rate || 0);
    const p95 = Number(overview.p95_response_time || 0);
    const requestRate = total / (windowHours * 60);
    const serverErrors = Math.round(total * errorRate / 100);

    if (!total) {
      renderPlatformMetricsUnavailable("No gateway traffic has arrived in the last 24 hours.");
      if (windowLabel) windowLabel.textContent = "last 24h";
      return;
    }

    const rateLabel = requestRate >= 10 ? requestRate.toFixed(0) : requestRate.toFixed(2);
    setPlatformMetricCard("platform-metric-request-rate", rateLabel);
    setPlatformMetricCard("platform-metric-error-rate", `${errorRate.toFixed(1)}%`, errorRate >= 5 ? "is-danger" : errorRate >= 1 ? "is-warn" : "");
    setPlatformMetricCard("platform-metric-p95", `${p95.toFixed(3)}s`, p95 >= 1 ? "is-danger" : p95 >= 0.3 ? "is-warn" : "");
    setPlatformMetricCard("platform-metric-5xx", fmt(serverErrors), serverErrors > 0 ? "is-danger" : "");

    const empty = el("platform-metrics-empty");
    if (empty) empty.classList.add("hidden");
    if (windowLabel) {
      windowLabel.textContent = "last 24h";
      windowLabel.className = "platform-health-overall is-ok";
    }

    const container = el("platform-metrics-paths");
    if (container) {
      const rows = Array.isArray(paths) ? paths : [];
      if (!rows.length) {
        container.innerHTML = `<div class="platform-runtime-row is-muted">No top path data yet.</div>`;
      } else {
        container.innerHTML = rows.map((r) => {
          const path = String(r.path || "");
          const totalPath = Number(r.total || 0);
          const errors = Number(r.errors || 0);
          const p95Path = Number(r.p95_time || 0);
          const cls = errors > 0 || p95Path >= 1 ? " is-danger" : p95Path >= 0.3 ? " is-warn" : "";
          return `<button class="platform-metric-path${cls}" type="button" data-path="${escHtml(path)}">
            <span>${escHtml(path || "-")}</span>
            <strong>${p95Path.toFixed(3)}s p95</strong>
            <small>${fmt(errors)} errors / ${fmt(totalPath)} req</small>
          </button>`;
        }).join("");
        container.querySelectorAll(".platform-metric-path").forEach(btn => {
          btn.addEventListener("click", () => openNginxTraceModal({ mode: "path", path: btn.dataset.path || "" }));
        });
      }
    }
  } catch (e) {
    renderPlatformMetricsUnavailable("Network metrics could not be loaded.");
    if (windowLabel) windowLabel.textContent = "error";
    console.error("platform metrics:", e);
  }
}


function renderPlatformCorrelationUnavailable(message) {
  setText("platform-correlation-5xx", "--");
  setText("platform-correlation-4xx", "--");
  setText("platform-correlation-app-errors", "--");
  const status = el("platform-correlation-status");
  if (status) {
    status.textContent = "unavailable";
    status.className = "platform-health-overall is-unknown";
  }
  const list = el("platform-correlation-signals");
  if (list) list.innerHTML = '<div class="platform-runtime-row is-muted">' + escHtml(message) + '</div>';
}

function runPlatformCorrelationAction(action) {
  if (action === "network-errors") { openPlatformNetwork("errors"); return; }
  if (action === "network-4xx") { openPlatformNetwork("4xx"); return; }
  if (action === "network-paths") { openPlatformNetwork("paths"); return; }
  if (action === "app-errors") {
    const to = new Date();
    const from = new Date(to.getTime() - 60 * 60 * 1000);
    _drillToLogs({ fromDate: from.toISOString().slice(0, 16), toDate: to.toISOString().slice(0, 16), level: "ERROR" });
  }
}

function renderPlatformCorrelation(payload) {
  const data = payload || {};
  const gateway = data.gateway || {};
  const app = data.app || {};
  setText("platform-correlation-5xx", fmt(gateway.errors_5xx || 0));
  setText("platform-correlation-4xx", fmt(gateway.errors_4xx || 0));
  setText("platform-correlation-app-errors", fmt(app.errors || 0));
  const status = el("platform-correlation-status");
  if (status) {
    const stateClass = data.status === "danger" ? "is-fail" : data.status === "warn" ? "is-degraded" : data.status === "quiet" ? "is-ok" : "is-unknown";
    status.textContent = data.status || "checking";
    status.className = "platform-health-overall " + stateClass;
  }
  const list = el("platform-correlation-signals");
  if (!list) return;
  const signals = Array.isArray(data.signals) ? data.signals : [];
  if (!signals.length) {
    list.innerHTML = '<div class="platform-runtime-row is-muted">No gateway/app correlation signal in the last ' + fmt(data.window_minutes || 60) + ' minutes.</div>';
    return;
  }
  list.innerHTML = signals.map(signal => {
    const cls = signal.severity === "danger" ? "is-unhealthy" : signal.severity === "warn" ? "is-restarted" : "is-running";
    return '<button class="platform-correlation-row platform-runtime-row ' + cls + '" type="button" data-correlation-action="' + escHtml(signal.action || "") + '"><span class="platform-runtime-dot"></span><div><strong>' + escHtml(signal.label || "Signal") + '</strong><p>' + escHtml(signal.detail || "Evidence available") + '</p></div><span class="platform-runtime-badge">drill</span></button>';
  }).join("");
  list.querySelectorAll("[data-correlation-action]").forEach(btn => {
    btn.addEventListener("click", () => runPlatformCorrelationAction(btn.dataset.correlationAction || ""));
  });
}

async function loadPlatformCorrelation() {
  renderPlatformCorrelation({ status: "checking", window_minutes: 60, gateway: { errors_4xx: 0, errors_5xx: 0 }, app: { errors: 0 }, signals: [] });
  try {
    const res = await fetch(API_BASE + "/platform/correlation/gateway?hours=1", { credentials: "include" });
    if (!res.ok) { renderPlatformCorrelationUnavailable("Gateway/app correlation is unavailable for this user or source."); return; }
    renderPlatformCorrelation(await res.json());
  } catch (e) {
    renderPlatformCorrelationUnavailable("Gateway/app correlation could not be loaded.");
    console.error("platform correlation:", e);
  }
}

function setIncidentSummaryText(id, value) {
  const target = el(id);
  if (target) target.textContent = fmt(value || 0);
}

function renderPlatformIncidentUnavailable(message) {
  state.platformIncidentBundle = null;
  setIncidentSummaryText("platform-incident-errors", 0);
  setIncidentSummaryText("platform-incident-runtime", 0);
  setIncidentSummaryText("platform-incident-alerts", 0);
  setIncidentSummaryText("platform-incident-gateway", 0);
  const status = el("platform-incident-status");
  if (status) {
    status.textContent = "unavailable";
    status.className = "platform-health-overall is-unknown";
  }
  const scope = el("platform-incident-scope");
  if (scope) scope.textContent = message;
  const timeline = el("platform-incident-timeline");
  if (timeline) timeline.innerHTML = '<div class="platform-runtime-row is-muted">' + escHtml(message) + '</div>';
  const boundary = el("platform-incident-boundary");
  if (boundary) boundary.textContent = "Scoped evidence bundle only. No raw database access.";
  const detects = el("platform-incident-detects");
  if (detects) detects.textContent = "Detects: waiting for bounded incident evidence.";
  const limits = el("platform-incident-limitations");
  if (limits) limits.textContent = "Does not fix: application, runtime, gateway, or database root causes automatically.";
  const copyBtn = el("platform-incident-copy");
  if (copyBtn) copyBtn.disabled = true;
}

function incidentWindowAround(timestamp, minutes = 5) {
  const parsed = new Date(timestamp || Date.now());
  const from = new Date(parsed.getTime() - minutes * 60 * 1000);
  const to = new Date(parsed.getTime() + minutes * 60 * 1000);
  return { fromDate: from.toISOString().slice(0, 16), toDate: to.toISOString().slice(0, 16) };
}

function runPlatformIncidentAction(action, timestamp, level) {
  if (action === "logs") {
    const window = incidentWindowAround(timestamp, 5);
    _drillToLogs({ ...window, level: level || "" });
    return;
  }
  if (action === "runtime") {
    el("platform-runtime-diagnostics")?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  if (action === "alerts") {
    el("notif-dropdown")?.classList.remove("hidden");
    return;
  }
  runPlatformCorrelationAction(action);
}

function renderPlatformIncidentTimeline(payload) {
  const data = payload || {};
  state.platformIncidentBundle = data.bundle || null;
  const status = el("platform-incident-status");
  if (status) {
    const stateClass = data.status === "danger" ? "is-fail" : data.status === "warn" ? "is-degraded" : data.status === "quiet" ? "is-ok" : "is-unknown";
    status.textContent = data.status || "checking";
    status.className = "platform-health-overall " + stateClass;
  }
  const service = data.service || {};
  const scope = el("platform-incident-scope");
  if (scope) {
    scope.textContent = service.service_key
      ? service.host_id + " / " + service.compose_project + " / " + service.compose_service + " - last evidence window " + fmt((data.bundle?.scope?.window_minutes) || 60) + " min"
      : "Select a service to build a bounded incident timeline.";
  }
  const summary = data.summary || {};
  setIncidentSummaryText("platform-incident-errors", summary.error_logs || 0);
  setIncidentSummaryText("platform-incident-runtime", summary.runtime_signals || 0);
  setIncidentSummaryText("platform-incident-alerts", summary.notifications || 0);
  setIncidentSummaryText("platform-incident-gateway", summary.gateway_5xx || 0);

  const timeline = el("platform-incident-timeline");
  if (timeline) {
    const events = Array.isArray(data.timeline) ? data.timeline : [];
    if (!events.length) {
      timeline.innerHTML = '<div class="platform-runtime-row is-muted">No bounded incident evidence found in this window.</div>';
    } else {
      timeline.innerHTML = events.map(item => {
        const cls = item.severity === "danger" ? "is-unhealthy" : item.severity === "warn" ? "is-restarted" : "is-running";
        return '<button class="platform-correlation-row platform-runtime-row ' + cls + '" type="button" data-incident-action="' + escHtml(item.action || '') + '" data-incident-ts="' + escHtml(item.timestamp || '') + '" data-incident-level="' + escHtml(item.level || '') + '"><span class="platform-runtime-dot"></span><div><strong>' + escHtml(item.title || 'Evidence') + '</strong><p>' + escHtml(item.detail || 'No detail') + '</p></div><span class="platform-runtime-badge">' + escHtml(item.badge || item.source || 'event') + '</span></button>';
      }).join("");
      timeline.querySelectorAll("[data-incident-action]").forEach(btn => {
        btn.addEventListener("click", () => runPlatformIncidentAction(btn.dataset.incidentAction || "", btn.dataset.incidentTs || "", btn.dataset.incidentLevel || ""));
      });
    }
  }
  const boundary = el("platform-incident-boundary");
  if (boundary) boundary.textContent = (data.bundle && data.bundle.ai_boundary) || "Scoped evidence bundle only. No raw database access.";
  const detects = el("platform-incident-detects");
  if (detects) detects.textContent = "Detects: " + (((data.bundle && data.bundle.detects) || []).join("; ") || "No detection summary available.");
  const limits = el("platform-incident-limitations");
  if (limits) limits.textContent = "Does not fix: " + (((data.bundle && data.bundle.does_not_fix) || []).join("; ") || "No limitation summary available.");
  const copyBtn = el("platform-incident-copy");
  if (copyBtn) copyBtn.disabled = !state.platformIncidentBundle;
}

async function loadPlatformIncidentTimeline() {
  const service = getPlatformFocusService();
  if (!service || !service.service_key) {
    renderPlatformIncidentUnavailable("Select a service or wait for service identity data to build a bounded incident timeline.");
    return;
  }
  renderPlatformIncidentTimeline({ status: "checking", service, summary: { error_logs: 0, runtime_signals: 0, notifications: 0, gateway_5xx: 0 }, timeline: [], bundle: null });
  try {
    const url = API_BASE + "/platform/incidents/timeline?service_key=" + encodeURIComponent(service.service_key) + "&hours=1";
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      renderPlatformIncidentUnavailable("Incident evidence is unavailable for this user or service.");
      return;
    }
    renderPlatformIncidentTimeline(await res.json());
  } catch (e) {
    renderPlatformIncidentUnavailable("Incident evidence could not be loaded.");
    console.error("platform incident timeline:", e);
  }
}

async function copyPlatformEvidenceBundle() {
  const bundle = state.platformIncidentBundle;
  if (!bundle) return;
  const text = JSON.stringify(bundle, null, 2);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      const btn = el("platform-incident-copy");
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = prev; }, 1500);
      }
      return;
    }
  } catch { }
  window.prompt("Copy incident evidence bundle", text);
}

async function openNginxTraceModal({ mode, minuteKey, statusBucket, chartIdx, remote_addr, path }) {
  let chartHighlightIdx = (mode === "time" && chartIdx != null) ? chartIdx : -1;
  if (chartHighlightIdx >= 0 && nginxChartTraffic) {
    nginxChartTraffic.data.datasets.forEach(ds => {
      ds.pointRadius = ds.data.map((_, i) => i === chartHighlightIdx ? 5 : 0);
    });
    nginxChartTraffic.update("none");
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay ctx-overlay";
  overlay.innerHTML = `
    <div class="ctx-modal" style="min-width:min(1100px,96vw);">
      <header class="ctx-header">
        <span id="nx-modal-title">Loading...</span>
        <button id="nx-modal-close" class="ctx-close">?</button>
      </header>
      <div id="nx-modal-summary" style="padding:8px 16px; font-size:12px; opacity:.7; border-bottom:1px solid var(--border);"></div>
      <div id="nx-modal-body" class="ctx-body"><p style="padding:16px;opacity:.5">Loading...</p></div>
      <div class="ctx-footer" style="display:flex;justify-content:space-between;align-items:center;">
        <div id="nx-modal-pages" style="display:flex;gap:8px;align-items:center;"></div>
        <button id="nx-modal-apply" class="btn-secondary" style="font-size:11px;padding:4px 10px;">Apply filter to Network tab -></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const hours = nginxAnalyticsHours;
  const PAGE_SIZE = 100;

  const close = () => {
    if (chartHighlightIdx >= 0 && nginxChartTraffic) {
      nginxChartTraffic.data.datasets.forEach(ds => { ds.pointRadius = 0; });
      nginxChartTraffic.update("none");
    }
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  overlay.querySelector("#nx-modal-close").addEventListener("click", close);

  overlay.querySelector("#nx-modal-apply").addEventListener("click", () => {
    close();
    if (mode === "errors") {
      const sel = el("nginx-status-select"); if (sel) sel.value = "500";
    } else if (mode === "ip" && remote_addr) {
      const inp = el("nginx-search-input"); if (inp) inp.value = remote_addr;
    } else if (mode === "time" && minuteKey) {
      const mk = minuteKey.replace("T", " ");
      const datePart = mk.slice(0, 10);
      const hourPart = mk.slice(11, 13);
      const minPart  = mk.slice(14, 16);
      if (el("nginx-range-from-date"))   el("nginx-range-from-date").value   = datePart;
      if (el("nginx-range-from-hour"))   el("nginx-range-from-hour").value   = hourPart;
      if (el("nginx-range-from-minute")) el("nginx-range-from-minute").value = minPart;
      if (el("nginx-range-to-date"))     el("nginx-range-to-date").value     = datePart;
      if (el("nginx-range-to-hour"))     el("nginx-range-to-hour").value     = hourPart;
      if (el("nginx-range-to-minute"))   el("nginx-range-to-minute").value   = minPart;
      if (el("nginx-search-input"))      el("nginx-search-input").value      = "";
    } else if (mode === "path" && path) {
      const inp = el("nginx-search-input"); if (inp) inp.value = path;
    }
    loadNginxLogs();
  });

  const titles = {
    time: `Logs - ${minuteKey ? minuteKey.slice(11, 16) : ""} - ${statusBucket || "all"}`,
    ip: `IP: ${remote_addr}`,
    path: `Path: ${path}`,
    errors: `Error Logs (4xx+5xx) - last ${hours}h`,
  };
  overlay.querySelector("#nx-modal-title").textContent = titles[mode] || mode;

  if (mode === "ip" && remote_addr) {
    try {
      const s = await fetch(`${API_BASE}/admin/nginx-logs/ip-summary?remote_addr=${encodeURIComponent(remote_addr)}&hours=${hours}`, { credentials: "include" }).then(r => r.json());
      overlay.querySelector("#nx-modal-summary").textContent =
        `${fmt(s.total)} reqs - ${s.error_rate}% errors - first ${formatTs(s.first_seen)} - last ${formatTs(s.last_seen)}`;
    } catch { /* skip */ }
  } else if (mode === "path" && path) {
    try {
      const s = await fetch(`${API_BASE}/admin/nginx-logs/path-summary?path=${encodeURIComponent(path)}&hours=${hours}`, { credentials: "include" }).then(r => r.json());
      overlay.querySelector("#nx-modal-summary").textContent =
        `${fmt(s.total)} reqs - ${s.error_rate}% errors - first ${formatTs(s.first_seen)} - last ${formatTs(s.last_seen)}`;
    } catch { /* skip */ }
  }

  async function loadPage(page) {
    overlay.querySelector("#nx-modal-body").innerHTML = `<p style="padding:16px;opacity:.5">Loading...</p>`;
    try {
      const params = new URLSearchParams({ page, page_size: PAGE_SIZE, hours });
      params.set("order", mode === "ip" ? "desc" : "asc");
      if (mode === "time" && minuteKey) {
        params.set("from_time", minuteKey);
        const dt = new Date(minuteKey.includes("T") ? minuteKey : minuteKey.replace(" ", "T") + "Z");
        params.set("to_time", new Date(dt.getTime() + 60000).toISOString().slice(0, 19).replace("T", " "));
        if (statusBucket === "4xx") params.set("min_status", "400");
        if (statusBucket === "5xx") params.set("min_status", "500");
      } else if (mode === "ip" && remote_addr) {
        params.set("remote_addr", remote_addr);
      } else if (mode === "path" && path) {
        params.set("path_contains", path);
      } else if (mode === "errors") {
        params.set("min_status", "400");
      }

      const data = await fetch(`${API_BASE}/admin/nginx-logs/logs?${params}`, { credentials: "include" }).then(r => r.json());
      const rows = data.data || [];
      const totalPages = data.pages || 1;

      const pagesEl = overlay.querySelector("#nx-modal-pages");
      pagesEl.innerHTML = `
        <button id="nx-pg-prev" class="btn-ghost" style="font-size:11px;padding:3px 8px;" ${page <= 1 ? "disabled" : ""}><- Prev</button>
        <span style="font-size:11px;opacity:.6">Page ${page} / ${totalPages} - ${data.total || 0} rows</span>
        <button id="nx-pg-next" class="btn-ghost" style="font-size:11px;padding:3px 8px;" ${page >= totalPages ? "disabled" : ""}>Next -></button>`;
      pagesEl.querySelector("#nx-pg-prev")?.addEventListener("click", () => loadPage(page - 1));
      pagesEl.querySelector("#nx-pg-next")?.addEventListener("click", () => loadPage(page + 1));

      if (!rows.length) {
        overlay.querySelector("#nx-modal-body").innerHTML = `<p style="padding:16px;opacity:.5">No matching network logs.</p>`;
        return;
      }

      const showIP = mode !== "ip";
      overlay.querySelector("#nx-modal-body").innerHTML = `
        <table class="ctx-table" style="table-layout:fixed;">
          <colgroup>
            <col style="width:148px;">
            <col style="width:80px;">
            <col style="width:auto;">
            <col style="width:60px;">
            <col style="width:72px;">
            <col style="width:72px;">
            ${showIP ? `<col style="width:120px;">` : ""}
            <col style="width:160px;">
          </colgroup>
          <thead><tr>
            <th>Timestamp</th><th>Method</th><th>Path</th>
            <th>Status</th><th>Bytes</th><th>Time</th>
            ${showIP ? "<th>IP</th>" : ""}<th>Referer</th>
          </tr></thead>
          <tbody>${rows.filter(([ts, ip, method]) => ts || method).map(([ts, ip, method, referer, rpath, status, bytes, rtime]) => {
        const s = parseInt(status) || 0;
        const cls = s >= 500 ? "row-error" : s >= 400 ? "row-warn" : "";
        const badgeCls = s >= 500 ? "badge-error" : s >= 400 ? "badge-warn" : "badge-info";
        return `<tr class="${cls}">
              <td class="td-ts">${formatTs(ts)}</td>
              <td><span style="font-family:monospace;font-size:10px;">${escHtml(method || "--")}</span></td>
              <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:10px;" title="${escHtml(rpath || "")}">${escHtml(rpath || "--")}</td>
              <td>${s ? `<span class="badge ${badgeCls}">${s}</span>` : "--"}</td>
              <td style="font-size:11px;">${fmtBytes(parseInt(bytes) || 0)}</td>
              <td style="font-size:11px;">${parseFloat(rtime || 0).toFixed(3)}s</td>
              ${showIP ? `<td style="font-family:monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(ip || "")}</td>` : ""}
              <td style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(referer || "")}">${escHtml(referer || "--")}</td>
            </tr>`;
      }).join("")}</tbody>
        </table>`;
    } catch (e) {
      overlay.querySelector("#nx-modal-body").innerHTML = `<p style="padding:16px;color:var(--error)">Error: ${escHtml(e.message)}</p>`;
    }
  }

  loadPage(1);
}

function resetNginxFilters(shouldReload = true) {
  if (el('nginx-search-input')) el('nginx-search-input').value = '';
  if (el('nginx-status-select')) el('nginx-status-select').value = '';
  if (el('nginx-method-select')) el('nginx-method-select').value = '';
  if (el('nginx-sort-select')) el('nginx-sort-select').value = 'desc';
  if (el('nginx-range-from-date')) el('nginx-range-from-date').value = '';
  if (el('nginx-range-from-hour')) el('nginx-range-from-hour').value = '';
  if (el('nginx-range-from-minute')) el('nginx-range-from-minute').value = '';
  if (el('nginx-range-to-date')) el('nginx-range-to-date').value = '';
  if (el('nginx-range-to-hour')) el('nginx-range-to-hour').value = '';
  if (el('nginx-range-to-minute')) el('nginx-range-to-minute').value = '';
  nginxPage = 0;
  if (shouldReload) loadNginxLogs();
}

//  Analytics 
let chartVol = null, chartSev = null, chartLogsMini = null;

function analyticsGridColor() {
  return document.documentElement.dataset.theme === "dark" ? "#1e293b" : "#e2e8f0";
}

async function loadAnalytics() {
  if (!window.Chart) return;
  const hours = parseInt(el("analytics-hours-select")?.value || "24", 10);
  const interval = hours >= 168 ? "toStartOfDay" : hours >= 24 ? "toStartOfHour" : "toStartOfHour";
  const cidFilter = state.selectedStack && state.stackNames.length > 0
    ? `AND ContainerName IN (${state.stackNames.map(c => `'${esc(c)}'`).join(",")})${state.selectedProject ? ` AND ComposeProject = '${esc(state.selectedProject)}'` : ""}`
    : "";
  const section = el("analytics-section");
  section.classList.add("analytics-loading");
  try {
    const volData = await apiQuery(`
      SELECT ${interval}(Timestamp) as t, count(), countIf(lower(SeverityText)='error'), countIf(lower(SeverityText)='warn' OR lower(SeverityText)='warning')
      FROM observability.otel_logs_local WHERE Timestamp > now() - INTERVAL ${hours} HOUR AND ServiceName != 'nginx' ${cidFilter}
      GROUP BY t ORDER BY t ASC
    `);
    const labelFmt = hours <= 24
      ? { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false }
      : { timeZone: "Asia/Bangkok", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false };
    const labels = volData.map(r => {
      const s = String(r[0]);
      const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
      return new Intl.DateTimeFormat("sv-SE", labelFmt).format(d);
    });
    if (chartVol) chartVol.destroy();
    Chart.defaults.color = "#64748b"; Chart.defaults.font.family = "'Inter', sans-serif";
    const gc = analyticsGridColor();
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
        scales: {
          y: { beginAtZero: true, grid: { color: gc } },
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 45, autoSkip: true } }
        },
        onClick: async (evt, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          const raw = String(volData[idx][0]);
          const dt = raw.replace(" ", "T").slice(0, 13);
          const fromDate = dt + ":00:00";
          const toDate = dt + ":59:59";
          const label = `${dt.slice(0, 10)} ${dt.slice(11, 13)}:00`;
          
          // Set hour filter
          state.analyticsHourFilter = { fromDate, toDate, label };
          state.analyticsLevelFilter = null;
          
          // Update donut for this hour
          await updateSeverityDonut(fromDate, toDate);
          // Show sample logs
          loadAnalyticsSampleLogs();
        }
      }
    });

    // Initial donut (full range) or filtered
    if (state.analyticsHourFilter) {
      await updateSeverityDonut(state.analyticsHourFilter.fromDate, state.analyticsHourFilter.toDate);
    } else {
      const sevData = await apiQuery(`
        SELECT if(SeverityText='','unknown',lower(SeverityText)) as lvl, count() as c
        FROM observability.otel_logs_local
        WHERE Timestamp > now() - INTERVAL ${hours} HOUR AND ServiceName != 'nginx' ${cidFilter}
        GROUP BY lvl ORDER BY c DESC
      `);
      renderSeverityDonut(sevData, null);
    }
    
    // Load sample logs
    loadAnalyticsSampleLogs();

  } catch (e) {
    console.error("Analytics error:", e);
  } finally {
    section.classList.remove("analytics-loading");
  }
}

async function updateSeverityDonut(fromDate, toDate) {
  const cidFilter = state.selectedStack && state.stackNames.length > 0
    ? `AND ContainerName IN (${state.stackNames.map(c => `'${esc(c)}'`).join(",")})${state.selectedProject ? ` AND ComposeProject = '${esc(state.selectedProject)}'` : ""}`
    : "";
  const fromTs = fromDate.replace("T", " ");
  const toTs = toDate.replace("T", " ");
  
  const sevData = await apiQuery(`
    SELECT if(SeverityText='','unknown',lower(SeverityText)) as lvl, count() as c
    FROM observability.otel_logs_local
    WHERE Timestamp >= '${fromTs}' AND Timestamp < '${toTs}' AND ServiceName != 'nginx' ${cidFilter}
    GROUP BY lvl ORDER BY c DESC
  `);
  renderSeverityDonut(sevData, { fromDate, toDate });
}

function renderSeverityDonut(sevData, hourFilter) {
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
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "65%",
      plugins: { legend: { position: "right" } },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const lvl = String(sLabels[elements[0].index]).toLowerCase();
        state.analyticsLevelFilter = lvl;
        loadAnalyticsSampleLogs();
      }
    }
  });
}

async function loadAnalyticsSampleLogs() {
  const panel = el("analytics-detail");
  const titleEl = el("analytics-detail-title");
  const logsBody = el("analytics-detail-logs");
  
  let fromDate, toDate;
  if (state.analyticsHourFilter) {
    fromDate = state.analyticsHourFilter.fromDate;
    toDate = state.analyticsHourFilter.toDate;
    titleEl.textContent = `Details: ${state.analyticsHourFilter.label}`;
  } else {
    const hours = parseFloat(el("analytics-hours-select")?.value || 24);
    fromDate = null;
    toDate = null;
    titleEl.textContent = `Sample Logs (Last ${hours}h)`;
  }
  
  panel.classList.remove("hidden");
  
  const cidFilter = state.selectedStack && state.stackNames.length > 0
    ? `AND ContainerName IN (${state.stackNames.map(c => `'${esc(c)}'`).join(",")})${state.selectedProject ? ` AND ComposeProject = '${esc(state.selectedProject)}'` : ""}`
    : "";
  const lvlFilter = state.analyticsLevelFilter ? `AND lower(SeverityText)='${state.analyticsLevelFilter}'` : "";
  
  let whereClause;
  if (fromDate && toDate) {
    const fromTs = fromDate.replace("T", " ");
    const toTs = toDate.replace("T", " ");
    whereClause = `Timestamp >= '${fromTs}' AND Timestamp < '${toTs}'`;
  } else {
    const hours = parseFloat(el("analytics-hours-select")?.value || 24);
    whereClause = `Timestamp > now() - INTERVAL ${hours} HOUR`;
  }
  
  try {
    const rows = await apiQuery(`
      SELECT Timestamp, ServiceName, ContainerName, SeverityText, Body
      FROM observability.otel_logs_local
      WHERE ${whereClause} AND ServiceName != 'nginx' ${lvlFilter} ${cidFilter}
      ORDER BY Timestamp DESC LIMIT 5
    `);
    
    if (!rows.length) {
      logsBody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted);">No logs found.</td></tr>`;
      return;
    }
    
    logsBody.innerHTML = rows.map(([ts, svc, cname, lvl, body]) => {
      const lvlLower = (lvl || "").toLowerCase();
      const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvlLower] || "badge-other";
      const displayName = containerAliases[cname] || cname;
      const msgPreview = String(body).slice(0, 80).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px; color:var(--text-dim); font-family:'JetBrains Mono',monospace; font-size:11px;">${String(ts).slice(11, 19)}</td>
        <td style="padding:8px; color:var(--text);">${escHtml(String(svc))}</td>
        <td style="padding:8px; color:var(--text);">${escHtml(String(displayName))}</td>
        <td style="padding:8px;"><span class="badge ${badgeCls}">${escHtml(lvlLower || "--")}</span></td>
        <td style="padding:8px; color:var(--text-muted); font-size:11px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(String(body).slice(0, 200))}">${msgPreview}</td>
      </tr>`;
    }).join("");
  } catch (e) {
    logsBody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted);">Error: ${e.message}</td></tr>`;
  }
}

async function showAnalyticsDetail(fromDate, toDate, level, label) {
  console.log("showAnalyticsDetail called:", fromDate, toDate, level, label);
  state.analyticsDetail = { fromDate, toDate, level, label };
  const panel = el("analytics-detail");
  console.log("Panel element:", panel);
  const titleEl = el("analytics-detail-title");
  const logsBody = el("analytics-detail-logs");
  
  titleEl.textContent = `Details: ${label}`;
  panel.classList.remove("hidden");
  panel.style.display = "block";
  console.log("Panel visible, classList:", panel.classList, "display:", panel.style.display);
  
  const fromTs = fromDate.replace("T", " ");
  const toTs = toDate.replace("T", " ");
  const lvlFilter = level ? `AND lower(SeverityText)='${level}'` : "";
  console.log("Query params:", fromTs, toTs, lvlFilter);
  
  try {
    const rows = await apiQuery(`
      SELECT Timestamp, ServiceName, ContainerName, SeverityText, Body
      FROM observability.otel_logs_local
      WHERE Timestamp >= '${fromTs}' AND Timestamp < '${toTs}' AND ServiceName != 'nginx' ${lvlFilter} ${state.selectedStack && state.stackNames.length > 0 ? `AND ContainerName IN (${state.stackNames.map(c => `'${esc(c)}'`).join(",")})` : ""}
      ORDER BY Timestamp DESC LIMIT 5
    `);
    console.log("Query returned rows:", rows.length, rows);
    
    if (!rows.length) {
      logsBody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted);">No logs found for this period.</td></tr>`;
      return;
    }
    
    logsBody.innerHTML = rows.map(([ts, svc, cname, lvl, body]) => {
      const lvlLower = (lvl || "").toLowerCase();
      const badgeCls = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" }[lvlLower] || "badge-other";
      const displayName = containerAliases[cname] || cname;
      const msgPreview = String(body).slice(0, 80).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:8px; color:var(--text-dim); font-family:'JetBrains Mono',monospace; font-size:11px;">${String(ts).slice(11, 19)}</td>
        <td style="padding:8px; color:var(--text);">${escHtml(String(svc))}</td>
        <td style="padding:8px; color:var(--text);">${escHtml(String(displayName))}</td>
        <td style="padding:8px;"><span class="badge ${badgeCls}">${escHtml(lvlLower || "--")}</span></td>
        <td style="padding:8px; color:var(--text-muted); font-size:11px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(String(body).slice(0, 200))}">${msgPreview}</td>
      </tr>`;
    }).join("");
  } catch (e) {
    logsBody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted);">Error loading logs: ${e.message}</td></tr>`;
  }
}

function hideAnalyticsDetail() {
  state.analyticsDetail = null;
  state.analyticsHourFilter = null;
  state.analyticsLevelFilter = null;
  el("analytics-detail").classList.add("hidden");
}

async function loadLogsMiniChart() {
  if (!window.Chart || !el("chart-logs-mini")) return;
  const where = buildWhere();
  const rows = await apiQuery(
    `SELECT toStartOfHour(Timestamp) as h, count() as cnt
     FROM observability.otel_logs_local ${where} AND ServiceName != 'nginx'
     GROUP BY h ORDER BY h`
  );
  const labels = rows.map(r => String(r[0]).slice(0, 13)); // "YYYY-MM-DD HH"
  const counts = rows.map(r => parseInt(r[1], 10));
  if (chartLogsMini) chartLogsMini.destroy();
  chartLogsMini = new Chart(el("chart-logs-mini"), {
    type: "bar",
    data: { labels, datasets: [{ data: counts, backgroundColor: "rgba(79,70,229,0.45)", borderRadius: 2, hoverBackgroundColor: "rgba(79,70,229,0.8)" }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (i) => i[0].label + ":00", label: (i) => ` ${i.raw} logs` } }
      },
      scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const h = labels[elements[0].index]; // "YYYY-MM-DD HH"
        _drillToLogs({ fromDate: h.replace(" ", "T") + ":00", toDate: h.replace(" ", "T") + ":59" });
      }
    }
  });
}

//  Clear DB Modal 
function openClearModal() {
  el("modal-overlay").classList.remove("hidden");
  el("modal-error").classList.add("hidden");
  updateModalPreview();
}
function closeClearModal() { el("modal-overlay").classList.add("hidden"); }
function updateModalPreview() {
  const val = document.querySelector('input[name="clear-range"]:checked')?.value || "90";
  let sql;
  if (val === "all") sql = `TRUNCATE TABLE observability.otel_logs_local`;
  else if (val === "7" || val === "30") sql = `ALTER TABLE observability.otel_logs_local DELETE\n  WHERE Timestamp < now() - INTERVAL ${val} DAY AND ServiceName != 'nginx'`;
  else { sql = `ALTER TABLE observability.otel_logs_local DELETE\n  WHERE Timestamp < now() - INTERVAL 90 DAY AND ServiceName != 'nginx'`; }
  el("modal-query-preview").textContent = sql;
}
async function executeClear() {
  const val = document.querySelector('input[name="clear-range"]:checked')?.value || "90";
  let sql;
  if (val === "all") sql = `TRUNCATE TABLE observability.otel_logs_local`;
  else if (val === "7" || val === "30") sql = `ALTER TABLE observability.otel_logs_local DELETE WHERE Timestamp < now() - INTERVAL ${parseInt(val, 10)} DAY AND ServiceName != 'nginx'`;
  else { sql = `ALTER TABLE observability.otel_logs_local DELETE WHERE Timestamp < now() - INTERVAL 90 DAY AND ServiceName != 'nginx'`; }
  try {
    el("btn-modal-confirm").disabled = true; el("btn-modal-confirm").textContent = "Deleting...";
    await apiExec(sql);
    closeClearModal();
    await Promise.all([loadMetrics(), loadContainerList(), loadLogs()]);
  } catch (e) {
    el("modal-error").classList.remove("hidden");
    el("modal-error").textContent = "Error: " + (e.message || "An error occurred");
  } finally {
    el("btn-modal-confirm").disabled = false; el("btn-modal-confirm").textContent = "Confirm Delete";
  }
}

//  Export Panel 
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

  const fromVal = getCustomDateTime("range-from");
  const toVal = getCustomDateTime("range-to");
  el("export-from-dt").value = fromVal || "";
  el("export-to-dt").value = toVal || "";
  el("export-from-dt").disabled = false;
  el("export-to-dt").disabled = false;
  el("export-all-time").checked = false;
  const statusEl = el("export-status");
  statusEl.className = "export-status-msg hidden";
  statusEl.textContent = "";

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
      matches.push({ type: "stack", label: `Stack: ${stackName}`, names: items.map(d => d.displayName), name: stackName });
  }
  // Search individual containers
  lastSidebarRows.forEach(([cname]) => {
    if (cname.toLowerCase().includes(q))
      matches.push({ type: "container", label: `Container: ${cname}`, names: [cname], name: cname });
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
  el("export-from-dt").disabled = checked;
  el("export-to-dt").disabled = checked;
});

el("btn-export-confirm").addEventListener("click", async () => {
  const btn = el("btn-export-confirm");
  const status = el("export-status");
  const allTime = el("export-all-time").checked;

  const params = new URLSearchParams();
  if (exportSelectedContainers.length > 0)
    params.set("container_names", exportSelectedContainers.map(c => c.name).join(","));

  const fromTs = el("export-from-dt").value;
  const toTs = el("export-to-dt").value;

  if (!allTime && fromTs)
    params.set("from_ts", fromTs.replace("T", " ") + ":00");
  if (!allTime && toTs)
    params.set("to_ts", toTs.replace("T", " ") + ":00");

  btn.disabled = true;
  btn.textContent = "Preparing...";
  status.textContent = "Generating export...";
  status.className = "export-status-msg";
  status.classList.remove("hidden");

  try {
    const res = await fetch(`${API_BASE}/export?${params.toString()}`, { credentials: "include" });
    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${txt.slice(0, 200)}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const fname = cd.match(/filename="([^"]+)"/)?.[1] || `logs_${Date.now()}.jsv`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    status.textContent = "Download started";
    status.classList.add("success");
    setTimeout(() => el("export-overlay").classList.add("hidden"), 3000);
  } catch (e) {
    status.textContent = "Export failed: " + e.message;
    status.classList.add("error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Download JSV";
  }
});

function closeExportPanel() { el("export-overlay").classList.add("hidden"); }
el("btn-export-cancel").addEventListener("click", closeExportPanel);
el("btn-export-close").addEventListener("click", closeExportPanel);
el("export-overlay").addEventListener("click", e => {
  if (e.target === el("export-overlay")) closeExportPanel();
});

//  Notifications (SSE) 
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
    renderAlertHistory();
    updateNotifBadge();
  } catch { }
}

function addNotification(notif) {
  // Prevent duplicates
  if (state.notifications.find(n => n.id === notif.id)) return;
  state.notifications.unshift({ ...notif, read: false });
  state.unreadCount++;
  renderNotifications();
  renderAlertHistory();
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
      <label><input type="radio" name="notif-filter" value="custom_alert" ${state.notifFilter === "custom_alert" ? "checked" : ""}> Custom</label>
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
  renderAlertHistory();
});

//  Admin Alert Rules 
function alertRuleRecipientsText(recipients) {
  if (Array.isArray(recipients)) return recipients.join(", ");
  return String(recipients || "");
}

function showAlertRuleFeedback(message, isError = false) {
  const status = el("alert-rule-feedback");
  if (!status) return;
  status.textContent = message;
  status.className = `admin-inline-status ${isError ? "is-error" : "is-ok"}`;
  status.classList.remove("hidden");
}

function clearAlertRuleFeedback() {
  const status = el("alert-rule-feedback");
  if (!status) return;
  status.textContent = "";
  status.className = "admin-inline-status hidden";
}

function alertRulePayloadFromValues(values) {
  return {
    name: (values.name || "").trim(),
    source: values.source || "application",
    condition: (values.condition || "").trim(),
    severity: values.severity || "warning",
    recipients: (values.recipients || "").trim(),
    cooldown_sec: Math.max(0, parseInt(values.cooldown_sec || "0", 10) || 0),
    enabled: Boolean(values.enabled),
  };
}

function getCreateAlertRulePayload() {
  return alertRulePayloadFromValues({
    name: el("alert-rule-name")?.value,
    source: el("alert-rule-source")?.value,
    condition: el("alert-rule-condition")?.value,
    severity: el("alert-rule-severity")?.value,
    recipients: el("alert-rule-recipients")?.value,
    cooldown_sec: el("alert-rule-cooldown")?.value,
    enabled: el("alert-rule-enabled")?.checked,
  });
}

function getExistingAlertRulePayload(ruleId) {
  const card = document.querySelector(`[data-alert-rule-id="${ruleId}"]`);
  if (!card) return null;
  return alertRulePayloadFromValues({
    name: card.querySelector('[data-field="name"]')?.value,
    source: card.querySelector('[data-field="source"]')?.value,
    condition: card.querySelector('[data-field="condition"]')?.value,
    severity: card.querySelector('[data-field="severity"]')?.value,
    recipients: card.querySelector('[data-field="recipients"]')?.value,
    cooldown_sec: card.querySelector('[data-field="cooldown_sec"]')?.value,
    enabled: card.querySelector('[data-field="enabled"]')?.checked,
  });
}

async function loadAlertRules() {
  const list = el("alert-rules-list");
  if (!list) return;
  try {
    const res = await fetch(`${API_BASE}/admin/alert-rules`, { credentials: "include" });
    if (!res.ok) throw new Error("Failed to load alert rules");
    state.alertRules = await res.json();
    renderAlertRules();
  } catch {
    state.alertRules = [];
    list.innerHTML = `<div class="admin-empty">Failed to load alert rules</div>`;
  }
}

function renderAlertRules() {
  const list = el("alert-rules-list");
  const badge = el("alert-rule-count-badge");
  if (!list) return;
  if (badge) badge.textContent = state.alertRules.length;
  if (!state.alertRules.length) {
    list.innerHTML = `<div class="admin-empty">No alert rules yet</div>`;
    return;
  }
  list.innerHTML = state.alertRules.map(rule => {
    const lastFired = rule.last_fired_at ? `Last test ${formatTs(rule.last_fired_at)}` : "Never fired";
    return `
      <article class="admin-alert-rule" data-alert-rule-id="${rule.id}">
        <div class="admin-alert-rule-header">
          <span class="admin-alert-rule-name">${escHtml(rule.name)}</span>
          <span class="admin-alert-meta">${escHtml(rule.source)}</span>
        </div>
        <div class="admin-alert-grid">
          <label class="admin-alert-field">
            <span>Name</span>
            <input class="admin-alert-input" data-field="name" type="text" value="${escHtml(rule.name)}" />
          </label>
          <label class="admin-alert-field">
            <span>Source</span>
            <select class="admin-alert-input" data-field="source">
              <option value="application" ${rule.source === "application" ? "selected" : ""}>Application</option>
              <option value="gateway" ${rule.source === "gateway" ? "selected" : ""}>Gateway</option>
              <option value="database" ${rule.source === "database" ? "selected" : ""}>Database</option>
              <option value="host" ${rule.source === "host" ? "selected" : ""}>Host</option>
            </select>
          </label>
          <label class="admin-alert-field admin-alert-field-full">
            <span>Trigger condition</span>
            <textarea class="admin-alert-textarea" data-field="condition">${escHtml(rule.condition)}</textarea>
          </label>
          <label class="admin-alert-field admin-alert-field-full">
            <span>Recipients</span>
            <input class="admin-alert-input" data-field="recipients" type="text" value="${escHtml(alertRuleRecipientsText(rule.recipients))}" />
          </label>
          <label class="admin-alert-field">
            <span>Severity</span>
            <select class="admin-alert-input" data-field="severity">
              <option value="warning" ${rule.severity === "warning" ? "selected" : ""}>Warning</option>
              <option value="critical" ${rule.severity === "critical" ? "selected" : ""}>Critical</option>
              <option value="info" ${rule.severity === "info" ? "selected" : ""}>Info</option>
            </select>
          </label>
          <label class="admin-alert-field">
            <span>Cooldown sec</span>
            <input class="admin-alert-input" data-field="cooldown_sec" type="number" min="0" step="30" value="${Number(rule.cooldown_sec || 0)}" />
          </label>
        </div>
        <div class="admin-alert-actions">
          <label class="admin-alert-toggle"><input data-field="enabled" type="checkbox" ${rule.enabled ? "checked" : ""} /> Enabled</label>
          <div class="admin-alert-actions-right">
            <span class="admin-alert-meta">${escHtml(lastFired)}</span>
            <button class="btn-ghost" data-alert-action="test" style="font-size:11px; padding:4px 8px;">Test</button>
            <button class="btn-primary" data-alert-action="save" style="font-size:11px; padding:4px 8px;">Save</button>
          </div>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll('[data-alert-action="save"]').forEach(btn => {
    btn.addEventListener("click", () => saveAlertRule(btn.closest("[data-alert-rule-id]")?.dataset.alertRuleId));
  });
  list.querySelectorAll('[data-alert-action="test"]').forEach(btn => {
    btn.addEventListener("click", () => testAlertRule(btn.closest("[data-alert-rule-id]")?.dataset.alertRuleId));
  });
}

function renderAlertHistory() {
  const list = el("alert-history-list");
  if (!list) return;
  const items = state.notifications.filter(n => n.type === "custom_alert").slice(0, 8);
  if (!items.length) {
    list.innerHTML = `<div class="admin-empty">No custom alerts yet</div>`;
    return;
  }
  list.innerHTML = items.map(item => `
    <div class="admin-alert-history-item">
      <div class="admin-alert-history-title">${escHtml(item.title)}</div>
      <div style="font-size:11px; color:var(--text-dim);">${escHtml(item.message)}</div>
      <div class="admin-alert-history-meta">${escHtml(item.severity || "warning")} - ${formatTs(item.created_at || new Date().toISOString())}</div>
    </div>
  `).join("");
}

async function createAlertRuleFromForm() {
  clearAlertRuleFeedback();
  const payload = getCreateAlertRulePayload();
  if (!payload.name || !payload.condition) {
    showAlertRuleFeedback("Rule name and condition required", true);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/admin/alert-rules`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Failed to create alert rule");
    }
    el("alert-rule-name").value = "";
    el("alert-rule-condition").value = "";
    el("alert-rule-recipients").value = "";
    el("alert-rule-cooldown").value = "300";
    el("alert-rule-enabled").checked = true;
    showAlertRuleFeedback("Alert rule created");
    await loadAlertRules();
  } catch (err) {
    showAlertRuleFeedback(err.message || "Failed to create alert rule", true);
  }
}

async function saveAlertRule(ruleId) {
  if (!ruleId) return;
  const payload = getExistingAlertRulePayload(ruleId);
  if (!payload || !payload.name || !payload.condition) {
    showAlertRuleFeedback("Rule name and condition required", true);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/admin/alert-rules/${ruleId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Failed to save alert rule");
    }
    showAlertRuleFeedback(`Alert rule ${ruleId} saved`);
    await loadAlertRules();
  } catch (err) {
    showAlertRuleFeedback(err.message || "Failed to save alert rule", true);
  }
}

async function testAlertRule(ruleId) {
  if (!ruleId) return;
  clearAlertRuleFeedback();
  try {
    const res = await fetch(`${API_BASE}/admin/alert-rules/${ruleId}/test`, {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Failed to test alert rule");
    if (data.status === "cooldown") {
      showAlertRuleFeedback(`Cooldown active: ${data.remaining_sec}s left`, true);
      return;
    }
    if (data.status === "disabled") {
      showAlertRuleFeedback("Rule disabled. Enable it before testing.", true);
      return;
    }
    showAlertRuleFeedback(`Test alert sent for rule ${ruleId}`);
    await Promise.all([loadAlertRules(), loadNotifications()]);
  } catch (err) {
    showAlertRuleFeedback(err.message || "Failed to test alert rule", true);
  }
}

//  Admin Panel 
async function loadAdminPanel() {
  await Promise.all([loadUserList(), loadOwnershipList(), loadAlertRules(), loadNotifications()]);
  refreshBackupState();
  renderAlertHistory();
}

async function loadUserList(q = "") {
  try {
    const res = await fetch(`${API_BASE}/admin/users?q=${encodeURIComponent(q)}`, { credentials: "include" });
    if (!res.ok) return;
    const users = await res.json();
    const list = el("user-list");
    const badge = el("user-count-badge");
    if (badge) badge.textContent = users.length;
    if (!users.length) { list.innerHTML = `<div class="admin-empty">No users found</div>`; return; }

    // Also populate assign dropdown
    const sel = el("assign-user-select");
    sel.innerHTML = `<option value="">-- Select user --</option>`;
    users.forEach(u => {
      const opt = document.createElement("option");
      opt.value = u.id; opt.textContent = `${u.username} (${u.role})`;
      sel.appendChild(opt);
    });

    list.innerHTML = users.map(u => `
      <div class="admin-user-row">
        <div class="admin-user-info">
          <span class="admin-username">${escHtml(u.username)}</span>
          <span class="admin-email">${escHtml(u.email || "--")}</span>
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
          btn.textContent = "Saved";
          setTimeout(() => btn.textContent = "Save", 2000);
        } catch { btn.textContent = "Error"; }
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
        <span class="admin-arrow">-></span>
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
    const [cname, , , , rawProject] = row;
    if (ownedIds.includes(cname) || assignSelectedContainers.find(c => c.id === cname && c.project === (rawProject || ""))) return;
    if (cname.toLowerCase().includes(q)) {
      matches.push({ type: "container", id: cname, name: cname, project: rawProject || "" });
    }
  });

  // detect duplicate container names across different projects
  const nameCounts = {};
  matches.forEach(m => { nameCounts[m.name] = (nameCounts[m.name] || 0) + 1; });

  if (!matches.length) { results.innerHTML = `<div class="export-no-result">No matches</div>`; results.classList.remove("hidden"); return; }

  results.innerHTML = "";
  matches.slice(0, 10).forEach(m => {
    const isDupe = nameCounts[m.name] > 1;
    const displayLabel = isDupe && m.project ? `${m.name} (${m.project})` : m.name;
    const item = document.createElement("div");
    item.className = "export-result-item";
    item.textContent = `Container: ${displayLabel}`;
    item.addEventListener("click", () => {
      assignSelectedContainers.push({ id: m.id, label: displayLabel, project: m.project });
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

//  Settings 
async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings`, { credentials: "include" });
    if (!res.ok) return;
    state.settings = await res.json();

    // Populate settings inputs
    if (el("setting-ttl")) el("setting-ttl").value = state.settings.ttl_days || "90";
    if (el("setting-backup-hour")) el("setting-backup-hour").value = state.settings.backup_hour_utc || "20";
    if (el("setting-green")) el("setting-green").value = state.settings.dot_green_threshold_sec || "60";
    if (el("setting-amber")) el("setting-amber").value = state.settings.dot_amber_threshold_sec || "300";
    if (el("setting-color-green")) el("setting-color-green").value = state.settings.active_color_green || "#059669";
  } catch { }
}

//  Settings 
document.querySelectorAll(".btn-save-setting").forEach(btn => {
  btn.addEventListener("click", async () => {
    const key = btn.dataset.key;
    const inputId = btn.dataset.src;
    const val = el(inputId).value;
    try {
      btn.textContent = "...";
      await fetch(`${API_BASE}/settings`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: val })
      });
      btn.textContent = "OK";
      setTimeout(() => btn.textContent = "Save", 1500);
      state.settings[key] = val;
      if (key === "active_color_green") document.documentElement.style.setProperty("--success", val);
    } catch { btn.textContent = "Err"; }
  });
});

//  Tabs 
function setActiveTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  el(tabId)?.classList.add("active");
}

function hideMainViews() {
  ["overview-section", "platform-section", "logs-view-wrapper", "analytics-section", "admin-section", "nginx-view-wrapper", "patterns-section"].forEach(id => {
    el(id)?.classList.add("hidden");
  });
}

function activateOverviewView() {
  state.view = "overview";
  setActiveTab("tab-overview");
  hideMainViews();
  el("overview-section")?.classList.remove("hidden");
  hideAnalyticsDetail();
  stopLogsSSE();
  stopNginxSSE();
  loadOverview();
}

function activateLogsView() {
  state.view = "logs";
  setActiveTab("tab-logs");
  hideMainViews();
  el("logs-view-wrapper")?.classList.remove("hidden");
  hideAnalyticsDetail();
  stopNginxSSE();
  startLogsSSE();
}
function activatePlatformView() {
  state.view = "platform";
  setActiveTab("tab-platform");
  hideMainViews();
  el("platform-section")?.classList.remove("hidden");
  renderPlatformCockpit();
  loadPlatformMetrics();
  loadPlatformCorrelation();
  loadPlatformIncidentTimeline();
  loadPlatformHealth();
  loadPlatformRuntime();
  loadPlatformWorkloadDatabases();
  loadPlatformUptime();
  hideAnalyticsDetail();
  stopLogsSSE();
  stopNginxSSE();
}

el("tab-overview")?.addEventListener("click", activateOverviewView);
el("tab-platform")?.addEventListener("click", activatePlatformView);
el('platform-health-refresh')?.addEventListener('click', loadPlatformHealth);
el('platform-runtime-refresh')?.addEventListener('click', loadPlatformRuntime);
el('platform-uptime-refresh')?.addEventListener('click', loadPlatformUptime);
el('platform-workload-db-refresh')?.addEventListener('click', loadPlatformWorkloadDatabases);
el('platform-incident-refresh')?.addEventListener('click', loadPlatformIncidentTimeline);
el('platform-incident-copy')?.addEventListener('click', copyPlatformEvidenceBundle);
el('platform-metrics-refresh')?.addEventListener('click', () => { loadPlatformMetrics(); loadPlatformCorrelation(); loadPlatformIncidentTimeline(); });

el("tab-logs").addEventListener("click", () => {
  activateLogsView();
  return;
  state.view = "logs";
  el("tab-logs").classList.add("active");
  el("tab-analytics").classList.remove("active");
  el("tab-admin").classList.remove("active");
  el("tab-nginx").classList.remove("active");
  el("tab-patterns")?.classList.remove("active");
  el("logs-view-wrapper").classList.remove("hidden");
  el("analytics-section").classList.add("hidden");
  el("admin-section").classList.add("hidden");
  el("nginx-view-wrapper").classList.add("hidden");
  el("patterns-section")?.classList.add("hidden");
  hideAnalyticsDetail();
  stopNginxSSE();
  startLogsSSE();
});

el("tab-analytics").addEventListener("click", () => {
  state.view = "analytics";
  setActiveTab("tab-analytics");
  hideMainViews();
  el("analytics-section").classList.remove("hidden");
  loadAnalytics();
  stopLogsSSE();
  stopNginxSSE();
  return;
  state.view = "analytics";
  el("tab-analytics").classList.add("active");
  el("tab-logs").classList.remove("active");
  el("tab-admin").classList.remove("active");
  el("tab-nginx").classList.remove("active");
  el("tab-patterns")?.classList.remove("active");
  el("analytics-section").classList.remove("hidden");
  el("logs-view-wrapper").classList.add("hidden");
  el("admin-section").classList.add("hidden");
  el("nginx-view-wrapper").classList.add("hidden");
  el("patterns-section")?.classList.add("hidden");
  
  // Restore panel if there were pending filters from "View Full Logs"
  if (state.analyticsPendingViewLogs) {
    if (state.analyticsPendingViewLogs.fromDate) {
      state.analyticsHourFilter = {
        fromDate: state.analyticsPendingViewLogs.fromDate,
        toDate: state.analyticsPendingViewLogs.toDate,
        label: state.analyticsPendingViewLogs.fromDate.replace("T", " ").slice(0, 13) + ":00"
      };
    }
    state.analyticsLevelFilter = state.analyticsPendingViewLogs.level || null;
  }
  
  loadAnalytics();
  stopLogsSSE();
});

el("tab-admin").addEventListener("click", () => {
  state.view = "admin";
  setActiveTab("tab-admin");
  hideMainViews();
  el("admin-section").classList.remove("hidden");
  loadAdminPanel();
  stopNginxSSE();
  stopLogsSSE();
  return;
  state.view = "admin";
  el("tab-admin").classList.add("active");
  el("tab-logs").classList.remove("active");
  el("tab-analytics").classList.remove("active");
  el("tab-nginx").classList.remove("active");
  el("tab-patterns")?.classList.remove("active");
  el("admin-section").classList.remove("hidden");
  el("logs-view-wrapper").classList.add("hidden");
  el("analytics-section").classList.add("hidden");
  el("nginx-view-wrapper").classList.add("hidden");
  el("patterns-section")?.classList.add("hidden");
  loadAdminPanel();
  stopNginxSSE();
  stopLogsSSE();
});

function activateNetworkView() {
  state.view = "nginx";
  setActiveTab("tab-nginx");
  hideMainViews();
  el("nginx-view-wrapper")?.classList.remove("hidden");
  hideAnalyticsDetail();
  loadNginxAnalytics();
  startNginxSSE();
  loadNginxLogs();
  stopLogsSSE();
}

function openPlatformNetwork(mode = "live") {
  if (el("tab-nginx")?.classList.contains("hidden")) return;
  resetNginxFilters(false);
  const hoursSelect = el("nginx-hours-select");
  if (hoursSelect) {
    hoursSelect.value = mode === "live" ? "0.5" : "24";
    nginxAnalyticsHours = parseFloat(hoursSelect.value || "24");
  }
  if (mode === "errors" && el("nginx-status-select")) el("nginx-status-select").value = "500";
  if (mode === "4xx" && el("nginx-status-select")) el("nginx-status-select").value = "404";
  activateNetworkView();
  if (mode === "paths") {
    setTimeout(() => el("nginx-top-paths-body")?.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
  }
}

if (isFeatureEnabled("gateway")) {
  el("tab-nginx")?.addEventListener("click", activateNetworkView);
}

if (isFeatureEnabled("patterns")) {
  el("tab-patterns")?.addEventListener("click", () => {
    state.view = "patterns";
    setActiveTab("tab-patterns");
    hideMainViews();
    el("patterns-section")?.classList.remove("hidden");
    hideAnalyticsDetail();
    stopLogsSSE();
    stopNginxSSE();
    loadPatterns();
  });
}

document.querySelectorAll(".platform-action").forEach(btn => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.platformAction;
    if (!action || action === "unavailable") return;
    if (action === "logs") {
      openPlatformServiceLogs();
      return;
    }
    if (action === "all-logs") {
      openAllLogsFromPlatform();
      return;
    }
    if (action === "nginx" && !el("tab-nginx")?.classList.contains("hidden")) {
      activateNetworkView();
      return;
    }
    if (action === "metric-live") {
      openPlatformNetwork("live");
      return;
    }
    if (action === "metric-errors") {
      openPlatformNetwork("errors");
      return;
    }
    if (action === "metric-slow") {
      if (!el("tab-nginx")?.classList.contains("hidden")) {
        activateNetworkView();
        setTimeout(() => el("nginx-top-paths-body")?.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
      }
      return;
    }
    if (action === "network-live") {
      openPlatformNetwork("live");
      return;
    }
    if (action === "network-errors") {
      openPlatformNetwork("errors");
      return;
    }
    if (action === "network-paths") {
      openPlatformNetwork("paths");
      return;
    }
    if (action === "db-clickhouse") {
      focusPlatformDatabase("clickhouse");
      return;
    }
    if (action === "db-postgres") {
      focusPlatformDatabase("postgres");
      return;
    }
    if (action === "db-redis") {
      focusPlatformDatabase("redis");
      return;
    }
    if (action === "admin" && !el("tab-admin")?.classList.contains("hidden")) {
      el("tab-admin")?.click();
      return;
    }
  });
});


document.querySelectorAll(".platform-metric-card").forEach(card => {
  card.addEventListener("click", () => {
    const metric = card.dataset.platformMetric;
    if (metric === "errors") {
      openPlatformNetwork("errors");
      return;
    }
    if (metric === "slow") {
      openPlatformNetwork("paths");
      return;
    }
    openPlatformNetwork("live");
  });
});

//  Log Pattern Clustering (Phase 14) 

async function loadPatterns() {
  const minutes = parseInt(el("patterns-minutes")?.value || "60", 10);
  const container = state.stackNames.length === 1 ? state.stackNames[0] : "";
  const statusEl = el("patterns-status");
  const tbody = el("patterns-body");
  if (statusEl) statusEl.textContent = "Loading...";
  tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Loading...</td></tr>`;
  try {
    const params = new URLSearchParams({ minutes, ...(container ? { container } : {}) });
    const data = await fetch(`/logstore/api/logs/patterns?${params}`).then(r => r.json());
    const rows = data.rows || [];
    if (statusEl) statusEl.textContent = `${rows.length} pattern${rows.length !== 1 ? "s" : ""} - last ${minutes} min${container ? ` - ${container}` : ""}`;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No patterns found.</td></tr>`;
      return;
    }
    const badgeMap = { error: "badge-error", warn: "badge-warn", warning: "badge-warn", info: "badge-info", debug: "badge-debug" };
    tbody.innerHTML = rows.map(([pattern, freq, first, last, sev]) => {
      const l = (sev || "").toLowerCase();
      const cls = l === "error" ? "row-error" : (l === "warn" || l === "warning") ? "row-warn" : "";
      const badgeCls = badgeMap[l] || "badge-other";
      const displayPattern = escHtml(pattern).replace(/\?+/g, '<span style="color:var(--text-muted);opacity:0.5">?</span>');
      return `<tr class="${cls} pattern-row" data-pattern="${escHtml(pattern)}" style="cursor:pointer;" title="Click to filter logs by this pattern">
        <td style="text-align:center;"><span style="font-weight:700;font-family:var(--mono);color:var(--accent);font-size:13px;">${escHtml(String(freq))}</span></td>
        <td><span class="badge ${badgeCls}">${escHtml(sev || "--")}</span></td>
        <td class="td-msg pattern-cell" style="max-width:600px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(pattern)}">${displayPattern}</td>
        <td class="td-ts">${formatTs(first)}</td>
        <td class="td-ts">${formatTs(last)}</td>
      </tr>`;
    }).join("");
    tbody.querySelectorAll(".pattern-row").forEach(row => {
      row.addEventListener("click", () => {
        // Extract literal (non-?) tokens that contain at least one letter
        const tokens = row.dataset.pattern
          .split(/[\s?]+/)
          .filter(t => /[a-zA-Z]/.test(t) && t.length >= 2);
        const raw = tokens.slice(0, 4).join(" ").trim();
        const searchEl = el("search-input");
        if (searchEl) searchEl.value = raw;
        state.search = raw;
        state.page = 0;
        el("tab-logs").click();
      });
    });
  } catch (e) {
    if (statusEl) statusEl.textContent = "Error: " + e.message;
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">Failed to load patterns.</td></tr>`;
  }
}

//  Tooltip helpers 
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

//  New Stack button 
el("btn-new-stack").addEventListener("click", () => {
  const name = prompt("Enter new Stack name:");
  if (name?.trim()) {
    const s = STORAGE.getStacks(); if (!s[name]) s[name] = []; STORAGE.saveStacks(s); renderSidebar();
  }
});

//  Backup Poll (Phase 15) 
function startBackupPoll() {
  const backupBtn = el("btn-trigger-backup");
  const clearBtn = el("btn-clear-db");
  const banner = el("backup-status-banner");
  const started = Date.now();

  function elapsed() {
    const s = Math.floor((Date.now() - started) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  if (backupBtn) { backupBtn.disabled = true; backupBtn.textContent = "Backup running..."; }
  if (clearBtn) { clearBtn.disabled = true; clearBtn.textContent = "Backup in progress - wait"; }
  if (banner) { banner.className = "backup-banner in-progress"; banner.textContent = "Backup in progress..."; }

  const poll = setInterval(async () => {
    try {
      const r = await fetch(`${API_BASE}/admin/backup/status`, { credentials: "include" }).then(x => x.json());
      if (r.running) {
        if (banner) banner.textContent = `Backup running... (${elapsed()})`;
        return;
      }
      clearInterval(poll);
      if (backupBtn) { backupBtn.disabled = false; backupBtn.textContent = "Start Backup"; }
      if (clearBtn) { clearBtn.disabled = false; clearBtn.textContent = "Clear DB"; }
      const ok = r.last_run?.status === "success";
      if (banner) {
        banner.className = ok ? "backup-banner success" : "backup-banner error";
        banner.textContent = ok
          ? `Backup complete - cleared ${(r.last_run.cleared_rows || 0).toLocaleString()} rows`
          : `Backup failed: ${r.last_run?.error_message || "unknown error"}`;
        if (ok) setTimeout(() => { banner.className = "backup-banner hidden"; }, 8000);
        loadBackupHistory();
      }
    } catch { /* network blip  keep polling */ }
  }, 3000);
}

async function refreshBackupState() {
  try {
    const r = await fetch(`${API_BASE}/admin/backup/status`, { credentials: "include" }).then(x => x.json());
    if (r.running) {
      const clearBtn = el("btn-clear-db");
      const backupBtn = el("btn-trigger-backup");
      if (clearBtn) { clearBtn.disabled = true; clearBtn.textContent = "Backup in progress - wait"; }
      if (backupBtn) { backupBtn.disabled = true; backupBtn.textContent = "Backup running..."; }
      startBackupPoll();
    }
  } catch { /* ignore */ }
  loadBackupHistory();
}

async function loadBackupHistory() {
  const tbody = el("backup-history-body");
  if (!tbody) return;
  try {
    const rows = await fetch(`${API_BASE}/admin/backup/history`, { credentials: "include" }).then(r => r.json());
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--text-muted);">No backups yet</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r, i) => {
      const ok = r.status === "success";
      const running = r.status === "running";
      const statusColor = ok ? "var(--accent)" : running ? "var(--warn)" : "var(--error)";
      const statusIcon = ok ? "OK" : running ? "RUN" : "ERR";
      const isNew = state.lastBackupId && r.id > state.lastBackupId;
      const rowClass = isNew ? "backup-row-new" : "";
      if (r.id > (state.lastBackupId || 0)) state.lastBackupId = r.id;
      return `<tr class="${rowClass}" style="border-bottom:1px solid var(--border);">
        <td style="padding:4px 6px; text-align:right; color:var(--text-muted);">${r.id}</td>
        <td style="padding:4px 6px; color:var(--text-dim);">${r.started_at ? formatTs(r.started_at) : "--"}</td>
        <td style="padding:4px 6px; color:var(--text-muted);">${r.finished_at ? formatTs(r.finished_at) : "--"}</td>
        <td style="padding:4px 6px; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(r.databases)}">${escHtml(r.databases)}</td>
        <td style="padding:4px 6px;">
          <span style="font-size:10px; font-weight:600; color:${statusColor};">${statusIcon} ${escHtml(r.status)}</span>
          ${r.error_message ? `<div style="font-size:9px; color:var(--error); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(r.error_message)}</div>` : ""}
          ${ok && r.cleared_rows ? `<div style="font-size:9px; color:var(--text-muted);">${Number(r.cleared_rows).toLocaleString()} rows</div>` : ""}
        </td>
      </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="padding:12px; text-align:center; color:var(--error);">Failed to load</td></tr>`;
  }
}

//  Init 
function init() {
  try {
    console.log("[INIT] Starting dashboard initialization...");

    // Docs link  resolve against current origin so localhost and prod both work
    const docsLink = el("docs-link");
    if (docsLink) docsLink.href = window.location.origin + "/logstore/docs/";

    // Docs FAB close/reopen
    const docsFab = el("docs-fab-wrapper");
    const docsMini = el("btn-docs-mini");
    if (localStorage.getItem("docsFabClosed") === "1") {
      docsFab?.classList.add("hidden");
      docsMini?.classList.remove("hidden");
    }
    el("btn-docs-close")?.addEventListener("click", () => {
      docsFab?.classList.add("hidden");
      docsMini?.classList.remove("hidden");
      localStorage.setItem("docsFabClosed", "1");
    });
    docsMini?.addEventListener("click", () => {
      docsFab?.classList.remove("hidden");
      docsMini?.classList.add("hidden");
      localStorage.setItem("docsFabClosed", "0");
    });

    // Theme
    const savedTheme = localStorage.getItem("theme") || "dark";
    document.documentElement.setAttribute("data-theme", savedTheme);
    const btnTheme = el("btn-theme");
    if (btnTheme) {
      btnTheme.textContent = "Theme";
      btnTheme.addEventListener("click", () => {
        const isDark = document.documentElement.getAttribute("data-theme") === "dark";
        const next = isDark ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("theme", next);
        btnTheme.textContent = "Theme";
      });
    }
    // Populate hour and minute select options
    const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
    const mins = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

    const hourOpts = `<option value="">HH</option>` + hours.map(v => `<option value="${v}">${v}</option>`).join("");
    const minOpts = `<option value="">MM</option>` + mins.map(v => `<option value="${v}">${v}</option>`).join("");

    ["range-from-hour", "range-to-hour"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = hourOpts;
    });
    ["range-from-minute", "range-to-minute"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = minOpts;
    });

    // Nginx time selects
    ["nginx-range-from-hour", "nginx-range-to-hour"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = hourOpts;
    });
    ["nginx-range-from-minute", "nginx-range-to-minute"].forEach(id => {
      const target = el(id);
      if (target) target.innerHTML = minOpts;
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

    // Pagination
    el("btn-prev").addEventListener("click", () => { stopLogsSSE(); state.page--; startLogsSSE(); loadLogs(); });
    el("btn-next").addEventListener("click", () => { stopLogsSSE(); state.page++; loadLogs(); });

    // Gateway/Nginx legacy module controls.
    if (isFeatureEnabled("gateway")) {
      el("btn-nginx-apply")?.addEventListener("click", () => { stopNginxSSE(); nginxPage = 0; startNginxSSE(); loadNginxLogs(); });
      el("btn-nginx-reset")?.addEventListener("click", () => { stopNginxSSE(); resetNginxFilters(); startNginxSSE(); });
      el("btn-nginx-refresh")?.addEventListener("click", () => { stopNginxSSE(); startNginxSSE(); loadNginxLogs(); });
      el("btn-nginx-prev")?.addEventListener("click", () => { stopNginxSSE(); nginxPage--; loadNginxLogs(); });
      el("btn-nginx-next")?.addEventListener("click", () => { stopNginxSSE(); nginxPage++; loadNginxLogs(); });
    }
    // Analytics controls
    el("analytics-hours-select")?.addEventListener("change", () => { 
      hideAnalyticsDetail(); 
      state.analyticsHourFilter = null;
      state.analyticsLevelFilter = null;
      if (state.view === "analytics") loadAnalytics(); 
    });
    el("btn-analytics-refresh")?.addEventListener("click", () => { 
      state.analyticsHourFilter = null; 
      state.analyticsLevelFilter = null; 
      state.analyticsPendingViewLogs = null;
      hideAnalyticsDetail();
      loadAnalytics(); 
    });
    el("btn-analytics-detail-close")?.addEventListener("click", hideAnalyticsDetail);
    el("btn-view-full-logs")?.addEventListener("click", () => {
      const fromDate = state.analyticsHourFilter?.fromDate || null;
      const toDate = state.analyticsHourFilter?.toDate || null;
      const level = state.analyticsLevelFilter || "";
      state.analyticsPendingViewLogs = { fromDate, toDate, level };
      _drillToLogs({ 
        fromDate: fromDate, 
        toDate: toDate, 
        level: level 
      });
    });
    if (isFeatureEnabled("gateway")) {
      el("nginx-hours-select")?.addEventListener("change", e => { nginxAnalyticsHours = parseFloat(e.target.value); loadNginxAnalytics(); });
      el("btn-nginx-analytics-refresh")?.addEventListener("click", loadNginxAnalytics);
    }

    // Refresh
    el("btn-refresh").addEventListener("click", refresh);
    if (isFeatureEnabled("patterns")) {
      el("btn-patterns-load")?.addEventListener("click", loadPatterns);
    }

    // Clear DB (admin only)
    el("btn-clear-db").addEventListener("click", openClearModal);
    el("btn-clear-db-admin")?.addEventListener("click", openClearModal);
    el("btn-modal-cancel").addEventListener("click", closeClearModal);
    el("btn-modal-confirm").addEventListener("click", executeClear);
    document.querySelectorAll('input[name="clear-range"]').forEach(r => r.addEventListener("change", updateModalPreview));
    el("modal-overlay").addEventListener("click", e => { if (e.target === el("modal-overlay")) closeClearModal(); });

    el("btn-alert-rule-create")?.addEventListener("click", createAlertRuleFromForm);

    // Backup history refresh
    el("btn-backup-history-refresh")?.addEventListener("click", loadBackupHistory);

    // Backup button
    const backupBtn = el("btn-trigger-backup");
    if (backupBtn) {
      backupBtn.addEventListener("click", async () => {
        if (!confirm("Start backup now?\n(PostgreSQL + ClickHouse)")) return;
        try {

          const res = await fetch(`${API_BASE}/admin/backup/trigger`, { method: "POST", credentials: "include" });
          if (res.status === 409) { alert("Backup already running - check status banner."); return; }
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.detail || res.statusText);
          }
        } catch (err) {
          const banner = el("backup-status-banner");
          if (banner) { banner.className = "backup-banner error"; banner.textContent = "Failed to start: " + err.message; }
          return;
        }
        startBackupPoll();
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
    if (btn) btn.textContent = "Loading...";
    await Promise.all([
      loadContainerAliases(),
      loadOverview(),
      loadMetrics(),
      loadContainerList(),
      state.view === 'logs' ? loadLogs() : Promise.resolve(),
      state.view === 'platform' ? Promise.all([loadPlatformHealth(), loadPlatformRuntime(), loadPlatformUptime(), loadPlatformCorrelation(), loadPlatformIncidentTimeline(), loadPlatformWorkloadDatabases()]) : Promise.resolve()
    ]);
    if (btn) btn.textContent = "Refresh";
  } catch (e) {
    console.error("[REFRESH] failed", e);
    const btn = el("btn-refresh");
    if (btn) btn.textContent = "Retry";
  }
}

document.addEventListener("DOMContentLoaded", init);

