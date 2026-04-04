# agend E2E Testing Environment

## Architecture

```
Host (macOS, Apple Silicon)
├── Mock Telegram Bot API    (localhost:<random>)
├── Mock Claude Backend      (mock-claude.mjs via tmux)
├── Tart VM (macOS, headless, SSH)
│   ├── agend (rsync'd from host)
│   ├── fleet.yaml → mock servers via host IP
│   ├── .env (mock bot token)
│   └── tmux session running fleet
└── Test Runner (Vitest)
    ├── Controls mock servers (inject messages, set responses)
    ├── Asserts on mock server call logs
    └── Verifies instance state via filesystem
```

## How It Works

1. **Golden Image**: A Tart macOS VM with Node.js, tmux, and agend dependencies pre-installed.
2. **Mock Servers**: Telegram mock (Express) on the host mimics the Bot API. Mock Claude backend runs inside tmux as part of the fleet.
3. **Test Flow**: `tart clone → tart run --no-graphics → rsync repo → npm ci → vitest → rsync results → tart delete`
4. **No real APIs**: Everything runs locally with fake tokens and mock endpoints.

## Setting Up on Another Machine

### Requirements

- macOS on Apple Silicon (M1/M2/M3/M4). Tart uses Apple's Virtualization.framework which only supports arm64.
- Homebrew installed.

### Installation

```bash
# 1. Install Tart (lightweight macOS VM manager)
brew install cirruslabs/cli/tart

# 2. Install sshpass (for non-interactive SSH to VM)
brew install cirruslabs/cli/sshpass

# 3. Clone the repo and install dependencies
git clone <repo-url>
cd agend
npm ci

# 4. Build the golden VM image (first time only, ~10 min)
#    Downloads macOS Sequoia base image from ghcr.io/cirruslabs,
#    then provisions Node.js + tmux via Homebrew inside the VM.
./e2e/vm-setup/setup-vm.sh

# 5. Run E2E tests
./e2e/scripts/run-e2e.sh
```

### Golden Image Details

`setup-vm.sh` creates an `agend-e2e-golden` image in Tart's local registry:

- **Base**: `ghcr.io/cirruslabs/macos-sequoia-base:latest` (~15 GB download on first run)
- **Provisions**: Homebrew, Node.js, tmux, Spotlight indexing disabled
- **Credentials**: user `admin`, password `admin` (SSH access)
- **Rebuild**: `./e2e/vm-setup/setup-vm.sh --force` to recreate from scratch

Each test run clones this golden image into an ephemeral VM (`agend-e2e-test-<pid>`), which is automatically deleted after tests complete. Use `--keep-vm` to preserve it for debugging.

### Limitations

- **Apple Silicon only** — Tart's Virtualization.framework does not support Intel Macs.
- **No nested virtualization** — cannot run inside another VM or most CI runners.
- **Disk space** — golden image + ephemeral clone requires ~30 GB free.

## Key Design Decisions

- **Mock servers on host, not in VM** — simpler, easier to debug, VM just runs agend.
- **Shell script for VM setup** (not Packer) — KISS, Packer is overkill for local dev.
- **Vitest as test runner** — consistent with existing test infrastructure.
- **VM-only execution** — tests must run inside a VM to prevent host daemon impact.
- **grammy apiRoot override** — grammy `Bot` supports `client.apiRoot` option; we add
  `telegram_api_root` field in `fleet.yaml`'s channel config to redirect API calls to our mock.

## Directory Structure

```
e2e/
├── README.md                          # This file
├── vitest.config.e2e.ts               # E2E-specific Vitest config
├── mock-servers/
│   ├── telegram-mock.ts               # Mock Telegram Bot API
│   ├── mock-claude.mjs                # Mock Claude backend (tmux-based)
│   └── shared.ts                      # Shared utilities (waitFor, sleep, getFreePort)
├── vm-setup/
│   └── setup-vm.sh                    # Golden image provisioning script
├── scripts/
│   └── run-e2e.sh                     # Full E2E test lifecycle (VM only)
├── tests/
│   ├── mock-infrastructure.test.ts    # T1: Mock server + backend verification
│   ├── instance-crud.test.ts          # T3/T4/T13/T14: Instance create/delete/validation
│   ├── adapter-integration.test.ts    # T5/T6: Telegram adapter integration
│   ├── fleet-lifecycle.test.ts        # T1/T2/T5/T6: Fleet start/stop/routing
│   ├── fleet-respawn.test.ts          # T7/T8/T10: Crash respawn, notifications, snapshots
│   ├── log-truncate.test.ts           # T9: Log file truncation
│   ├── cross-instance.test.ts         # T11: Cross-instance communication
│   ├── context-rotation.test.ts       # T12: Context rotation via max_age
│   ├── scheduling.test.ts             # T13: Schedule create/trigger/delete
│   └── workflow-template.test.ts      # T15: Workflow template injection
└── results/                           # Test output (gitignored)
```

## Running Tests

```bash
# Run all E2E tests in VM
./e2e/scripts/run-e2e.sh

# Keep VM after tests (for debugging)
./e2e/scripts/run-e2e.sh --keep-vm

# Run specific test file
./e2e/scripts/run-e2e.sh workflow-template

# Pass extra Vitest flags
./e2e/scripts/run-e2e.sh --reporter=verbose
```

## Manual Verification

Step-by-step guide for manually verifying E2E tests.

### Prerequisites

```bash
# Verify tools are installed
which tart sshpass

# Confirm golden image exists
tart list --quiet | grep agend-e2e-golden
# If missing, build it (~10 min):
./e2e/vm-setup/setup-vm.sh
```

### Run All Tests

```bash
./e2e/scripts/run-e2e.sh
```

Tests run inside an ephemeral Tart VM. The script handles clone, boot, rsync, npm ci, vitest, results collection, and cleanup automatically.

### Run Specific Test File

```bash
# Only run workflow template tests
./e2e/scripts/run-e2e.sh workflow-template

# Only run cross-instance tests
./e2e/scripts/run-e2e.sh cross-instance

# Only run fleet respawn + crash tests
./e2e/scripts/run-e2e.sh fleet-respawn
```

### Debug a Failing Test

Use `--keep-vm` to preserve the VM after tests complete:

```bash
./e2e/scripts/run-e2e.sh --keep-vm fleet-respawn
```

After the run, the script prints the VM name and IP. SSH in to inspect:

```bash
# Find the VM IP
tart ip agend-e2e-test-<pid>

# SSH into the VM (user: admin, password: admin)
sshpass -p admin ssh -o StrictHostKeyChecking=no admin@<VM_IP>

# Inside the VM:
cd ~/agend
ls e2e/results/              # JUnit XML test results
cat /tmp/ae2e-*/instances/*/mcp-instructions.txt  # MCP instructions
cat /tmp/ae2e-*/instances/*/statusline.json       # Instance status
cat /tmp/ae2e-*/instances/*/rotation-state.json   # Rotation snapshots
```

When done, clean up the VM manually:

```bash
tart stop agend-e2e-test-<pid>
tart delete agend-e2e-test-<pid>
```

### View Test Results

Test results are rsync'd back to `e2e/results/` on the host after each run:

```bash
# JUnit XML (for CI integration)
cat e2e/results/junit.xml
```
