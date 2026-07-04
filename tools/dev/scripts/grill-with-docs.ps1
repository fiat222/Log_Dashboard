param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Query
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$skillsRoot = Join-Path $repoRoot "skills"
$skillFile = Join-Path $skillsRoot "engineering\grill-with-docs\SKILL.md"
$grillingFile = Join-Path $skillsRoot "productivity\grilling\SKILL.md"
$domainFile = Join-Path $skillsRoot "engineering\domain-modeling\SKILL.md"

if (-not (Test-Path $skillFile)) {
    Write-Error "grill-with-docs is not installed at $skillFile"
    exit 1
}

$queryText = ($Query -join " ").Trim()

Write-Output "grill-with-docs is installed in this repo."
Write-Output ""
Write-Output "Installed skills:"
Write-Output "  $skillFile"
Write-Output "  $grillingFile"
Write-Output "  $domainFile"
Write-Output ""
Write-Output "Usage model:"
Write-Output "  This is a prompt/skill workflow, not a standalone analyzer binary."
Write-Output "  Use it by asking the agent to grill a plan against repo docs."

if ($queryText) {
    Write-Output ""
    Write-Output "Query:"
    Write-Output "  $queryText"
    Write-Output ""
    Write-Output "Relevant docs:"
    & rg -n --glob "!node_modules/**" --glob "!archive/**" --glob "!skills/**" $queryText $repoRoot 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Output "  No direct matches found."
    }
}
