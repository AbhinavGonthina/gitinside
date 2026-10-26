# Runs Claude Code task-by-task until PROGRESS.md says DONE or BLOCKED. Ctrl+C to stop.
#
# Usage (from anywhere):
#   .\scripts\autopilot.ps1                                   # run until DONE/BLOCKED
#   .\scripts\autopilot.ps1 -Hours 4                          # work for 4 hours from now
#   .\scripts\autopilot.ps1 -StartAt 23:00 -StopAt 08:00      # wait for the window, stop at the end
#   .\scripts\autopilot.ps1 -Model sonnet                     # force one model for every task
#
# Each run does ONE task in a fresh Claude Code session. The model comes from the
# {model: ...} tag on the first unchecked, unblocked task in PROGRESS.md (default opus).
# No new task starts after the stop time; the task in progress always finishes.
#
# To pause gracefully: create a file named PAUSE in the repo root (New-Item PAUSE).
# Delete it to resume.
#
# Live feed: every action is printed as it happens. Full transcripts: claude --resume <id>
# (the id is printed at the end of each run). Raw event logs: logs\run-*.jsonl.
#
# Shows a Windows desktop notification whenever the loop stops, and after repeated
# failed runs. Things that need Abhinav become GitHub issues labeled needs-abhinav
# in gitinside-planning (see CLAUDE.md).
#
# Edits to this script and to .claude/settings*.json are denied in
# .claude/settings.json, so unattended runs can't loosen their own limits.
param(
  [string]$Model = '',
  [int]$MaxRuns = 1000,
  [int]$RetryMinutes = 15,
  [int]$NotifyAfterFailures = 3,
  [string]$StartAt = '',
  [string]$StopAt = '',
  [double]$Hours = 0
)

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
New-Item -ItemType Directory -Force (Join-Path $root 'logs') | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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

# ---- Work window ----
$now = Get-Date
$start = if ($StartAt) { [datetime]::Parse($StartAt) } else { $now }
$stop = $null
if ($StopAt) {
  $stop = [datetime]::Parse($StopAt)
  if ($StartAt -and $stop -le $start) { $stop = $stop.AddDays(1) }
  if (-not $StartAt -and $stop -le $now) { $stop = $stop.AddDays(1) }
}
if ($StartAt -and $start -lt $now) {
  $overnight = $StopAt -and ([datetime]::Parse($StopAt)).TimeOfDay -lt $start.TimeOfDay
  if ($StopAt -and $now -lt $stop) {
    $start = $now                                   # already inside today's window
  } elseif ($overnight -and $now.TimeOfDay -lt ([datetime]::Parse($StopAt)).TimeOfDay) {
    $start = $now; $stop = [datetime]::Parse($StopAt)  # inside last night's window
  } else {
    $start = $start.AddDays(1)
    if ($stop) { $stop = $stop.AddDays(1) }
  }
}
if ($Hours -gt 0) { $stop = $start.AddHours($Hours) }

if ($start -gt (Get-Date)) {
  Write-Host "Waiting until $start to start$(if ($stop) { ", will stop starting tasks at $stop" })..."
  while ((Get-Date) -lt $start) {
    if (Test-Path (Join-Path $root 'PAUSE')) { Stop-Loop 'PAUSE file found while waiting. Delete PAUSE to resume' }
    Start-Sleep -Seconds 30
  }
}
if ($stop) { Write-Host "Working until $stop (the task in progress at that time will finish)." }

# ---- Next task and its model ----
function Get-NextTask([string]$ProgressPath) {
  foreach ($line in Get-Content $ProgressPath) {
    if ($line -match '^- \[ \] (.+)$' -and $line -notmatch '\{blocked') {
      $text = $Matches[1]
      $tagged = if ($text -match '\{model:\s*([\w.\-\[\]]+)\s*\}') { $Matches[1] } else { '' }
      $title = ($text -replace '\s*\{[^}]*\}', '').Trim()
      return @{ Title = $title; Model = $tagged }
    }
  }
  return $null
}

# ---- Live feed ----
function Shorten([string]$Text, [int]$Max = 110) {
  $one = ($Text -split "`r?`n")[0].Trim()
  if ($one.Length -gt $Max) { $one.Substring(0, $Max - 1) + '...' } else { $one }
}

function Write-Event($Evt, [hashtable]$Run) {
  switch ($Evt.type) {
    'system' {
      if ($Evt.subtype -eq 'init') { $Run.SessionId = $Evt.session_id }
    }
    'assistant' {
      foreach ($part in $Evt.message.content) {
        if ($part.type -eq 'text' -and $part.text.Trim()) {
          Write-Host ("  Claude:   " + (Shorten $part.text 140)) -ForegroundColor Gray
        } elseif ($part.type -eq 'tool_use') {
          $in = $part.input
          $what = switch ($part.name) {
            'Read'  { "Reading   $($in.file_path)" }
            'Edit'  { "Editing   $($in.file_path)" }
            'Write' { "Writing   $($in.file_path)" }
            'Bash'  { "Running   $(Shorten $in.command)" }
            'Grep'  { "Searching $(Shorten $in.pattern 60)" }
            'Glob'  { "Finding   $($in.pattern)" }
            'Agent' { "Subagent  $(Shorten $in.description 80)" }
            default { "$($part.name)" }
          }
          Write-Host "  $what"
        }
      }
    }
    'user' {
      foreach ($part in $Evt.message.content) {
        if ($part.type -eq 'tool_result' -and $part.is_error) {
          $msg = if ($part.content -is [string]) { $part.content } else { ($part.content | ForEach-Object { $_.text }) -join ' ' }
          Write-Host ("    ! " + (Shorten $msg 120)) -ForegroundColor Yellow
        }
      }
    }
    'result' {
      $Run.SessionId = $Evt.session_id
      $Run.Summary = $Evt.result
      $Run.IsError = [bool]$Evt.is_error
      $Run.Minutes = [math]::Round($Evt.duration_ms / 60000, 1)
    }
  }
}

$prompt = "Follow CLAUDE.md. git pull both repos. Complete exactly ONE unchecked, unblocked task from PROGRESS.md (tests green, committed, pushed, PROGRESS.md and SESSION_LOG.md updated; if it finishes a milestone, run the milestone verification protocol). Then exit."

$allowedTools = @(
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'WebFetch', 'WebSearch',
  'Bash(pnpm:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(node:*)', 'Bash(npx:*)',
  'Bash(mkdir:*)', 'Bash(docker compose:*)', 'Bash(docker ps:*)'   # local Postgres/Redis for integration tests (M5+)
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
  if ($stop -and (Get-Date) -ge $stop) { Stop-Loop "Time window ended ($stop)" }
  if (Test-Path (Join-Path $root 'PAUSE')) { Stop-Loop 'PAUSE file found. Delete PAUSE to resume' }

  git pull --quiet 2>$null | Out-Null
  $progress = Join-Path $root 'PROGRESS.md'
  if (-not (Test-Path $progress)) { Stop-Loop 'PROGRESS.md not found' 1 }
  $status = Get-Content $progress -TotalCount 1
  if ($status -notmatch '^STATUS: RUNNING') { Stop-Loop $status }

  $task = Get-NextTask $progress
  if (-not $task) { Stop-Loop 'No unchecked, unblocked task left in PROGRESS.md' }
  $runModel = if ($Model) { $Model } elseif ($task.Model) { $task.Model } else { 'opus' }

  $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
  $log = Join-Path $root "logs\autopilot-$(Get-Date -Format 'yyyy-MM-dd').log"
  $raw = Join-Path $root "logs\run-$stamp-$i.jsonl"
  $header = "=== Run $i ($(Get-Date)) | $($task.Title) | $runModel ==="
  Write-Host $header -ForegroundColor Cyan
  $header | Out-File -Append -Encoding utf8 $log

  $run = @{ SessionId = ''; Summary = ''; IsError = $false; Minutes = 0 }
  $writer = New-Object System.IO.StreamWriter($raw, $true, (New-Object System.Text.UTF8Encoding($false)))
  try {
    claude -p $prompt --model $runModel --permission-mode acceptEdits `
      --output-format stream-json --verbose `
      --allowedTools $allowedTools --disallowedTools $disallowedTools |
      ForEach-Object {
        $line = [string]$_
        $writer.WriteLine($line)
        try { Write-Event ($line | ConvertFrom-Json) $run } catch { if ($line.Trim()) { Write-Host "  $line" } }
      }
    $code = $LASTEXITCODE
  } finally {
    $writer.Close()
  }

  $tail = "Done in $($run.Minutes)m | exit $code | transcript: claude --resume $($run.SessionId)"
  Write-Host "  $tail" -ForegroundColor Cyan
  @("Summary: $($run.Summary)", $tail, "Raw events: $raw", '') | Out-File -Append -Encoding utf8 $log

  if ($code -ne 0 -or $run.IsError) {
    $failures++
    if ($failures -eq $NotifyAfterFailures) {
      Send-Notification 'GitInside autopilot is failing' "$failures runs in a row failed (exit $code). Still retrying; check logs\."
    }
    $wait = $RetryMinutes * 60
    if ($stop) { $wait = [math]::Max(0, [math]::Min($wait, ($stop - (Get-Date)).TotalSeconds)) }
    Write-Host "Run failed (exit $code, possibly usage limits). Retrying in $([math]::Round($wait / 60, 1)) min..."
    Start-Sleep -Seconds ([int]$wait)
  } else {
    $failures = 0
  }
}
Stop-Loop "Reached MaxRuns ($MaxRuns)"
