def should_enable_otel(env: dict[str, str]) -> bool:
    disabled = env.get("OTEL_SDK_DISABLED", "").strip().lower()
    return disabled not in {"1", "true", "yes", "on"}
