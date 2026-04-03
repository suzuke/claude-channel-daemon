#!/usr/bin/env bash
#
# Build the agend E2E golden image using Tart.
#
# This script:
# 1. Clones a macOS base image from the Tart registry
# 2. Boots it headless
# 3. SSHs in and installs Node.js, tmux, and agend dependencies
# 4. Shuts down — the resulting VM is the golden image for E2E tests
#
# Prerequisites:
#   brew install cirruslabs/cli/tart
#   brew install cirruslabs/cli/sshpass
#
# Usage:
#   ./e2e/vm-setup/setup-vm.sh [--force]
#
# The golden image is stored as "agend-e2e-golden" in Tart's local registry.
# Use --force to rebuild from scratch.

set -euo pipefail

GOLDEN_IMAGE="agend-e2e-golden"
BASE_IMAGE="ghcr.io/cirruslabs/macos-sequoia-base:latest"
SSH_USER="admin"
SSH_PASS="admin"

# Parse args
FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

# Check prerequisites
for cmd in tart sshpass; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "❌ $cmd not found. Install it:"
    [[ "$cmd" == "tart" ]] && echo "   brew install cirruslabs/cli/tart"
    [[ "$cmd" == "sshpass" ]] && echo "   brew install cirruslabs/cli/sshpass"
    exit 1
  fi
done

# Check if golden image already exists
if tart list --quiet | grep -q "^${GOLDEN_IMAGE}$" && [[ "$FORCE" != "true" ]]; then
  echo "✅ Golden image '${GOLDEN_IMAGE}' already exists. Use --force to rebuild."
  exit 0
fi

# Clean up existing image if force rebuild
if tart list --quiet | grep -q "^${GOLDEN_IMAGE}$"; then
  echo "🗑️  Deleting existing golden image..."
  tart delete "$GOLDEN_IMAGE" || true
fi

echo "📦 Cloning base image (this may take a while on first run)..."
tart clone "$BASE_IMAGE" "$GOLDEN_IMAGE"

echo "🚀 Starting VM headless..."
tart run --no-graphics "$GOLDEN_IMAGE" &
VM_PID=$!

# Wait for VM to boot and become reachable via SSH
echo "⏳ Waiting for VM to become reachable..."
MAX_WAIT=120
ELAPSED=0
while ! tart ip "$GOLDEN_IMAGE" &>/dev/null; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "❌ VM did not become reachable within ${MAX_WAIT}s"
    kill $VM_PID 2>/dev/null || true
    exit 1
  fi
done

VM_IP=$(tart ip "$GOLDEN_IMAGE")
echo "🌐 VM IP: $VM_IP"

# Wait for SSH to be ready
echo "⏳ Waiting for SSH..."
ELAPSED=0
while ! sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 "${SSH_USER}@${VM_IP}" "echo ok" &>/dev/null; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "❌ SSH not ready within ${MAX_WAIT}s"
    kill $VM_PID 2>/dev/null || true
    exit 1
  fi
done

echo "🔧 Provisioning VM..."

# Helper to run commands in VM
ssh_run() {
  sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${SSH_USER}@${VM_IP}" "$@"
}

# Install Homebrew (if not already installed in base image)
ssh_run 'command -v brew || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' || true

# Install Node.js and tmux
ssh_run 'eval "$(/opt/homebrew/bin/brew shellenv)" && brew install node tmux'

# Verify installations
ssh_run 'eval "$(/opt/homebrew/bin/brew shellenv)" && node --version && npm --version && tmux -V'

# Create agend data directory
ssh_run 'mkdir -p ~/.agend/instances'

# Disable spotlight indexing (reduces background CPU)
ssh_run 'sudo mdutil -a -i off' || true

# Shut down the VM gracefully
echo "🛑 Shutting down VM..."
ssh_run 'sudo shutdown -h now' || true

# Wait for VM process to exit
wait $VM_PID 2>/dev/null || true

echo "✅ Golden image '${GOLDEN_IMAGE}' is ready!"
echo ""
echo "To use in tests:"
echo "  tart clone ${GOLDEN_IMAGE} test-vm"
echo "  tart run --no-graphics test-vm"
