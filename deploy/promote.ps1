# promote.ps1
# Retag registry image (no rebuild). Promotes proven image to stable tag.
# Usage:
#   .\promote.ps1                   # otel-test → latest (default)
#   .\promote.ps1 -From otel-test -To latest

param(
    [string]$From = "otel-test",
    [string]$To   = "latest"
)

# 1. Load .env
if (Test-Path ".env") {
    Get-Content .env | Where-Object { $_ -match '=' -and $_ -notmatch '^#' } | ForEach-Object {
        $name, $value = $_.Split('=', 2)
        [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim())
    }
}

$REGISTRY_PATH = [System.Environment]::GetEnvironmentVariable("REGISTRY_IMAGE_PATH")
if (-not $REGISTRY_PATH) {
    Write-Error "REGISTRY_IMAGE_PATH not set in .env"
    exit 1
}

# 2. Validate tags
if ($From -eq $To) {
    Write-Error "From and To tags must differ. Got both = '$From'"
    exit 1
}

Write-Host "Registry : $REGISTRY_PATH" -ForegroundColor Cyan
Write-Host "From     : $From"          -ForegroundColor Cyan
Write-Host "To       : $To"            -ForegroundColor Cyan

# 3. Docker login
$REGISTRY_DOMAIN = $REGISTRY_PATH.Split('/')[0]
Write-Host "`nLogging into $REGISTRY_DOMAIN ..." -ForegroundColor Yellow
docker login $REGISTRY_DOMAIN
if ($LASTEXITCODE -ne 0) { Write-Error "Login failed"; exit 1 }

# 4. Promote each custom service (no third-party retag — versions pinned in compose)
$services = @("backend", "dashboard", "backup")

Write-Host "`n=== Promoting $From → $To ===" -ForegroundColor Cyan
foreach ($svc in $services) {
    Write-Host "`n  --- $svc ---" -ForegroundColor Green
    $src = "$REGISTRY_PATH/${svc}:${From}"
    $dst = "$REGISTRY_PATH/${svc}:${To}"

    Write-Host "  pull $src"  -ForegroundColor Gray
    docker pull $src
    if ($LASTEXITCODE -ne 0) { Write-Error "Pull failed: $src"; exit 1 }

    Write-Host "  tag  $src → $dst" -ForegroundColor Gray
    docker tag $src $dst
    if ($LASTEXITCODE -ne 0) { Write-Error "Tag failed: $svc"; exit 1 }

    Write-Host "  push $dst" -ForegroundColor Gray
    docker push $dst
    if ($LASTEXITCODE -ne 0) { Write-Error "Push failed: $dst"; exit 1 }
}

Write-Host "`nPromoted: $From → $To" -ForegroundColor Cyan
Write-Host "On server: ./deploy.sh $To" -ForegroundColor Cyan
