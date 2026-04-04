#!/usr/bin/env bash
#
# E2E test lifecycle runner — runs tests inside a Tart VM for isolation.
#
# Steps:
#   1. Clone golden image → ephemeral test VM
#   2. rsync repo into VM
#   3. npm ci inside VM
#   4. Run vitest inside VM via SSH
#   5. rsync test results back to host
#   6. Cleanup VM
#
# Usage:
#   ./e2e/scripts/run-e2e.sh              # Run E2E tests inside VM
#   ./e2e/scripts/run-e2e.sh --keep-vm    # Don't delete VM after tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GOLDEN_IMAGE="agend-e2e-golden"
TEST_VM="agend-e2e-test-$$"
VM_PID=""
VM_IP=""

KEEP_VM=false
VITEST_ARGS=()

# Parse our flags separately from Vitest args
for arg in "$@"; do
  case "$arg" in
    --keep-vm) KEEP_VM=true ;;
    *)         VITEST_ARGS+=("$arg") ;;
  esac
done

# --- SSH helpers ---
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10)

ssh_run() {
  sshpass -p admin ssh "${SSH_OPTS[@]}" "admin@${VM_IP}" "$@"
}

rsync_to_vm() {
  sshpass -p admin rsync -az --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.tart' \
    --exclude='*.tgz' \
    --exclude='.env*' \
    --exclude='e2e/results' \
    -e "ssh ${SSH_OPTS[*]}" \
    "$1" "admin@${VM_IP}:$2"
}

rsync_from_vm() {
  sshpass -p admin rsync -az \
    -e "ssh ${SSH_OPTS[*]}" \
    "admin@${VM_IP}:$1" "$2"
}

# --- Cleanup ---
cleanup() {
  if [[ -n "$VM_PID" ]]; then
    echo "🧹 Cleaning up VM..."
    # Try to rsync results back before stopping (best-effort)
    if [[ -n "$VM_IP" ]]; then
      mkdir -p "${PROJECT_ROOT}/e2e/results"
      rsync_from_vm "~/agend/e2e/results/" "${PROJECT_ROOT}/e2e/results/" 2>/dev/null || true
    fi
    tart stop "$TEST_VM" 2>/dev/null || true
    kill "$VM_PID" 2>/dev/null || true
    if [[ "$KEEP_VM" == "false" ]]; then
      tart delete "$TEST_VM" 2>/dev/null || true
    else
      echo "💡 VM kept: $TEST_VM (IP: ${VM_IP:-unknown})"
    fi
  fi
}
trap cleanup EXIT INT TERM

# --- VM mode: full isolation ---

# 1. Ensure golden image exists
if ! tart list --quiet 2>/dev/null | grep -q "^${GOLDEN_IMAGE}$"; then
  echo "📦 Golden image not found. Building..."
  "$SCRIPT_DIR/../vm-setup/setup-vm.sh"
fi

# 2. Clone and start VM
echo "🔄 Cloning test VM from golden image..."
tart clone "$GOLDEN_IMAGE" "$TEST_VM"

echo "🚀 Starting test VM..."
tart run --no-graphics "$TEST_VM" &
VM_PID=$!

# 3. Wait for SSH
echo "⏳ Waiting for VM SSH..."
MAX_WAIT=60
ELAPSED=0
while true; do
  VM_IP=$(tart ip "$TEST_VM" 2>/dev/null || echo "")
  if [[ -n "$VM_IP" ]] && sshpass -p admin ssh "${SSH_OPTS[@]}" -o ConnectTimeout=2 "admin@${VM_IP}" "exit 0" &>/dev/null; then
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo "❌ VM SSH not ready within ${MAX_WAIT}s"
    exit 1
  fi
done
echo "✅ VM ready at $VM_IP"

# 4. rsync repo into VM
echo "📦 Syncing repo to VM..."
ssh_run "mkdir -p ~/agend"
rsync_to_vm "${PROJECT_ROOT}/" "~/agend/"
echo "✅ Repo synced"

# 5. npm ci inside VM
echo "📦 Installing dependencies in VM..."
ssh_run 'eval "$(/opt/homebrew/bin/brew shellenv)" && cd ~/agend && npm ci' 2>&1
echo "✅ Dependencies installed"

# 6. Run vitest inside VM
echo "🧪 Running E2E tests in VM..."
set +e
ssh_run "eval \"\$(/opt/homebrew/bin/brew shellenv)\" && cd ~/agend && mkdir -p e2e/results && npx vitest run --config e2e/vitest.config.e2e.ts ${VITEST_ARGS[*]+"${VITEST_ARGS[*]}"}" 2>&1
TEST_EXIT=$?
set -e

# 7. rsync results back to host
echo "📥 Fetching test results..."
mkdir -p "${PROJECT_ROOT}/e2e/results"
rsync_from_vm "~/agend/e2e/results/" "${PROJECT_ROOT}/e2e/results/" 2>/dev/null || true

echo ""
if [[ $TEST_EXIT -eq 0 ]]; then
  echo "✅ All E2E tests passed!"
else
  echo "❌ Some E2E tests failed (exit code: $TEST_EXIT)"
fi

exit $TEST_EXIT
