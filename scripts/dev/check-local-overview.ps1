param(
    [string]$BaseUrl = "http://localhost:8801/logstore"
)

$ErrorActionPreference = "Stop"

$envPath = Join-Path (Get-Location) ".env"
$envMap = @{}
Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $key, $value = $line.Split("=", 2)
        $envMap[$key.Trim()] = $value.Trim()
    }
}

$username = $envMap["SUPER_ADMIN_USERNAME"]
$password = $envMap["SUPER_ADMIN_PASSWORD"]

if (-not $username -or -not $password) {
    throw "SUPER_ADMIN_USERNAME or SUPER_ADMIN_PASSWORD is missing in .env"
}

$body = @{
    username = $username
    password = $password
} | ConvertTo-Json -Compress

$cookieFile = Join-Path $env:TEMP "logs-dashboard-local-cookie.txt"
$bodyFile = Join-Path $env:TEMP "logs-dashboard-local-login-body.json"
if (Test-Path $cookieFile) {
    Remove-Item $cookieFile -Force
}
Set-Content -Path $bodyFile -Value $body -Encoding UTF8

$loginOutputFile = Join-Path $env:TEMP "logs-dashboard-local-login.json"
$loginStatus = & curl.exe -sS -o $loginOutputFile -w "%{http_code}" `
    -c $cookieFile `
    -H "Content-Type: application/json" `
    --data-binary "@$bodyFile" `
    "$BaseUrl/api/auth/login"

Write-Output "login=$loginStatus"

if ($loginStatus -ne "200") {
    if (Test-Path $loginOutputFile) {
        Get-Content $loginOutputFile
    }
    throw "Login failed with HTTP $loginStatus"
}

& curl.exe -sS `
    -b $cookieFile `
    "$BaseUrl/api/overview"
