import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { Scheduler } from "./scheduler.mjs";
import { Runner } from "./runner.mjs";
import { cleanStalePidFiles } from "./pidfile.mjs";

const logger = new Logger();

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function color(text, r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function usage() {
  process.stdout.write(`crony

Usage:
    crony <command> [options]

Commands:
    run [-f <config>] [job]
                         Start scheduler, or force-run one job and exit
    list [config]        List jobs found in config, then exit
    help                 Show this help text

Options:
    -h, --help           Show this help text

Config Notes:
    - Config file must be YAML with top-level key: jobs
    - Each job supports: id, schedule, autostart, pwd, env, cmd, args, log, logrotate,
      restart, restart_delay, restart_max, after, requires, flap_window, flap_limit, healthcheck
    - schedule uses 5-field cron syntax: minute hour day month day-of-week (optional if autostart)
    - autostart: true  launches the job when crony starts; restart policy keeps it alive
    - restart: never | on-failure | always  (default: never)
    - restart_delay: seconds to wait before restarting (default: 5)
    - restart_max: max restart attempts, 0 = unlimited (default: 0)
    - after: [job-id, ...]  wait for listed jobs to be running before starting this one
    - requires: [job-id, ...]  like after, but also stop if a dep stops
    - flap_window / flap_limit: stop restarting if too many restarts in a time window
    - healthcheck.cmd: shell probe; non-zero exit = unhealthy → process is restarted
    - healthcheck.interval / timeout / retries / start_period control probe behavior
    - If log is omitted, job output is streamed to crony stdout
    - env adds/overrides child process environment variables
    - logrotate truncates a log file at start of run when size exceeds threshold (e.g. 1M)

Examples:
    crony
    crony --help
    crony run
  crony run -f ./crontab.yaml
  crony run weekly-summaries
  crony run -f ./crontab.yaml weekly-summaries
    crony list
    crony list ./crontab.yaml

Use "crony run --help" or "crony list --help" for command-specific help.
`);
}

function runUsage() {
  process.stdout.write(`crony run

Usage:
  crony run [-f <path-to-crontab.yaml>] [job]

Behavior:
  - No job: start scheduler and keep running
  - With job: run that one job immediately (ignore schedule) and exit

Options:
  -f <path>            Config file path (default: ./crontab.yaml)

Examples:
    crony run
  crony run -f ./crontab.yaml
  crony run weekly-summaries
  crony run -f ./crontab.yaml weekly-summaries
`);
}

function listUsage() {
  process.stdout.write(`crony list

Usage:
    crony list [path-to-crontab.yaml]

Examples:
    crony list
    crony list ./crontab.yaml
`);
}

function jobModeLabel(job) {
  if (job.autostart && job.schedule) return color("[autostart+scheduled]", 255, 200, 100);
  if (job.autostart) return color("[autostart]", 120, 255, 160);
  return color("[scheduled]", 120, 200, 255);
}

function printJobList(configPath, jobs) {
  const title = color("Crony Jobs", 120, 220, 255);
  const cfg = color(configPath, 186, 255, 201);
  const count = color(String(jobs.length), 255, 211, 122);
  process.stdout.write(`${BOLD}${title}${RESET} ${color("from", 160, 160, 160)} ${cfg}\n`);
  process.stdout.write(`${color("Found", 160, 160, 160)} ${count} ${color(jobs.length === 1 ? "job" : "jobs", 160, 160, 160)}\n\n`);

  jobs.forEach((job, index) => {
    const n = color(`${index + 1}.`, 155, 155, 155);
    const schedule = job.schedule ? color(job.schedule, 255, 190, 120) : color("(none)", 130, 130, 130);
    const cmd = color(job.cmd, 180, 235, 255);
    const log = job.log ? color(job.log, 180, 255, 220) : color("stdout", 190, 190, 190);
    const mode = jobModeLabel(job);
    process.stdout.write(`${n} ${logger.jobPrefix(job.id)} ${mode} ${schedule}  ${cmd}\n`);
    process.stdout.write(`   ${color("pwd:", 140, 140, 140)} ${job.pwd}\n`);
    const envPreview = Object.keys(job.env || {}).length === 0
      ? "(inherits parent only)"
      : Object.entries(job.env).map(([k, v]) => `${k}=${v}`).join(" ");
    process.stdout.write(`   ${color("env:", 140, 140, 140)} ${envPreview}\n`);
    process.stdout.write(`   ${color("args:", 140, 140, 140)} ${job.args.length > 0 ? job.args.join(" ") : "(none)"}\n`);
    process.stdout.write(`   ${color("log:", 140, 140, 140)} ${log}\n`);
    process.stdout.write(`   ${color("logrotate:", 140, 140, 140)} ${job.logrotate || "(off)"}\n`);
    process.stdout.write(`   ${color("restart:", 140, 140, 140)} ${job.restart}${job.restart !== "never" ? color(` (delay=${job.restart_delay}s max=${job.restart_max === 0 ? "∞" : job.restart_max})`, 160, 160, 160) : ""}\n`);
    if (job.after.length > 0) {
      process.stdout.write(`   ${color("after:", 140, 140, 140)} ${job.after.join(", ")}\n`);
    }
    if (job.requires.length > 0) {
      process.stdout.write(`   ${color("requires:", 140, 140, 140)} ${job.requires.join(", ")}\n`);
    }
    if (job.healthcheck) {
      const hc = job.healthcheck;
      process.stdout.write(`   ${color("healthcheck:", 140, 140, 140)} ${color(hc.cmd, 220, 220, 160)} ${color(`(every ${hc.interval}s, timeout ${hc.timeout}s, retries ${hc.retries}, grace ${hc.start_period}s)`, 150, 150, 150)}\n`);
    }
  });
}

function parseRunArgs(args) {
  let configArg = null;
  let jobId = null;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === "-f") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("run: -f requires a config file path");
      }
      configArg = value;
      i += 1;
      continue;
    }

    if (token === "-h" || token === "--help") {
      return { help: true };
    }

    if (token.startsWith("-")) {
      throw new Error(`run: unknown option '${token}'`);
    }

    if (jobId) {
      throw new Error(`run: unexpected extra argument '${token}'`);
    }

    jobId = token;
  }

  return { help: false, configArg, jobId };
}

async function runDaemon(config, configPath, projectDir) {
  logger.info(`Starting crony scheduler with config=${configPath}`);

  const pidDir = resolve(projectDir, "pid");
  await cleanStalePidFiles(pidDir, config.jobs, logger);

  const runner = new Runner({ logger, pidDir });
  const scheduler = new Scheduler({
    jobs: config.jobs,
    logger,
    onAutostart: (job) => runner.supervise(job),
    onTrigger: async (job, nextRun) => {
      try {
        await runner.run(job, nextRun);
      } catch (error) {
        logger.error(`[${job.id}] unhandled run error: ${error.stack || error.message}`);
      }
    }
  });

  let sigintCount = 0;
  let shutdownStarted = false;

  const gracefulShutdown = async () => {
    if (!shutdownStarted) {
      shutdownStarted = true;
      runner.setShuttingDown(true);
      scheduler.stop();

      const activeAutostart = runner.activeCount((job) => job.autostart);
      const activeScheduled = runner.activeCount((job) => !job.autostart);

      if (activeAutostart === 0 && activeScheduled === 0) {
        logger.info("Shutdown complete. No active jobs.");
        process.exit(0);
      }

      if (activeAutostart > 0) {
        logger.warn(`Graceful shutdown: sending SIGTERM to ${activeAutostart} supervised job(s).`);
        runner.killAll("SIGTERM", (job) => job.autostart);
      }
      if (activeScheduled > 0) {
        logger.warn(`Graceful shutdown: waiting for ${activeScheduled} scheduled job(s) to finish.`);
      }
      if (activeAutostart > 0 || activeScheduled > 0) {
        logger.warn("Press Ctrl+C again to force kill.");
      }

      await runner.waitForIdle();
      logger.info("All active jobs completed. Exiting.");
      process.exit(0);
      return;
    }

    const active = runner.activeCount();
    logger.error(`Force shutdown requested. Killing ${active} active job(s).`);
    runner.killAll("SIGKILL");
    process.exit(130);
  };

  process.on("SIGINT", () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      void gracefulShutdown();
      return;
    }

    void gracefulShutdown();
  });

  process.on("SIGTERM", () => {
    void gracefulShutdown();
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${reason?.stack || reason}`);
  });

  process.on("uncaughtException", (error) => {
    logger.error(`Uncaught exception: ${error.stack || error.message}`);
  });

  scheduler.start();
}

async function runSingleJob(config, jobId) {
  const job = config.jobs.find((j) => j.id === jobId);
  if (!job) {
    throw new Error(`run: job '${jobId}' not found in config`);
  }

  logger.info(`Force-running job '${job.id}' (schedule ignored)`);
  const runner = new Runner({ logger });
  const result = await runner.run(job, new Date());
  if (result.skipped) {
    process.exit(1);
  }
  if ((result.exitCode ?? 1) !== 0) {
    process.exit(result.exitCode ?? 1);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = argv;

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    usage();
    return;
  }

  if (args[0] === "help") {
    usage();
    return;
  }

  if (args[0] === "list" && (args[1] === "-h" || args[1] === "--help")) {
    listUsage();
    return;
  }

  if (args[0] === "list") {
    const projectDir = process.cwd();
    const configPath = resolve(projectDir, args[1] || "crontab.yaml");
    const config = await loadConfig(configPath, projectDir);
    printJobList(configPath, config.jobs);
    return;
  }

  if (args[0] !== "run") {
    usage();
    throw new Error(`unknown command '${args[0]}'`);
  }

  const runArgs = parseRunArgs(args.slice(1));
  if (runArgs.help) {
    runUsage();
    return;
  }

  const projectDir = process.cwd();
  const configPath = resolve(projectDir, runArgs.configArg || "crontab.yaml");
  const config = await loadConfig(configPath, projectDir);

  if (runArgs.jobId) {
    await runSingleJob(config, runArgs.jobId);
    return;
  }

  await runDaemon(config, configPath, projectDir);
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error(error.stack || error.message);
    process.exit(1);
  });
}
