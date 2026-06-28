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
      renderOverview();
    } catch (e) {
      console.error("Overview error:", e);
      deps.state.overview = fallbackOverview();
      renderOverview();
    }
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
  }

  function setText(id, value) {
    const node = deps.el?.(id);
    if (node) node.textContent = value;
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
