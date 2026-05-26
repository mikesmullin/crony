# SKILLS.md

Operator guide for AI agents using crony from the terminal.

## Purpose

Use crony to schedule or manually run jobs defined in a YAML file with cron syntax. This guide focuses on command usage, expected outputs, and config structure.

## Command quick reference

- `crony --help`
- `crony run [-f <config>] [job]`
- `crony list [config]`

## Command behavior

### 1) Show help

Input:
```bash
crony --help
```

Expected output shape:
- Program header (`crony`)
- Usage section
- Commands section (`run`, `list`, `help`)
- Config notes
- Examples

### 2) Start scheduler daemon mode

Input:
```bash
crony run
```

Input with explicit config:
```bash
crony run -f ./crontab.yaml
```

Expected behavior:
- Loads config
- Starts scheduler loop
- Evaluates startup beat immediately
- Runs any job that matches current minute
- Continues running until interrupted

Typical output lines:
```text
INFO Starting crony scheduler with config=/path/to/crontab.yaml
INFO Loaded 2 job(s). Scheduler running.
[daily-report] start schedule=* * * * * at=... planned=...
[daily-report] end status=ok exit=0 signal=none duration=...
```

### 3) Force-run one job and exit

Input:
```bash
crony run daily-report
```

Input with explicit config:
```bash
crony run -f ./crontab.yaml daily-report
```

Expected behavior:
- Ignores cron schedule for this invocation
- Runs exactly one job immediately
- Exits with the child process exit code

Typical output lines:
```text
INFO Force-running job 'daily-report' (schedule ignored)
[daily-report] start schedule=* * * * * at=... planned=...
[daily-report] end status=ok exit=0 signal=none duration=...
```

### 4) List jobs in config

Input:
```bash
crony list
```

Input with explicit config:
```bash
crony list ./crontab.yaml
```

Expected behavior:
- Prints concise, friendly summary with ANSI 24-bit colors
- Shows id, schedule, cmd, pwd, env, args, and log target
- Shows id, schedule, cmd, pwd, env, args, log, and logrotate

Typical output shape:
```text
Crony Jobs from /path/to/crontab.yaml
Found 2 jobs

1. [daily-report] * * * * *  bun
   pwd: /home/user/projects/my-app
   args: scripts/daily-report.mjs
   log: logs/daily-report.log
```

## Scheduler semantics

- Resolution is 1 minute.
- Immediate startup check: jobs matching the current minute can run at startup.
- Overlap protection by job ID:
  - If a job is still running on the next scheduled beat, that beat is skipped.
  - Skips are logged as warnings.
- Child process failures do not crash crony.
- Non-zero child exit triggers terminal bell (`\x07`).

## Signals and shutdown

- First Ctrl+C:
  - Stop scheduling new runs
  - Wait for active jobs to complete
- Second Ctrl+C:
  - Force-kill active child processes
  - Exit immediately

## Config structure

Top-level YAML object with `jobs` array.

### Core fields (all jobs)

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique job identifier |
| `cmd` | yes | Executable to run |
| `schedule` | if no `autostart` | 5-field cron string |
| `autostart` | if no `schedule` | `true` to launch on crony startup |
| `pwd` | no | Working directory (default: config file dir) |
| `args` | no | Array of string arguments |
| `env` | no | Key/value env overrides |
| `log` | no | Log file path (relative to `pwd`); omit to stream to crony stdout |
| `logrotate` | no | Truncate log at start if larger than this size (e.g. `1M`); requires `log` |

### Process supervision fields (autostart jobs)

| Field | Default | Description |
|---|---|---|
| `restart` | `never` | `never` / `on-failure` / `always` |
| `restart_delay` | `5` | Seconds to wait before restarting |
| `restart_max` | `0` | Max restart attempts; `0` = unlimited |
| `after` | `[]` | Wait for listed job IDs to be `running` before starting |
| `requires` | `[]` | Like `after`, but also stop if a dep stops |
| `flap_window` | `60` | Rolling window (seconds) for flap detection |
| `flap_limit` | `5` | Max restarts in `flap_window` before marking job `flapping` |

### Health check fields

```yaml
healthcheck:
  cmd: "curl -sf http://localhost:3000/health"  # required; exit 0 = healthy
  interval: 30      # seconds between probes (default: 30)
  timeout: 5        # seconds before probe is killed as failed (default: 5)
  retries: 3        # consecutive failures before restart (default: 3)
  start_period: 10  # grace period after launch before failures count (default: 10)
```

Example jobs:
```yaml
jobs:
  # Scheduled job — existing behavior, backward compatible
  - id: daily-report
    schedule: "* * * * *"
    pwd: ~/projects/my-app
    env:
      DEBUG: 1
      NODE_ENV: development
    cmd: bun
    args:
      - scripts/daily-report.mjs
    log: logs/daily-report.log
    logrotate: 1M

  # Autostart daemon with restart-on-failure
  - id: my-server
    autostart: true
    restart: on-failure
    restart_delay: 5
    cmd: bun
    args: [server.mjs]
    healthcheck:
      cmd: "curl -sf http://localhost:3000/health"
      interval: 15
      retries: 3
      start_period: 10
    log: logs/server.log

  # Autostart daemon that depends on my-server being up first
  - id: my-worker
    autostart: true
    restart: on-failure
    after: [my-server]
    cmd: bun
    args: [worker.mjs]
    log: logs/worker.log

  # Always-restart tunnel with flap protection
  - id: my-tunnel
    autostart: true
    restart: always
    restart_delay: 5
    flap_window: 60
    flap_limit: 5
    pwd: ~/projects/my-tunnel
    cmd: bun
    args: [tunnel]
    log: logs/my-tunnel.log

  - id: daily-report
    schedule: "0 11 * * 1-5"
    pwd: ~/projects/my-app
    cmd: scripts/daily-report.sh
```

Validation expectations:
- `id` and `cmd` are required non-empty strings
- `schedule` or `autostart: true` must be present (or both)
- `env` must be an object when present; values must be string/number/boolean
- `args` must be an array of strings when present
- `logrotate` can be number of bytes or size string (`K`, `M`, `G`) and requires `log`
- `jobs` must be non-empty
- duplicate `id` values are rejected
- `after`/`requires` references must be valid job IDs; circular deps are rejected

## PID files

crony writes a PID file to `./pid/<job-id>.pid` (relative to the working directory where `crony run` is invoked, same as `crontab.yaml`) for every job while it is running.

- Written atomically (temp file → rename) immediately after the child process is spawned
- Removed when the process exits (clean exit, crash, or SIGTERM)
- At startup, crony scans for leftover PID files from a previous session and removes them, logging a warning for each stale entry found
- The `pid/` directory is created automatically; it is gitignored by default

## Agent usage tips

- Use `crony list` first to discover valid job IDs before force-running.
- Use `crony run -f <config> <job>` for deterministic one-shot checks.
- Keep `log` configured for long-running jobs so output persists across sessions.
- For shell features (pipes/redirection), set:
  - `cmd: zsh`
  - `args: ["-lc", "<command string>"]`
- Autostart jobs with `restart: always` will restart even on clean exit 0 — use `on-failure` for jobs that should stop normally.
- `flap_limit: 0` disables flap protection entirely (not recommended for daemons).

