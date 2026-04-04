# CLAUDE.md

## Design Principles

"Keep it Simple, Stupid" (KISS) and "Less is More"

## E2E Testing

- New features must include corresponding E2E tests in `e2e/tests/`.
- E2E tests run exclusively inside Tart VMs. Never run them directly on the host.
- See `e2e/README.md` for setup and architecture details.
