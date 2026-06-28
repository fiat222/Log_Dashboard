from backend.telemetry import should_enable_otel


def test_should_disable_otel_when_standard_env_is_true():
    assert should_enable_otel({"OTEL_SDK_DISABLED": "true"}) is False
    assert should_enable_otel({"OTEL_SDK_DISABLED": "1"}) is False
    assert should_enable_otel({"OTEL_SDK_DISABLED": "yes"}) is False


def test_should_enable_otel_when_not_disabled():
    assert should_enable_otel({}) is True
    assert should_enable_otel({"OTEL_SDK_DISABLED": "false"}) is True
