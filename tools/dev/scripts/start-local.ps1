param(
    [switch]$Build,
    [switch]$WithMockServices
)

$ErrorActionPreference = "Stop"
$env:TAG = "local"

$composeArgs = @(
    "compose",
    "-f", "docker-compose.yml",
    "-f", "docker-compose.local.yml",
    "up",
    "-d"
)

if ($Build) {
    $composeArgs += "--build"
}

& docker @composeArgs

if ($WithMockServices) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File "tools/dev/scripts/start-mock-services.ps1"
}

Write-Output ""
Write-Output "Local dashboard:"
Write-Output "  http://localhost:8801/logstore/"
Write-Output ""
Write-Output "Login:"
Write-Output "  http://localhost:8801/logstore/login"
Write-Output ""
Write-Output "Verify:"
Write-Output "  powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev/scripts/check-local-overview.ps1"
