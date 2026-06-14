#!/usr/bin/env bash
#
# install.sh — one-command setup for the `rain` CLI (kimi-code fork) on
# macOS or Linux.
#
# Auto-installs anything missing (git, Node.js via your package manager), then
# clones the repo, installs dependencies, builds the CLI, installs the Chromium
# browser used by the Browser tool / `/fsdata`, and links `rain` globally.
#
# Usage:
#   ./install.sh
#
# Optional overrides (environment variables):
#   RAIN_REPO_URL    git URL to clone        (default: https://github.com/ishk9/kimi-code.git)
#   RAIN_DIR         target directory name   (default: kimi-code)
#   RAIN_NO_INSTALL  set to 1 to only check (do not auto-install prerequisites)
#
set -euo pipefail

REPO_URL="${RAIN_REPO_URL:-https://github.com/ishk9/kimi-code.git}"
TARGET_DIR="${RAIN_DIR:-kimi-code}"
REQUIRED_NODE_MAJOR=24
REQUIRED_NODE="24.15.0"

info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$1"; }
err()  { printf '\033[31m[error]\033[0m %s\n' "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# Install a package via whichever manager is available.
#   $1 = Homebrew formula, $2 = apt/dnf package name, $3 = human label
pkg_install() {
  if [ "${RAIN_NO_INSTALL:-}" = "1" ]; then
    err "$3 is required but missing (RAIN_NO_INSTALL=1). Install it and re-run."; exit 1
  fi
  if have brew; then
    info "Installing $3 via Homebrew"; brew install "$1"
  elif have apt-get; then
    info "Installing $3 via apt-get (sudo)"; sudo apt-get update -y && sudo apt-get install -y "$2"
  elif have dnf; then
    info "Installing $3 via dnf (sudo)"; sudo dnf install -y "$2"
  else
    err "$3 is missing and no supported package manager (brew/apt/dnf) was found. Install $3 and re-run."; exit 1
  fi
}

node_ok() {
  have node || return 1
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)" || return 1
  [ "${major:-0}" -ge "${REQUIRED_NODE_MAJOR}" ]
}

# 1. git ---------------------------------------------------------------------
have git || pkg_install git git "git"
have git || { err "git still not found after install."; exit 1; }
info "git OK"

# 2. node (>= 24.15.0) -------------------------------------------------------
if ! node_ok; then
  pkg_install node nodejs "Node.js >= ${REQUIRED_NODE}"
fi
if ! node_ok; then
  err "Node.js >= ${REQUIRED_NODE} still not found (your package manager may ship an older version)."
  err "Install it with nvm:  nvm install ${REQUIRED_NODE} && nvm use ${REQUIRED_NODE}"
  err "or via NodeSource:    https://github.com/nodesource/distributions"
  exit 1
fi
info "Node $(node -v | sed 's/^v//') OK"

# 3. pnpm (via corepack, which ships with Node) -----------------------------
if ! have pnpm; then
  info "Enabling pnpm via corepack"
  corepack enable pnpm >/dev/null 2>&1 || { err "Could not enable pnpm. Run: npm i -g pnpm"; exit 1; }
fi
info "pnpm $(pnpm -v) OK"

# 4. clone or update ---------------------------------------------------------
if [ -d "${TARGET_DIR}/.git" ]; then
  info "Updating existing clone in ${TARGET_DIR}"
  git -C "${TARGET_DIR}" pull --ff-only
else
  info "Cloning ${REPO_URL} into ${TARGET_DIR}"
  git clone "${REPO_URL}" "${TARGET_DIR}"
fi
cd "${TARGET_DIR}"

# 5. install + build ---------------------------------------------------------
info "Installing dependencies (pnpm install)"
pnpm install

info "Building the CLI"
pnpm -C apps/kimi-code run build

# 6. chromium for the Browser tool / /fsdata --------------------------------
info "Installing Chromium for the Browser tool"
pnpm --filter @moonshot-ai/kimi-code exec playwright install chromium

# 7. link `rain` globally ----------------------------------------------------
info "Linking the 'rain' command globally"
( cd apps/kimi-code && npm link )

echo
info "Done. Open a NEW terminal and run:  rain"
info "First run: use /login, or add your provider + API key to ~/.kimi-code/config.toml"
