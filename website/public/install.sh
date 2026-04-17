#!/usr/bin/env bash
# AgEnD Bootstrap Installer
# Usage: curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash
#
# This script:
# 1. Detects OS + architecture
# 2. Checks/installs Node.js >= 20 (via nvm)
# 3. Checks/installs tmux
# 4. Installs agend globally via npm
# 5. Detects backend CLIs
# 6. Runs agend quickstart
#
# Source: https://github.com/suzuke/AgEnD/blob/main/website/public/install.sh

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }
step()  { echo -e "\n${BOLD}[$1/$TOTAL] $2${NC}"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

TOTAL=5

echo -e "\n${BOLD}═══ AgEnD Installer ═══${NC}\n"

# ── Step 1: Detect OS ────────────────────────────────────

step 1 "Detecting system"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) OS_NAME="macOS" ;;
  Linux)  OS_NAME="Linux" ;;
  *)      error "Unsupported OS: $OS. AgEnD supports macOS and Linux." ;;
esac

info "$OS_NAME ($ARCH)"

# ── WSL Detection ────────────────────────────────────────

IS_WSL=false
if [ "$OS" = "Linux" ] && grep -qiE "microsoft|WSL" /proc/version 2>/dev/null; then
  IS_WSL=true
  warn "WSL environment detected"

  # Check if node resolves to a Windows binary
  if command_exists node; then
    NODE_BIN_PATH=$(command -v node)
    if [[ "$NODE_BIN_PATH" == /mnt/[a-z]/* ]]; then
      warn "Windows Node.js detected at $NODE_BIN_PATH — this causes issues in WSL"
      warn "Will install a native Linux Node.js via nvm instead"
      # Shadow the Windows node so the version check below triggers nvm install
      node() { return 1; }
      command_exists() { [[ "$1" != "node" ]] && command -v "$1" >/dev/null 2>&1 || return 1; }
    fi
  fi

  echo -e "  ${DIM}Tip: To permanently hide Windows PATH in WSL, add to /etc/wsl.conf:${NC}"
  echo -e "  ${DIM}  [interop]${NC}"
  echo -e "  ${DIM}  appendWindowsPath=false${NC}"
fi

# Detect package manager
PKG_MGR=""
if command_exists brew; then
  PKG_MGR="brew"
elif command_exists apt-get; then
  PKG_MGR="apt"
elif command_exists dnf; then
  PKG_MGR="dnf"
elif command_exists pacman; then
  PKG_MGR="pacman"
fi

# ── Step 2: Node.js >= 20 ────────────────────────────────

step 2 "Checking Node.js"

NODE_OK=false
if command_exists node; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 20 ] 2>/dev/null; then
    info "Node.js $(node -v) found"
    NODE_OK=true
  else
    warn "Node.js $(node -v) found but >= 20 required"
  fi
fi

if [ "$NODE_OK" = false ]; then
  echo "  Installing Node.js 22 via nvm..."

  # Install nvm if not present
  if [ ! -d "${NVM_DIR:-$HOME/.nvm}" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  nvm install 22
  nvm use 22
  nvm alias default 22

  # Restore command_exists if we shadowed it for WSL
  if [ "$IS_WSL" = true ]; then
    unset -f node 2>/dev/null || true
    unset -f command_exists 2>/dev/null || true
    command_exists() { command -v "$1" >/dev/null 2>&1; }
  fi

  if ! command_exists node; then
    error "Failed to install Node.js. Please install manually: https://nodejs.org"
  fi
  info "Node.js $(node -v) installed via nvm"
fi

# Ensure nvm node is first in PATH on WSL
if [ "$IS_WSL" = true ] && [ -d "${NVM_DIR:-$HOME/.nvm}" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  NODE_BIN_PATH=$(command -v node 2>/dev/null || true)
  if [[ "$NODE_BIN_PATH" == /mnt/[a-z]/* ]]; then
    warn "Windows node still first in PATH — nvm node may not be active"
  fi
fi

# ── Step 3: tmux ─────────────────────────────────────────

step 3 "Checking tmux"

if command_exists tmux; then
  info "tmux $(tmux -V) found"
else
  echo "  Installing tmux..."
  case "$PKG_MGR" in
    brew)   brew install tmux ;;
    apt)    sudo apt-get update -qq && sudo apt-get install -y -qq tmux ;;
    dnf)    sudo dnf install -y tmux ;;
    pacman) sudo pacman -S --noconfirm tmux ;;
    *)      error "Cannot install tmux automatically. Please install manually." ;;
  esac

  if ! command_exists tmux; then
    error "Failed to install tmux."
  fi
  info "tmux $(tmux -V) installed"
fi

# ── Step 4: Install AgEnD ────────────────────────────────

step 4 "Installing AgEnD"

if command_exists agend; then
  CURRENT=$(agend --version 2>/dev/null || echo "unknown")
  warn "AgEnD already installed (${CURRENT}), upgrading..."
fi

npm install -g @suzuke/agend

if ! command_exists agend; then
  error "Installation failed. Try: npm install -g @suzuke/agend"
fi
info "AgEnD $(agend --version) installed"

# ── Step 5: Detect backend ───────────────────────────────

step 5 "Detecting AI backend"

BACKENDS=("claude:Claude Code" "codex:OpenAI Codex" "gemini:Gemini CLI" "opencode:OpenCode" "kiro-cli:Kiro CLI")
FOUND=0

for entry in "${BACKENDS[@]}"; do
  cmd="${entry%%:*}"
  label="${entry#*:}"
  if command_exists "$cmd"; then
    info "$label found ($cmd)"
    FOUND=$((FOUND + 1))
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo ""
  warn "No supported AI backend found."
  echo -e "  Install Claude Code: ${DIM}curl -fsSL https://claude.ai/install.sh | bash${NC}"
  echo ""
fi

# ── Launch quickstart ─────────────────────────────────────

echo -e "\n${BOLD}═══ Installation Complete ═══${NC}\n"
echo "  Run the setup wizard:"
echo -e "  ${BOLD}agend quickstart${NC}\n"

# Auto-launch if interactive terminal
if [ -t 0 ] && [ -t 1 ]; then
  read -rp "  Launch quickstart now? [Y/n] " answer
  if [ "${answer:-Y}" != "n" ] && [ "${answer:-Y}" != "N" ]; then
    echo ""
    agend quickstart
  fi
fi
