import { mkdir, stat, truncate } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const remMs = ms % 1000;
  return `${h}h ${m}m ${sec}s ${remMs}ms`;
}

function relayStreamToConsole(stream, onLine) {
  let carry = "";

  stream.on("data", (chunk) => {
    carry += chunk.toString("utf8");
    const parts = carry.split(/\r?\n/);
    carry = parts.pop() || "";
    for (const line of parts) {
      onLine(line);
    }
  });

  stream.on("end", () => {
    if (carry.length > 0) {
      onLine(carry);
      carry = "";
    }
  });
}

export class Runner {
  constructor({ logger }) {
    this.logger = logger;
    this.active = new Map();
    this.shuttingDown = false;
    this.allowOverlap = false;
  }

  setShuttingDown(value) {
    this.shuttingDown = value;
  }

  activeCount() {
    return this.active.size;
  }

  async run(job, scheduledFor) {
    if (this.shuttingDown) {
      this.logger.jobLine(job.id, "Skipping trigger while shutting down.");
      return { skipped: true };
    }

    if (!this.allowOverlap && this.active.has(job.id)) {
      this.logger.warn(`[${job.id}] previous run still active; skipping overlap trigger.`);
      return { skipped: true };
    }

    const startedAt = Date.now();
    this.logger.jobLine(job.id, `start schedule=${job.schedule} at=${new Date().toISOString()} planned=${scheduledFor.toISOString()}`);

    let outputStream = null;
    if (job.log) {
      const fullLogPath = resolve(job.pwd, job.log);
      await mkdir(dirname(fullLogPath), { recursive: true });

      if (job.logrotateBytes != null) {
        try {
          const info = await stat(fullLogPath);
          if (info.size > job.logrotateBytes) {
            await truncate(fullLogPath, 0);
            this.logger.jobLine(
              job.id,
              `log rotated by truncate (size=${info.size} threshold=${job.logrotateBytes})`
            );
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
      }

      outputStream = createWriteStream(fullLogPath, { flags: "a" });
      outputStream.write(`\n=== [${new Date().toISOString()}] ${job.id} START ===\n`);
    }

    const child = spawn(job.cmd, job.args, {
      cwd: job.pwd,
      env: {
        ...process.env,
        ...(job.env || {})
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    this.active.set(job.id, child);

    if (outputStream) {
      child.stdout.pipe(outputStream, { end: false });
      child.stderr.pipe(outputStream, { end: false });
    } else {
      relayStreamToConsole(child.stdout, (line) => {
        this.logger.jobLine(job.id, `  ${line}`);
      });
      relayStreamToConsole(child.stderr, (line) => {
        this.logger.jobLine(job.id, `  ${line}`);
      });
    }

    return await new Promise((resolvePromise) => {
      let settled = false;
      const finalize = (result) => {
        if (settled) {
          return;
        }
        settled = true;

        const durationMs = Date.now() - startedAt;
        this.active.delete(job.id);

        if (outputStream) {
          outputStream.write(`=== [${new Date().toISOString()}] ${job.id} END exit=${result.exitCode} signal=${result.signal || "none"} duration=${formatDuration(durationMs)} ===\n`);
          outputStream.end();
        }

        const status = result.exitCode === 0 ? "ok" : "failed";
        this.logger.jobLine(job.id, `end status=${status} exit=${result.exitCode} signal=${result.signal || "none"} duration=${formatDuration(durationMs)}`);

        if (result.exitCode !== 0) {
          this.logger.bell();
        }

        resolvePromise({ ...result, durationMs });
      };

      child.on("error", (error) => {
        this.logger.error(`[${job.id}] spawn error: ${error.message}`);
        finalize({ exitCode: 1, signal: null, error });
      });

      child.on("close", (code, signal) => {
        finalize({ exitCode: code ?? 1, signal: signal ?? null });
      });
    });
  }

  async waitForIdle(pollMs = 250) {
    while (this.activeCount() > 0) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  killAll(signal = "SIGTERM") {
    for (const [id, child] of this.active.entries()) {
      try {
        child.kill(signal);
        this.logger.warn(`[${id}] sent ${signal}`);
      } catch (error) {
        this.logger.error(`[${id}] failed to send ${signal}: ${error.message}`);
      }
    }
  }
}
