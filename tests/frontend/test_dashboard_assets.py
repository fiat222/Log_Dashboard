from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "dashboard"


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


def test_legacy_dashboard_features_are_feature_flagged_off():
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    assert "gateway: false" in source
    assert "patterns: false" in source
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

    assert "Legacy inline renderer moved to dashboard/src/logs.js" in source
    assert "bindLogRowActions(tbody);\n  return;" not in source


def test_platform_shell_is_wired_to_navigation():
    html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
    source = (DASHBOARD / "app.js").read_text(encoding="utf-8")

    assert "tab-platform" in html
    assert "platform-section" in html
    assert "data-platform-action" in html
    assert "function activatePlatformView()" in source
    assert "platform-section" in source
    assert 'document.querySelectorAll(".platform-action")' in source
