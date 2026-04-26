import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { Scheduler } from "./scheduler.mjs";
import { Runner } from "./runner.mjs";

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
    - Each job supports: id, schedule, pwd, env, cmd, args, log, logrotate
    - schedule uses 5-field cron syntax: minute hour day month day-of-week
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

function printJobList(configPath, jobs) {
  const title = color("Crony Jobs", 120, 220, 255);
  const cfg = color(configPath, 186, 255, 201);
  const count = color(String(jobs.length), 255, 211, 122);
  process.stdout.write(`${BOLD}${title}${RESET} ${color("from", 160, 160, 160)} ${cfg}\n`);
  process.stdout.write(`${color("Found", 160, 160, 160)} ${count} ${color(jobs.length === 1 ? "job" : "jobs", 160, 160, 160)}\n\n`);

  jobs.forEach((job, index) => {
    const n = color(`${index + 1}.`, 155, 155, 155);
    const schedule = color(job.schedule, 255, 190, 120);
    const cmd = color(job.cmd, 180, 235, 255);
    const log = job.log ? color(job.log, 180, 255, 220) : color("stdout", 190, 190, 190);
    process.stdout.write(`${n} ${logger.jobPrefix(job.id)} ${schedule}  ${cmd}\n`);
    process.stdout.write(`   ${color("pwd:", 140, 140, 140)} ${job.pwd}\n`);
    const envPreview = Object.keys(job.env || {}).length === 0
      ? "(inherits parent only)"
      : Object.entries(job.env).map(([k, v]) => `${k}=${v}`).join(" ");
    process.stdout.write(`   ${color("env:", 140, 140, 140)} ${envPreview}\n`);
    process.stdout.write(`   ${color("args:", 140, 140, 140)} ${job.args.length > 0 ? job.args.join(" ") : "(none)"}\n`);
    process.stdout.write(`   ${color("log:", 140, 140, 140)} ${log}\n`);
    process.stdout.write(`   ${color("logrotate:", 140, 140, 140)} ${job.logrotate || "(off)"}\n`);
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

async function runDaemon(config, configPath) {
  logger.info(`Starting crony scheduler with config=${configPath}`);

  const runner = new Runner({ logger });
  const scheduler = new Scheduler({
    jobs: config.jobs,
    logger,
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

      const active = runner.activeCount();
      if (active === 0) {
        logger.info("Shutdown complete. No active jobs.");
        process.exit(0);
      }

      logger.warn(`Graceful shutdown: waiting for ${active} active job(s). Press Ctrl+C again to force stop.`);
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

  await runDaemon(config, configPath);
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error(error.stack || error.message);
    process.exit(1);
  });
}
