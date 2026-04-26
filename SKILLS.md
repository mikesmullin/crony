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
[weekly-summaries] start schedule=* * * * * at=... planned=...
[weekly-summaries] end status=ok exit=0 signal=none duration=...
```

### 3) Force-run one job and exit

Input:
```bash
crony run weekly-summaries
```

Input with explicit config:
```bash
crony run -f ./crontab.yaml weekly-summaries
```

Expected behavior:
- Ignores cron schedule for this invocation
- Runs exactly one job immediately
- Exits with the child process exit code

Typical output lines:
```text
INFO Force-running job 'weekly-summaries' (schedule ignored)
[weekly-summaries] start schedule=* * * * * at=... planned=...
[weekly-summaries] end status=ok exit=0 signal=none duration=...
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

1. [weekly-summaries] * * * * *  bun
   pwd: /Users/.../agents
   args: weekly-summaries/agent.mjs
   log: logs/weekly-summaries.log
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

Example:
```yaml
jobs:
  - id: weekly-summaries
    schedule: "* * * * *"
    pwd: ~/Workspace/me/agents
    env:
      DEBUG: 1
      NODE_ENV: development
    cmd: bun
    args:
      - weekly-summaries/agent.mjs
    log: logs/weekly-summaries.log
    logrotate: 1M

  - id: logged-hours
    schedule: "0 11 * * 1-5"
    pwd: ~/Workspace/me/agent/
    cmd: plugins/nex/cron/daily-report.sh
```

Validation expectations:
- `id`, `schedule`, `cmd` are required non-empty strings
- `env` must be an object when present; values must be string/number/boolean
- `args` must be an array of strings when present
- `logrotate` can be number of bytes or size string (`K`, `M`, `G`) and requires `log`
- `jobs` must be non-empty
- duplicate `id` values are rejected

## Agent usage tips

- Use `crony list` first to discover valid job IDs before force-running.
- Use `crony run -f <config> <job>` for deterministic one-shot checks.
- Keep `log` configured for long-running jobs so output persists across sessions.
- For shell features (pipes/redirection), set:
  - `cmd: zsh`
  - `args: ["-lc", "<command string>"]`
