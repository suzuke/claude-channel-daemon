#!/usr/bin/env bash
#
# E2E test lifecycle runner.
#
# Manages the full cycle: clone VM → start VM → run tests → cleanup.
# Can also run tests without VM (mock-only mode) for faster iteration.
#
# Usage:
#   ./e2e/scripts/run-e2e.sh              # Full E2E with VM
#   ./e2e/scripts/run-e2e.sh --no-vm      # Mock-only (no Tart VM)
#   ./e2e/scripts/run-e2e.sh --keep-vm    # Don't delete VM after tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GOLDEN_IMAGE="agend-e2e-golden"
TEST_VM="agend-e2e-test-$$"
VM_PID=""

NO_VM=false
KEEP_VM=false
VITEST_ARGS=()

# Parse our flags separately from Vitest args
for arg in "$@"; do
  case "$arg" in
    --no-vm)   NO_VM=true ;;
    --keep-vm) KEEP_VM=true ;;
    *)         VITEST_ARGS+=("$arg") ;;
  esac
done

cleanup() {
  if [[ "$NO_VM" == "false" ]]; then
    echo "🧹 Cleaning up VM..."
    tart stop "$TEST_VM" 2>/dev/null || true
    [[ -n "$VM_PID" ]] && kill "$VM_PID" 2>/dev/null || true
    if [[ "$KEEP_VM" == "false" ]]; then
      tart delete "$TEST_VM" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

if [[ "$NO_VM" == "false" ]]; then
  # Ensure golden image exists
  if ! tart list --quiet 2>/dev/null | grep -q "^${GOLDEN_IMAGE}$"; then
    echo "📦 Golden image not found. Building..."
    "$SCRIPT_DIR/../vm-setup/setup-vm.sh"
  fi

  echo "🔄 Cloning test VM from golden image..."
  tart clone "$GOLDEN_IMAGE" "$TEST_VM"

  echo "🚀 Starting test VM..."
  tart run --no-graphics "$TEST_VM" &
  VM_PID=$!

  # Wait for SSH to be actually reachable (not just IP assigned)
  echo "⏳ Waiting for VM SSH..."
  MAX_WAIT=60
  ELAPSED=0
  SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=2)
  while true; do
    VM_IP=$(tart ip "$TEST_VM" 2>/dev/null || echo "")
    if [[ -n "$VM_IP" ]] && sshpass -p admin ssh "${SSH_OPTS[@]}" "admin@${VM_IP}" "exit 0" &>/dev/null; then
      break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    if [[ $ELAPSED -ge $MAX_WAIT ]]; then
      echo "❌ VM SSH not ready within ${MAX_WAIT}s"
      exit 1
    fi
  done

  export E2E_VM_NAME="$TEST_VM"
  export E2E_VM_IP="$VM_IP"
  echo "✅ VM ready at $E2E_VM_IP"
fi

echo "🧪 Running E2E tests..."
cd "$PROJECT_ROOT"
npx vitest run --config e2e/vitest.config.e2e.ts "${VITEST_ARGS[@]}"
TEST_EXIT=$?

echo ""
if [[ $TEST_EXIT -eq 0 ]]; then
  echo "✅ All E2E tests passed!"
else
  echo "❌ Some E2E tests failed (exit code: $TEST_EXIT)"
fi

exit $TEST_EXIT
