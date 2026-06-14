#requires -Version 5.1
<#
.SYNOPSIS
  One-command setup for the `rain` CLI (kimi-code fork) on Windows.

.DESCRIPTION
  Auto-installs anything missing (git, Node.js via winget), then clones the
  repo, installs dependencies, builds the CLI, installs the Chromium browser
  used by the Browser tool / `/fsdata`, and links `rain` globally.

  You normally run this ONCE and then just type `rain`.

.EXAMPLE
  ./install.ps1

.NOTES
  Optional overrides (environment variables):
    RAIN_REPO_URL   git URL to clone        (default: https://github.com/ishk9/kimi-code.git)
    RAIN_DIR        target directory name   (default: kimi-code)
    RAIN_NO_INSTALL set to 1 to only check (do not auto-install prerequisites)

  If you get an execution-policy error, run:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  Auto-install uses winget (ships with Windows 10 2004+/11). If winget is
  missing, update "App Installer" from the Microsoft Store, or install git +
  Node.js >= 24.15.0 manually and re-run.
#>

$ErrorActionPreference = 'Stop'

$RepoUrl   = if ($env:RAIN_REPO_URL) { $env:RAIN_REPO_URL } else { 'https://github.com/ishk9/kimi-code.git' }
$TargetDir = if ($env:RAIN_DIR)      { $env:RAIN_DIR }      else { 'kimi-code' }
$AutoInstall = -not ($env:RAIN_NO_INSTALL -eq '1')
$RequiredNodeMajor = 24
$RequiredNode = '24.15.0'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Pull freshly-installed tools onto PATH without reopening the terminal.
function Update-SessionPath {
  $machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Install-WithWinget($id, $label) {
  if (-not $AutoInstall) { Fail "$label is required but missing (RAIN_NO_INSTALL=1). Install it and re-run." }
  if (-not (Test-Cmd winget)) {
    Fail "$label is missing and winget is unavailable. Update 'App Installer' from the Microsoft Store (or install $label manually), then re-run."
  }
  Info "Installing $label via winget ($id)"
  winget install --id $id -e --source winget --accept-source-agreements --accept-package-agreements
  Update-SessionPath
}

function Test-NodeOk {
  if (-not (Test-Cmd node)) { return $false }
  try { $v = (node -v).TrimStart('v') } catch { return $false }
  return ([int]($v.Split('.')[0]) -ge $RequiredNodeMajor)
}

# 1. git ---------------------------------------------------------------------
if (-not (Test-Cmd git)) { Install-WithWinget 'Git.Git' 'git' }
if (-not (Test-Cmd git)) { Fail "git still not found after install. Open a NEW terminal and re-run." }
Info "git OK"

# 2. node (>= 24.15.0) -------------------------------------------------------
if (-not (Test-NodeOk)) { Install-WithWinget 'OpenJS.NodeJS.LTS' "Node.js >= $RequiredNode" }
if (-not (Test-NodeOk)) { Fail "Node.js >= $RequiredNode still not found. Open a NEW terminal and re-run." }
Info "Node $((node -v).TrimStart('v')) OK"

# 3. pnpm (via corepack, which ships with Node) -----------------------------
if (-not (Test-Cmd pnpm)) {
  Info "Enabling pnpm via corepack"
  corepack enable pnpm
  Update-SessionPath
}
Info "pnpm $(pnpm -v) OK"

# 4. clone or update ---------------------------------------------------------
if (Test-Path (Join-Path $TargetDir '.git')) {
  Info "Updating existing clone in $TargetDir"
  git -C $TargetDir pull --ff-only
} else {
  Info "Cloning $RepoUrl into $TargetDir"
  git clone $RepoUrl $TargetDir
}
Set-Location $TargetDir

# 5. install + build ---------------------------------------------------------
Info "Installing dependencies (pnpm install)"
pnpm install

Info "Building the CLI"
pnpm -C apps/kimi-code run build

# 6. chromium for the Browser tool / /fsdata --------------------------------
Info "Installing Chromium for the Browser tool"
pnpm --filter '@moonshot-ai/kimi-code' exec playwright install chromium

# 7. link `rain` globally ----------------------------------------------------
Info "Linking the 'rain' command globally"
Push-Location apps/kimi-code
npm link
Pop-Location

Write-Host ''
Info "Done. Open a NEW terminal and run:  rain"
Info "First run: use /login, or add your provider + API key to ~/.kimi-code/config.toml"
