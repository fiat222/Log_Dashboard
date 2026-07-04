# deploy-registry.ps1
# Builds custom images + mirrors third-party images → GitLab Registry.
# Server can only pull from GitLab, so ALL images must live there.
#
# Tag discipline (restricted):
#   - default            → tag :otel-test   (test/dev builds)
#   - -Stable            → tag :latest      (hotfix bypass; normally use promote.ps1)
#   - any other TAG      → rejected
#
# Usage:
#   .\deploy-registry.ps1                   # builds :otel-test
#   .\deploy-registry.ps1 -Stable           # builds :latest (emergency hotfix only)
#   .\deploy-registry.ps1 otel-test         # explicit, same as default

param(
    [string]$TAG = "otel-test",
    [switch]$Stable
)

if ($Stable) { $TAG = "latest" }

$allowed = @("otel-test", "latest")
if ($TAG -notin $allowed) {
    Write-Error "TAG must be one of: $($allowed -join ', '). Use -Stable for 'latest'. Got: '$TAG'"
    exit 1
}

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

Write-Host "Registry : $REGISTRY_PATH" -ForegroundColor Cyan
Write-Host "Tag      : $TAG" -ForegroundColor Cyan
if ($TAG -eq "latest") {
    Write-Host "WARNING  : building directly to :latest (bypasses promote workflow)" -ForegroundColor Yellow
}

# 3. Docker login
$REGISTRY_DOMAIN = $REGISTRY_PATH.Split('/')[0]
Write-Host "`nLogging into $REGISTRY_DOMAIN ..." -ForegroundColor Yellow
docker login $REGISTRY_DOMAIN
if ($LASTEXITCODE -ne 0) { Write-Error "Login failed"; exit 1 }

# =============================================================================
# 4. Mirror third-party images (pull from Docker Hub → push to GitLab)
#    Only needed once per image tag — skip if already in registry.
# =============================================================================
$thirdParty = @(
    @{ src = "postgres:16-alpine";                            dst = "postgres:16-alpine" },
    @{ src = "redis:7.2";                                     dst = "redis:7.2" },
    @{ src = "clickhouse/clickhouse-server:24.3-alpine";      dst = "clickhouse-server:24.3-alpine" },
    @{ src = "otel/opentelemetry-collector-contrib:0.100.0";  dst = "otel-collector-contrib:0.100.0" },
    @{ src = "timberio/vector:0.54.0-alpine";                dst = "vector:0.54.0-alpine" }
)

Write-Host "`n=== Mirroring third-party images ===" -ForegroundColor Cyan
foreach ($img in $thirdParty) {
    $target = "$REGISTRY_PATH/$($img.dst)"
    Write-Host "  $($img.src) → $target" -ForegroundColor Gray

    docker pull $img.src
    if ($LASTEXITCODE -ne 0) { Write-Error "Pull failed: $($img.src)"; exit 1 }

    docker tag $img.src $target
    docker push $target
    if ($LASTEXITCODE -ne 0) { Write-Error "Push failed: $target"; exit 1 }
}

# =============================================================================
# 5. Build + push custom services (single tag = $TAG)
# =============================================================================
$services = @(
    @{ name = "backend";   context = "apps/api"; dockerfile = "" },
    @{ name = "dashboard"; context = ".";       dockerfile = "apps/web/Dockerfile" },
    @{ name = "backup";    context = "apps/backup";  dockerfile = "" }
)

Write-Host "`n=== Building custom images ===" -ForegroundColor Cyan
foreach ($svc in $services) {
    Write-Host "`n  --- $($svc.name) ---" -ForegroundColor Green
    $imageName = "$REGISTRY_PATH/$($svc.name)"

    $buildArgs = @("build", "-t", "${imageName}:${TAG}")
    if ($svc.dockerfile) { $buildArgs += @("-f", $svc.dockerfile) }
    $buildArgs += $svc.context

    & docker @buildArgs
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed: $($svc.name)"; exit 1 }

    docker push "${imageName}:${TAG}"
    if ($LASTEXITCODE -ne 0) { Write-Error "Push :$TAG failed: $($svc.name)"; exit 1 }
}

Write-Host "`nDone. TAG = $TAG" -ForegroundColor Cyan
Write-Host "On server: ./deploy.sh $TAG" -ForegroundColor Cyan
if ($TAG -eq "otel-test") {
    Write-Host "After verify: .\promote.ps1   (otel-test → latest)" -ForegroundColor Cyan
}
