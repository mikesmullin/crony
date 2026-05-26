# crony

Lightweight cron-like scheduler for Bun that you run from your own shell session.

## Why this exists

System cron typically runs with a minimal environment, which can break scripts that depend on your normal `PATH`, cert variables, or shell setup. `crony` runs under your logged-in user context and keeps running as a foreground process.

## Features

- Zero external dependencies (no `node_modules` required)
- Traditional 5-field cron syntax per job (`schedule`)
- YAML config file (`crontab.yaml`)
- Child process execution via `child_process.spawn()`
- Per-job `env` overlay support (adds/overrides parent process env)
- Immediate startup evaluation: jobs matching the current minute can run right away
- No-overlap gate per job ID: if a prior run is still active, next beat is skipped
- Optional per-job file logging, otherwise output streams to `crony` stdout
- Job lifecycle logs: start, end, duration, exit code, signal
- Non-zero exit triggers terminal bell (`\x07`)
- Graceful shutdown on first Ctrl+C; force-kill on second Ctrl+C
- **Process supervision** — `autostart: true` jobs launch at startup and are kept alive
- **Restart policies** — `restart: never | on-failure | always` with configurable delay and max attempts
- **Dependency ordering** — `after`/`requires` ensure jobs start in the right sequence
- **Flapping protection** — stops restarting jobs that crash-loop too frequently
- **Health checks** — periodic shell probe; unhealthy processes are automatically restarted
- **PID files** — each running job writes `pid/<job-id>.pid`; stale files are cleaned up at startup

## Installation

```bash
bun install
bun link

crony --help
```

## Operations Guide

For CLI usage, command input/output examples, configuration structure, and runtime behavior details, see [SKILLS.md](SKILLS.md).

## Shutdown behavior

- First Ctrl+C: stop scheduling new triggers and wait for active jobs to finish.
- Second Ctrl+C: force-kill active child processes and exit.
