# Runs Claude Code task-by-task until PROGRESS.md says DONE or BLOCKED. Ctrl+C to stop.
# Usage (from anywhere):  .\scripts\autopilot.ps1 [-Model opus] [-MaxRuns 1000] [-RetryMinutes 15]
#
# To pause gracefully: create a file named PAUSE in the repo root
# (New-Item PAUSE). The current run finishes; no new run starts. Delete it to resume.
#
# Edits to this script and to .claude/settings*.json are denied in
# .claude/settings.json, so unattended runs can't loosen their own limits.
param(
  [string]$Model = 'opus',
  [int]$MaxRuns = 1000,
  [int]$RetryMinutes = 15
)

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null

$prompt = "Follow CLAUDE.md and KICKOFF section 7A. git pull both repos. Complete exactly ONE unchecked, unblocked task from PROGRESS.md (tests green, committed, pushed, PROGRESS.md updated; if it finishes a milestone, run the milestone verification protocol). Then exit."

$allowedTools = @(
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent',
  'Bash(pnpm:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(node:*)', 'Bash(npx:*)'
)
# Deny beats allow. Bash rules match command text, so cover each spelling.
$disallowedTools = @(
  'Bash(git push --force*)', 'Bash(git push * --force*)',  # also --force-with-lease
  'Bash(git push -f*)',      'Bash(git push * -f*)',
  'Bash(git push * +*)',                                   # +refspec force-push
  'Bash(gh repo delete*)',
  'Bash(gh repo edit*)'
)

for ($i = 1; $i -le $MaxRuns; $i++) {
  if (Test-Path (Join-Path $root 'PAUSE')) {
    Write-Host "PAUSE file found - not starting a new run. Delete PAUSE to resume."
    exit 0
  }

  $progress = Join-Path $root 'PROGRESS.md'
  if (-not (Test-Path $progress)) { Write-Host "PROGRESS.md not found - stopping."; exit 1 }
  $status = Get-Content $progress -TotalCount 1
  if ($status -notmatch '^STATUS: RUNNING') { Write-Host "$status - stopping."; exit 0 }

  $log = Join-Path $root "logs\autopilot-$(Get-Date -Format 'yyyy-MM-dd').log"
  Write-Host "=== Run $i ($(Get-Date)) model=$Model ==="
  "=== Run $i ($(Get-Date)) model=$Model ===" | Out-File -Append -Encoding utf8 $log

  claude -p $prompt --model $Model --permission-mode acceptEdits `
    --allowedTools $allowedTools --disallowedTools $disallowedTools |
    Tee-Object -FilePath $log -Append

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Run failed (exit $LASTEXITCODE, possibly usage limits). Retrying in $RetryMinutes min..."
    Start-Sleep -Seconds ($RetryMinutes * 60)
  }
}
