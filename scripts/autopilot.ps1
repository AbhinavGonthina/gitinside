# Runs Claude Code task-by-task until PROGRESS.md says DONE or BLOCKED. Ctrl+C to stop.
# Usage (from anywhere):  .\scripts\autopilot.ps1 [-Model opus] [-MaxRuns 1000] [-RetryMinutes 15]
#
# To pause gracefully: create a file named PAUSE in the repo root
# (New-Item PAUSE). The current run finishes; no new run starts. Delete it to resume.
#
# Shows a Windows desktop notification whenever the loop stops, and after
# repeated failed runs. Things that need Abhinav also become GitHub issues
# labeled needs-abhinav in gitinside-planning (see CLAUDE.md).
#
# Edits to this script and to .claude/settings*.json are denied in
# .claude/settings.json, so unattended runs can't loosen their own limits.
param(
  [string]$Model = 'opus',
  [int]$MaxRuns = 1000,
  [int]$RetryMinutes = 15,
  [int]$NotifyAfterFailures = 3
)

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null

# Desktop notification via a tray balloon, which Windows 10/11 shows as a
# toast and keeps in the notification panel (Win+N). Never fails the loop.
function Send-Notification([string]$Title, [string]$Message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.ShowBalloonTip(10000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 5
    $icon.Dispose()
  } catch {
    Write-Host "(desktop notification failed: $($_.Exception.Message))"
  }
}

function Stop-Loop([string]$Reason, [int]$Code = 0) {
  Write-Host "$Reason - stopping."
  Send-Notification 'GitInside autopilot stopped' $Reason
  exit $Code
}

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

$failures = 0
for ($i = 1; $i -le $MaxRuns; $i++) {
  if (Test-Path (Join-Path $root 'PAUSE')) { Stop-Loop 'PAUSE file found. Delete PAUSE to resume' }

  $progress = Join-Path $root 'PROGRESS.md'
  if (-not (Test-Path $progress)) { Stop-Loop 'PROGRESS.md not found' 1 }
  $status = Get-Content $progress -TotalCount 1
  if ($status -notmatch '^STATUS: RUNNING') { Stop-Loop $status }

  $log = Join-Path $root "logs\autopilot-$(Get-Date -Format 'yyyy-MM-dd').log"
  Write-Host "=== Run $i ($(Get-Date)) model=$Model ==="
  "=== Run $i ($(Get-Date)) model=$Model ===" | Out-File -Append -Encoding utf8 $log

  claude -p $prompt --model $Model --permission-mode acceptEdits `
    --allowedTools $allowedTools --disallowedTools $disallowedTools |
    Tee-Object -FilePath $log -Append

  if ($LASTEXITCODE -ne 0) {
    $failures++
    if ($failures -eq $NotifyAfterFailures) {
      Send-Notification 'GitInside autopilot is failing' "$failures runs in a row failed (exit $LASTEXITCODE). Still retrying; check logs\."
    }
    Write-Host "Run failed (exit $LASTEXITCODE, possibly usage limits). Retrying in $RetryMinutes min..."
    Start-Sleep -Seconds ($RetryMinutes * 60)
  } else {
    $failures = 0
  }
}
Stop-Loop "Reached MaxRuns ($MaxRuns)"
