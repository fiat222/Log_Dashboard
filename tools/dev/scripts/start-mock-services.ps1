$ErrorActionPreference = "Stop"

function Ensure-MockService {
    param(
        [string]$Name,
        [string]$Service,
        [string]$Script
    )

    $existing = docker ps -a --filter "name=$Name" --format "{{.Names}}"
    if ($existing -contains $Name) {
        docker rm -f $Name | Out-Null
    }

    docker run -d `
        --name $Name `
        --label "com.docker.compose.project=mock-stack" `
        --label "com.docker.compose.service=$Service" `
        --entrypoint sh `
        logs-dashboard-ci-jenkins `
        -c $Script | Out-Null
}

Ensure-MockService `
    -Name "logs-dashboard-mock-api" `
    -Service "api" `
    -Script 'while true; do echo INFO_mock_api_request_status_200_path_orders; sleep 2; echo ERROR_mock_api_request_status_500_path_orders; sleep 12; done'

Ensure-MockService `
    -Name "logs-dashboard-mock-postgres" `
    -Service "postgres" `
    -Script 'while true; do echo INFO_mock_postgres_checkpoint_duration_ms_12; sleep 3; echo WARN_mock_postgres_slow_query_duration_ms_941; sleep 15; done'

Write-Output "Mock services running:"
docker ps --filter "name=logs-dashboard-mock" --format "  {{.Names}}"
