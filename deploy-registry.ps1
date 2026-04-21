# deploy-registry.ps1
# This script builds and pushes Docker images to the GitLab Container Registry locally.

# 1. Load variables from .env
if (Test-Path ".env") {
    Get-Content .env | Where-Object { $_ -match '=' -and $_ -notmatch '^#' } | ForEach-Object {
        $name, $value = $_.Split('=', 2)
        [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim())
    }
}

$REGISTRY_PATH = [System.Environment]::GetEnvironmentVariable("REGISTRY_IMAGE_PATH")

if (-not $REGISTRY_PATH) {
    Write-Error "REGISTRY_IMAGE_PATH not found in .env. Please set it (e.g., gitlab.psu.ac.th:5050/6610110116/log_dashboard)"
    exit 1
}

Write-Host "--- Using Registry Path: $REGISTRY_PATH ---" -ForegroundColor Cyan

# 2. Check if Docker is running
docker info >$null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker is not running. Please start Docker Desktop and try again."
    exit 1
}

# 3. Docker Login (GitLab PSU)
# Extract domain from REGISTRY_PATH (everything before the first '/')
$REGISTRY_DOMAIN = $REGISTRY_PATH.Split('/')[0]

Write-Host "--- Logging into $REGISTRY_DOMAIN ---" -ForegroundColor Yellow
Write-Host "If prompted, please use your PSU Passport (Student ID) and Password."
docker login $REGISTRY_DOMAIN

if ($LASTEXITCODE -ne 0) {
    Write-Error "Login failed. Aborting."
    exit 1
}

# 4. Service List
$services = @("backend", "dashboard", "ingester", "backup")

foreach ($svc in $services) {
    Write-Host "`n--- Processing Service: $svc ---" -ForegroundColor Green
    $imageName = "$REGISTRY_PATH/$svc"
    
    # Check if folder exists
    if (-not (Test-Path $svc)) {
        Write-Warning "Folder $svc not found, skipping..."
        continue
    }

    # Build
    Write-Host "Running: docker build -t ${imageName}:latest $svc" -ForegroundColor Gray
    docker build -t "${imageName}:latest" $svc
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed for $svc"
        exit 1
    }

    # Push
    Write-Host "Running: docker push ${imageName}:latest" -ForegroundColor Gray
    docker push "${imageName}:latest"
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Push failed for $svc"
        exit 1
    }
}

Write-Host "`n--- All images pushed successfully! ---" -ForegroundColor Cyan
Write-Host "You can now go to your VM and run: docker-compose pull && docker-compose up -d"
