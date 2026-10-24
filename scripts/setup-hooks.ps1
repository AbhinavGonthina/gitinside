# Runs scripts/setup-hooks.sh with Git for Windows' bash.
# Usage (from the repo root):  .\scripts\setup-hooks.ps1
# If scripts are blocked:      powershell -ExecutionPolicy Bypass -File .\scripts\setup-hooks.ps1
#
# Plain `bash` on Windows is often WSL's System32\bash.exe, which runs a
# different (Linux) git, so locate Git for Windows' bash explicitly.
$ErrorActionPreference = 'Stop'

$git = (Get-Command git -ErrorAction Stop).Source
$candidates = @(
  (Join-Path (Split-Path (Split-Path $git)) 'bin\bash.exe'),
  "$env:ProgramFiles\Git\bin\bash.exe",
  "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
  "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
)
$bash = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bash) { throw "Git Bash not found. Install Git for Windows: https://git-scm.com/download/win" }

& $bash (Join-Path $PSScriptRoot 'setup-hooks.sh')
exit $LASTEXITCODE
