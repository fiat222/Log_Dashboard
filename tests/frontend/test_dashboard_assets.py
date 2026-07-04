from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "apps" / "web"


def test_dashboard_loads_frontend_modules_before_app_script():
    html = (DASHBOARD / "index.html").read_text(encoding="utf-8")

    api_script = '<script src="src/api.js"></script>'
    overview_script = '<script src="src/overview.js"></script>'
    logs_script = '<script src="src/logs.js"></script>'
    app_script = '<script src="app.js"></script>'

    assert api_script in html
    assert overview_script in html
    assert logs_script in html
    assert html.index(api_script) < html.index(app_script)
    assert html.index(overview_script) < html.index(app_script)
    assert html.index(logs_script) < html.index(app_script)


def test_overview_module_exposes_dashboard_namespace():
    source = (DASHBOARD / "src" / "overview.js").read_text(encoding="utf-8")

    assert "window.LogDashOverview" in source
    assert "loadOverview" in source
    assert "renderOverview" in source


def test_api_module_exposes_dashboard_namespace():
    source = (DASHBOARD / "src" / "api.js").read_text(encoding="utf-8")

    assert "window.LogDashApi" in source
    assert "apiGet" in source


def test_logs_module_exposes_dashboard_namespace():
    source = (DASHBOARD / "src" / "logs.js").read_text(encoding="utf-8")

    assert "window.LogDashLogs" in source
    assert "renderLogRowHtml" in source
    assert "trimTableRows" in source


def test_phase5_keeps_legacy_workflows_reachable():
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    assert "gateway: true" in source
    assert "patterns: true" in source
    assert "externalTools: false" in source
    assert "if (isFeatureEnabled(\"gateway\"))" in source
    assert "if (isFeatureEnabled(\"patterns\"))" in source


def test_logs_view_has_explicit_dom_performance_caps():
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    assert "const MAX_LOG_ROWS_IN_DOM = PAGE_SIZE;" in source
    assert "const LOG_MESSAGE_PREVIEW_LIMIT = 1000;" in source
    assert "function trimTableRows(" in source
    assert "trimTableRows(tbody, MAX_LOG_ROWS_IN_DOM);" in source


def test_legacy_inline_log_renderer_is_commented_out():
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    assert "Legacy inline renderer moved to apps/web/src/logs.js" in source
    assert "bindLogRowActions(tbody);\n  return;" not in source


def test_platform_shell_is_wired_to_navigation():
    html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    assert "tab-platform" in html
    assert "platform-section" in html
    assert "platform-cockpit" in html
    assert "platform-cockpit-title" in html
    assert "platform-open-service-logs" in html
    assert "data-platform-action" in html
    assert "function activatePlatformView()" in source
    assert "function renderPlatformCockpit()" in source
    assert "renderPlatformCockpit();" in source
    assert "platform-section" in source
    assert 'document.querySelectorAll(".platform-action")' in source


def test_phase6_health_cockpit_is_wired_to_platform_view():
    html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")
    css = (DASHBOARD / "style.css").read_text(encoding="utf-8")

    assert "platform-health-grid" in html
    assert "platform-health-backend" in html
    assert "platform-health-clickhouse" in html
    assert "platform-health-postgres" in html
    assert "platform-health-redis" in html
    assert "platform-health-gateway" in html
    assert "platform-health-refresh" in html
    assert "function loadPlatformHealth()" in source
    assert "function renderPlatformHealth(" in source
    assert "/health" in source
    assert "platform-health-card" in css
    assert "platform-health-card.is-fail" in css


def test_phase6_runtime_panel_is_wired_to_platform_view():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'platform-runtime-panel' in html
    assert 'platform-runtime-grid' in html
    assert 'platform-runtime-total' in html
    assert 'platform-runtime-running' in html
    assert 'platform-runtime-unhealthy' in html
    assert 'platform-runtime-list' in html
    assert 'platform-runtime-refresh' in html
    assert 'function loadPlatformRuntime()' in source
    assert 'function renderPlatformRuntime(' in source
    assert '/platform/runtime' in source
    assert 'platform-runtime-panel' in css
    assert 'platform-runtime-row' in css
    assert 'platform-runtime-diagnostics' in css


def test_network_tab_reuses_nginx_workflow_copy():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')

    assert 'tab-nginx' in html
    assert 'Network' in html
    assert 'Network Analytics' in html
    assert 'Network log explorer' in html
    assert 'Client IPs' in html
    assert 'loadNginxAnalytics()' in source
    assert 'nginx-view-wrapper' in source


def test_platform_network_panel_exposes_scoped_actions():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')

    assert 'platform-network-panel' in html
    assert 'platform-network-open-live' in html
    assert 'platform-network-open-errors' in html
    assert 'platform-network-open-paths' in html
    assert 'function openPlatformNetwork(' in source
    assert 'network-errors' in source
    assert 'nginx-status-select' in source
    assert 'nginx-top-paths-body' in source


def test_phase6_uptime_and_database_panels_are_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'platform-database-panel' in html
    assert 'platform-db-clickhouse' in html
    assert 'platform-db-postgres' in html
    assert 'platform-db-redis' in html
    assert 'platform-uptime-panel' in html
    assert 'platform-uptime-grid' in html
    assert 'platform-uptime-dashboard' in html
    assert 'platform-uptime-backend' in html
    assert 'platform-uptime-clickhouse-ui' in html
    assert 'platform-uptime-refresh' in html
    assert 'function loadPlatformUptime()' in source
    assert 'function renderPlatformUptime(' in source
    assert 'function focusPlatformDatabase(' in source
    assert '/platform/uptime' in source
    assert 'platform-uptime-card' in css


def test_visible_web_ui_uses_generic_identity_copy():
    dashboard_html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    login_html = (DASHBOARD / 'login' / 'index.html').read_text(encoding='utf-8')
    visible_html = dashboard_html + '\n' + login_html

    assert 'SSO login is intentionally disabled for now' in login_html
    assert 'Login with SSO' not in dashboard_html
    assert 'Sign in' in login_html
    assert 'PSU' not in visible_html
    assert 'EILA' not in visible_html
    assert 'Prince of Songkla' not in visible_html
    assert 'Passport' not in visible_html
    assert 'monitor-eila' not in dashboard_html


def test_monitoring_overview_layer_status_is_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'src' / 'overview.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'Monitoring overview' in html
    assert 'overview-layer-signals' in html
    assert 'Signals to investigate' in html
    assert 'Workload DB' in html
    assert 'Collector needed' in html
    assert 'function loadOverviewSignals()' in source
    assert '/platform/runtime' in source
    assert '/platform/uptime' in source
    assert '/admin/nginx-logs/overview?hours=24' in source
    assert 'function renderOverviewSignals(' in source
    assert 'overview-layer-grid' in css
    assert 'overview-layer-card' in css


def test_phase6_visible_metrics_layer_is_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'Gateway metrics' in html
    assert 'Network gateway metrics' in html
    assert 'platform-metrics-panel' in html
    assert 'platform-metric-request-rate' in html
    assert 'platform-metric-error-rate' in html
    assert 'platform-metric-p95' in html
    assert 'platform-metric-5xx' in html
    assert 'platform-metrics-paths' in html
    assert 'function loadPlatformMetrics()' in source
    assert '/admin/nginx-logs/overview' in source
    assert '/admin/nginx-logs/top-paths' in source
    assert 'openNginxTraceModal({ mode: "path"' in source
    assert 'document.querySelectorAll(".platform-metric-card")' in source
    assert 'if (!action || action === "unavailable") return;' in source
    assert "data-platform-action='unavailable' disabled" in html
    assert 'platform-metrics-grid' in css
    assert 'platform-metric-path' in css


def test_platform_gateway_correlation_panel_is_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'platform-correlation-panel' in html
    assert 'platform-correlation-5xx' in html
    assert 'platform-correlation-app-errors' in html
    assert '/platform/correlation/gateway?hours=1' in source
    assert 'function renderPlatformCorrelation(' in source
    assert 'function runPlatformCorrelationAction(' in source
    assert 'loadPlatformCorrelation();' in source
    assert '.platform-correlation-summary' in css


def test_platform_workload_database_panel_is_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'platform-workload-db-panel' in html
    assert 'Application database monitoring' in html
    assert '/platform/workload-databases' in source
    assert 'function renderPlatformWorkloadDatabases(' in source
    assert 'loadPlatformWorkloadDatabases();' in source
    assert 'platform-workload-db-refresh' in source
    assert '.platform-workload-db-list' in css



def test_admin_alert_rules_panel_is_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'Custom alert rules' in html
    assert 'alert-rule-name' in html
    assert 'alert-rule-condition' in html
    assert 'btn-alert-rule-create' in html
    assert 'alert-rules-list' in html
    assert 'alert-history-list' in html
    assert '/admin/alert-rules' in source
    assert 'function loadAlertRules()' in source
    assert 'function renderAlertRules()' in source
    assert 'function renderAlertHistory()' in source
    assert 'function createAlertRuleFromForm()' in source
    assert 'function testAlertRule(' in source
    assert 'value="custom_alert"' in source
    assert 'admin-alert-rule' in css
    assert 'admin-alert-history-item' in css



def test_platform_incident_timeline_bundle_is_wired():
    html = (DASHBOARD / 'index.html').read_text(encoding='utf-8')
    source = (DASHBOARD / 'app.js').read_text(encoding='utf-8')
    css = (DASHBOARD / 'style.css').read_text(encoding='utf-8')

    assert 'platform-incident-panel' in html
    assert 'Incident evidence timeline' in html
    assert 'platform-incident-refresh' in html
    assert 'platform-incident-copy' in html
    assert 'platform-incident-timeline' in html
    assert 'platform-incident-boundary' in html
    assert '/platform/incidents/timeline' in source
    assert 'function loadPlatformIncidentTimeline()' in source
    assert 'function renderPlatformIncidentTimeline(' in source
    assert 'function copyPlatformEvidenceBundle()' in source
    assert 'loadPlatformIncidentTimeline();' in source
    assert 'platform-incident-timeline' in css
    assert 'platform-incident-note' in css
