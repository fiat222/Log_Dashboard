(function () {
  "use strict";

  let deps = {};

  function init(nextDeps = {}) {
    deps = { ...deps, ...nextDeps };
  }

  function fallbackOverview() {
    return {
      totals: { hosts: 0, services: 0, active_instances: 0, instances: 0, errors: 0 },
      health: { status: "quiet", services_with_errors: 0, inactive_services: 0 },
      top_error_services: [],
      recent_services: [],
      services: [],
    };
  }

  async function loadOverview() {
    const shell = deps.el?.("overview-section");
    if (!shell) return;
    try {
      const res = await window.LogDashApi.apiGet("/overview?hours=24");
      if (res.status === 401) {
        window.location.href = "/logstore/login";
        return;
      }
      if (!res.ok) throw new Error(`Overview request failed: ${res.status}`);
      deps.state.overview = await res.json();
      deps.state.overviewSignals = await loadOverviewSignals();
      renderOverview();
    } catch (e) {
      console.error("Overview error:", e);
      deps.state.overview = fallbackOverview();
      deps.state.overviewSignals = defaultOverviewSignals();
      renderOverview();
    }
  }

  function defaultOverviewSignals() {
    return [
      { id: "host", label: "Host", status: "missing", value: "Collector needed", detail: "Enable node_exporter or Vector host metrics on edge hosts." },
      { id: "container", label: "Container", status: "missing", value: "Runtime loading", detail: "Waiting for Docker runtime or cAdvisor data." },
      { id: "gateway", label: "Gateway", status: "missing", value: "Network loading", detail: "Waiting for gateway logs or metrics." },
      { id: "workload-db", label: "Workload DB", status: "missing", value: "Not configured", detail: "Add DB profiles for monitored application databases." },
      { id: "pipeline", label: "Pipeline", status: "missing", value: "Health loading", detail: "Checking ClickHouse, OTel Gateway, and API health." },
      { id: "alerts", label: "Alerts", status: "missing", value: "Rules pending", detail: "Custom alert rules are planned for Phase 6.5." },
    ];
  }

  async function getJson(path) {
    try {
      const res = await window.LogDashApi.apiGet(path);
      if (res.status === 401) {
        window.location.href = "/logstore/login";
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (_e) {
      return null;
    }
  }

  async function loadOverviewSignals() {
    const [health, runtime, uptime, gateway] = await Promise.all([
      getJson("/platform/health"),
      getJson("/platform/runtime"),
      getJson("/platform/uptime"),
      getJson("/admin/nginx-logs/overview?hours=24"),
    ]);

    const fmt = deps.fmt || ((value) => String(value));
    const runtimeTotals = runtime?.totals || {};
    const runtimeTotal = Number(runtimeTotals.total || 0);
    const runtimeRunning = Number(runtimeTotals.running || 0);
    const runtimeUnhealthy = Number(runtimeTotals.unhealthy || 0);
    const gatewayTotal = Number(gateway?.total_requests || 0);
    const gatewayErrorRate = Number(gateway?.error_rate || 0);
    const gatewayP95 = Number(gateway?.p95_response_time || 0);
    const healthServices = Array.isArray(health?.services) ? health.services : [];
    const healthFailures = healthServices.filter(item => item.status !== "ok").length;
    const uptimeServices = Array.isArray(uptime?.services) ? uptime.services : [];
    const uptimeFailures = uptimeServices.filter(item => item.status !== "ok").length;
    const unreadAlerts = Number(deps.state?.unreadCount || 0);

    return [
      { id: "host", label: "Host", status: "missing", value: "Collector needed", detail: "Enable node_exporter or Vector host metrics on edge hosts." },
      {
        id: "container",
        label: "Container",
        status: runtime ? (runtime.status === "unavailable" ? "missing" : runtimeUnhealthy > 0 ? "danger" : "ok") : "missing",
        value: runtime ? fmt(runtimeRunning) + "/" + fmt(runtimeTotal) + " running" : "Runtime missing",
        detail: runtimeUnhealthy > 0 ? fmt(runtimeUnhealthy) + " unhealthy containers need inspection." : "Docker runtime fallback is available; cAdvisor metrics are a later slice.",
      },
      {
        id: "gateway",
        label: "Gateway",
        status: gateway ? (gatewayErrorRate >= 5 || gatewayP95 >= 1 ? "danger" : gatewayErrorRate >= 1 || gatewayP95 >= 0.3 ? "warn" : "ok") : "missing",
        value: gateway ? (gatewayTotal ? fmt(gatewayTotal) + " req" : "No traffic") : "No access",
        detail: gateway ? gatewayErrorRate.toFixed(1) + "% errors, " + gatewayP95.toFixed(3) + "s p95 in 24h." : "Gateway metrics require network log access.",
      },
      { id: "workload-db", label: "Workload DB", status: "missing", value: "Not configured", detail: "Platform DB health exists; monitored app DB profiles come in Phase 6.4." },
      {
        id: "pipeline",
        label: "Pipeline",
        status: health ? (health.status === "ok" ? "ok" : healthFailures ? "warn" : "missing") : "missing",
        value: health ? (health.status === "ok" ? "Healthy" : "Degraded") : "Health missing",
        detail: health ? fmt(healthServices.length - healthFailures) + "/" + fmt(healthServices.length) + " central checks healthy." : "Central health endpoint unavailable.",
      },
      {
        id: "uptime",
        label: "Uptime",
        status: uptime ? (uptime.status === "ok" ? "ok" : uptimeFailures ? "warn" : "missing") : "missing",
        value: uptime ? (uptime.status === "ok" ? "Surfaces up" : "Degraded") : "Probe missing",
        detail: uptime ? fmt(uptimeServices.length - uptimeFailures) + "/" + fmt(uptimeServices.length) + " surfaces responding." : "Uptime probe endpoint unavailable.",
      },
      {
        id: "alerts",
        label: "Alerts",
        status: unreadAlerts > 0 ? "warn" : "missing",
        value: unreadAlerts > 0 ? fmt(unreadAlerts) + " unread" : "Rules pending",
        detail: unreadAlerts > 0 ? "Review notification drawer for active findings." : "Custom alert rules and email recipients are Phase 6.5.",
      },
    ];
  }

  function renderOverview() {
    const data = deps.state?.overview || {};
    const totals = data.totals || {};
    const health = data.health || {};
    setText("ov-hosts", deps.fmt?.(totals.hosts || 0) ?? totals.hosts ?? 0);
    setText("ov-services", deps.fmt?.(totals.services || 0) ?? totals.services ?? 0);
    setText("ov-active", `${deps.fmt?.(totals.active_instances || 0) ?? 0}/${deps.fmt?.(totals.instances || 0) ?? 0}`);
    setText("ov-errors", deps.fmt?.(totals.errors || 0) ?? totals.errors ?? 0);
    setText("ov-error-count", `${deps.fmt?.(health.services_with_errors || 0) ?? 0} services`);

    const pill = deps.el?.("overview-status-pill");
    if (pill) {
      const status = health.status || "quiet";
      pill.className = `overview-status ${status}`;
      pill.textContent = status === "healthy" ? "Healthy"
        : status === "warning" ? "Needs attention"
          : "Quiet";
    }

    renderOverviewServiceList("overview-error-services", data.top_error_services || [], "errors");
    renderOverviewServiceList("overview-active-services", data.recent_services || data.services || [], "logs");
    renderOverviewSignals(deps.state?.overviewSignals || defaultOverviewSignals());
  }

  function setText(id, value) {
    const node = deps.el?.(id);
    if (node) node.textContent = value;
  }

  function renderOverviewSignals(signals) {
    const target = deps.el?.("overview-layer-signals");
    if (!target) return;
    const esc = deps.escHtml || ((value) => String(value));
    target.innerHTML = (signals || defaultOverviewSignals()).map(signal => {
      const status = ["ok", "warn", "danger", "missing"].includes(signal.status) ? signal.status : "missing";
      return '<article class="overview-layer-card is-' + status + '" data-layer="' + esc(signal.id) + '">'
        + '<span>' + esc(signal.label) + '</span>'
        + '<strong>' + esc(signal.value) + '</strong>'
        + '<p>' + esc(signal.detail) + '</p>'
        + '</article>';
    }).join("");
  }

  function renderOverviewServiceList(id, services, mode) {
    const list = deps.el?.(id);
    if (!list) return;
    if (!services.length) {
      list.innerHTML = `<div class="overview-empty">${mode === "errors" ? "No service errors in this window." : "Waiting for service logs."}</div>`;
      return;
    }
    list.innerHTML = "";
    services.slice(0, 8).forEach(service => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "overview-service-row";
      const name = service.compose_service || service.sample_container_name || "unknown-service";
      const host = service.host_id || "unknown-host";
      const project = service.compose_project || "standalone";
      const errors = Number(service.error_count || 0);
      const logs = Number(service.log_count || 0);
      row.innerHTML = `
        <span class="overview-service-dot ${errors > 0 ? "error" : ""}"></span>
        <span>
          <span class="overview-service-name">${deps.escHtml?.(name) ?? name}</span>
          <span class="overview-service-meta">${deps.escHtml?.(host) ?? host} / ${deps.escHtml?.(project) ?? project}</span>
        </span>
        <span class="overview-service-stat">${mode === "errors" ? `${deps.fmt?.(errors) ?? errors} err` : `${deps.fmt?.(logs) ?? logs} logs`}</span>
      `;
      row.addEventListener("click", () => {
        deps.activateLogsView?.();
        deps.selectService?.({
          service_key: service.service_key,
          host_id: host,
          compose_project: project,
          compose_service: name,
          instance_count: Number(service.instance_count || 0),
          active_instance_count: Number(service.active_instance_count || 0),
          error_count: errors,
          log_count: logs,
          sample_container_name: service.sample_container_name,
        });
      });
      list.appendChild(row);
    });
  }

  window.LogDashOverview = {
    init,
    loadOverview,
    renderOverview,
    renderOverviewServiceList,
  };
})();
