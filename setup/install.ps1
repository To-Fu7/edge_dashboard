<#
.SYNOPSIS
  EPiWalk installer for Windows. Checks WSL2, Docker Desktop and the NVIDIA
  driver, then runs setup/install.sh inside WSL2 (all real work happens there).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup\install.ps1
  powershell -ExecutionPolicy Bypass -File setup\install.ps1 -Distro Ubuntu-24.04 -- --yes

  Anything after the script's own parameters is passed to install.sh
  (e.g. --yes, --from triton, --external-db). See setup/README.md.
#>
param(
  [string]$Distro = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$InstallArgs = @()
)

$ErrorActionPreference = 'Stop'

function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  ..  $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Fail($msg, $fix) {
  Write-Host ""
  Write-Host "  X  $msg" -ForegroundColor Red
  if ($fix) { Write-Host "     Fix: $fix" }
  Write-Host "     Docs: setup\00-pre-setup.md, setup\windows-wsl2.md"
  exit 1
}

# wsl.exe prints UTF-16; strip the NULs so normal string handling works.
function Invoke-Wsl([string[]]$WslArgs) {
  $out = & wsl.exe @WslArgs 2>&1
  return (($out | Out-String) -replace "`0", "").Trim()
}

try {
  Write-Host "EPiWalk installer (Windows -> WSL2)" -ForegroundColor White

  # --- Windows -------------------------------------------------------------
  $build = [Environment]::OSVersion.Version.Build
  if ($build -lt 19041) { Fail "Windows build $build is too old for WSL2" "Windows 10 version 2004 (build 19041) or Windows 11 is required." }
  Ok "Windows build $build"

  # --- WSL2 + distro -------------------------------------------------------
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Fail "WSL is not installed" "In an Administrator PowerShell: wsl --install -d Ubuntu  (then reboot and run this script again)"
  }
  $distros = (Invoke-Wsl @('-l', '-q')) -split "`r?`n" |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and $_ -notmatch '^docker-desktop' }
  if (-not $distros) { Fail "No Linux distribution in WSL" "wsl --install -d Ubuntu" }
  if (-not $Distro) { $Distro = $distros | Select-Object -First 1 }
  if ($distros -notcontains $Distro) { Fail "WSL distro '$Distro' not found (have: $($distros -join ', '))" "Pass -Distro <name>." }
  $kernel = Invoke-Wsl @('-d', $Distro, '--', 'uname', '-r')
  if ($kernel -notmatch 'WSL2') { Fail "'$Distro' runs on WSL1 ($kernel)" "wsl --set-version $Distro 2" }
  Ok "WSL2 distro: $Distro"

  # --- Docker Desktop ------------------------------------------------------
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    Fail "Docker Desktop is not installed" "Install Docker Desktop (WSL2 backend), start it, then run this script again."
  }
  & docker.exe info *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running" "Start Docker Desktop and wait until it says 'Engine running'." }
  $inWsl = Invoke-Wsl @('-d', $Distro, '--', 'sh', '-c', 'docker info >/dev/null 2>&1 && echo yes || echo no')
  if ($inWsl -ne 'yes') {
    Fail "Docker is not reachable from inside '$Distro'" "Docker Desktop -> Settings -> Resources -> WSL integration -> enable '$Distro' -> Apply & restart."
  }
  Ok "Docker Desktop reachable from $Distro"

  # --- GPU (optional) ------------------------------------------------------
  if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
    $gpu = (& nvidia-smi.exe --query-gpu=name,driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
    if ($gpu) { Ok "NVIDIA GPU: $gpu" } else { Warn "nvidia-smi found but reported no GPU - install will fall back to CPU mode." }
  } else {
    Warn "No NVIDIA driver found - install will run in CPU mode (only a few cameras)."
  }

  # --- Repo location -------------------------------------------------------
  $repo = Split-Path -Parent $PSScriptRoot
  if ($repo -match '^\\\\wsl(\.localhost|\$)\\([^\\]+)\\(.*)$') {
    $pathDistro = $Matches[2]
    $linuxPath = '/' + ($Matches[3] -replace '\\', '/')
    if ($pathDistro -ne $Distro) { Info "Repo lives in distro '$pathDistro' - using it."; $Distro = $pathDistro }
    Ok "Repo inside WSL: $linuxPath"
  } else {
    $linuxPath = Invoke-Wsl @('-d', $Distro, '--', 'wslpath', '-a', $repo)
    Warn "Repo is on the Windows filesystem ($repo -> $linuxPath)."
    Warn "That is slow, and containers created by the dashboard may not see the files."
    Warn "Recommended: clone inside WSL, e.g. \\wsl.localhost\$Distro\home\<user>\dashboard-python-counting"
    $answer = Read-Host "  Continue from the Windows path anyway? [y/N]"
    if ($answer -notmatch '^[Yy]') { exit 1 }
  }

  # --- Line endings --------------------------------------------------------
  $installSh = Join-Path $PSScriptRoot 'install.sh'
  if ([IO.File]::ReadAllText($installSh).Contains("`r`n")) {
    Warn "Shell scripts were checked out with Windows line endings (CRLF) - converting them to LF."
    Invoke-Wsl @('-d', $Distro, '--', 'sh', '-c',
      "cd '$linuxPath' && find . -name '*.sh' -not -path './dashboard/node_modules/*' -exec sed -i 's/\r`$//' {} +") | Out-Null
    Ok "Line endings fixed (future clones are covered by .gitattributes)"
  }

  # --- Hand over to install.sh --------------------------------------------
  $argLine = ($InstallArgs | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
  Write-Host ""
  Info "Running setup/install.sh inside $Distro ..."
  & wsl.exe -d $Distro -- bash -lc "cd '$linuxPath' && chmod +x setup/install.sh && ./setup/install.sh $argLine"
  exit $LASTEXITCODE
}
catch {
  Fail "Unexpected error: $($_.Exception.Message)" "Re-run the script; if it repeats, check the message above."
}
