import { mkdir, stat, truncate } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { HealthChecker } from "./health.mjs";
import { writePidFile, removePidFile } from "./pidfile.mjs";

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
  constructor({ logger, pidDir = null }) {
    this.logger = logger;
    this.pidDir = pidDir;
    this.active = new Map();
    this.shuttingDown = false;
    this.allowOverlap = false;
    // Process supervision state
    this.jobStatus = new Map();    // jobId -> 'idle'|'running'|'stopped'|'flapping'
    this.restartData = new Map();  // jobId -> { count, timestamps[] }
    this._statusListeners = [];
    this._sleepTimers = new Set();
  }

  setShuttingDown(value) {
    this.shuttingDown = value;
    if (value) {
      // Wake all supervise loops that are sleeping between restarts
      for (const timer of this._sleepTimers) {
        clearTimeout(timer);
      }
      this._sleepTimers.clear();
    }
  }

  activeCount(filter = null) {
    if (!filter) return this.active.size;
    let n = 0;
    for (const { job } of this.active.values()) {
      if (filter(job)) n++;
    }
    return n;
  }

  getStatus(jobId) {
    return this.jobStatus.get(jobId) || "idle";
  }

  onStatusChange(cb) {
    this._statusListeners.push(cb);
  }

  _setStatus(jobId, status) {
    this.jobStatus.set(jobId, status);
    for (const cb of this._statusListeners) {
      try { cb(jobId, status); } catch (_) {}
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._sleepTimers.delete(timer);
        resolve();
      }, ms);
      this._sleepTimers.add(timer);
    });
  }

  // Wait until all dep jobs are running; returns false if a dep fails or we're shutting down
  async _waitForDeps(job) {
    const deps = [...(job.after || []), ...(job.requires || [])];
    if (deps.length === 0) return true;

    const pending = new Set(deps);
    while (!this.shuttingDown && pending.size > 0) {
      for (const depId of [...pending]) {
        const s = this.jobStatus.get(depId);
        if (s === "running") {
          pending.delete(depId);
        } else if (s === "stopped" || s === "flapping") {
          this.logger.warn(`[${job.id}] dependency '${depId}' is ${s}; aborting start`);
          return false;
        }
      }
      if (pending.size > 0) {
        await this._sleep(250);
      }
    }
    return !this.shuttingDown;
  }

  // Manage full lifecycle of an autostart/supervised job (loops until shutdown or policy exhausted)
  async supervise(job) {
    this._setStatus(job.id, "idle");
    this.restartData.set(job.id, { count: 0, timestamps: [] });

    while (!this.shuttingDown) {
      const depsReady = await this._waitForDeps(job);
      if (!depsReady || this.shuttingDown) break;

      this._setStatus(job.id, "running");

      let healthChecker = null;
      if (job.healthcheck) {
        healthChecker = new HealthChecker({
          job,
          logger: this.logger,
          onUnhealthy: () => {
            const entry = this.active.get(job.id);
            if (entry) {
              try { entry.child.kill("SIGTERM"); } catch (_) {}
            }
          },
        });
      }

      const result = await this.run(job, new Date(), {
        onSpawned: healthChecker ? () => healthChecker.start() : null,
      });

      if (healthChecker) {
        healthChecker.stop();
      }

      this._setStatus(job.id, "stopped");

      if (this.shuttingDown || result.skipped) break;

      // Check restart policy
      const { restart } = job;
      if (restart === "never") break;
      if (restart === "on-failure" && (result.exitCode ?? 0) === 0) break;

      // If a requires dep has stopped, don't restart
      const goneRequires = (job.requires || []).find((depId) => {
        const s = this.jobStatus.get(depId);
        return s === "stopped" || s === "flapping";
      });
      if (goneRequires) {
        this.logger.warn(`[${job.id}] required dependency '${goneRequires}' is stopped; halting restarts`);
        break;
      }

      // Flapping check: track restart timestamps in a rolling window
      const rd = this.restartData.get(job.id);
      const nowMs = Date.now();
      const windowMs = job.flap_window * 1000;
      rd.timestamps.push(nowMs);
      rd.timestamps = rd.timestamps.filter((t) => nowMs - t < windowMs);

      if (job.flap_limit > 0 && rd.timestamps.length > job.flap_limit) {
        this.logger.warn(
          `[${job.id}] flapping detected (${rd.timestamps.length} restarts in ${job.flap_window}s window); giving up`
        );
        this._setStatus(job.id, "flapping");
        break;
      }

      // restart_max check (0 = unlimited)
      rd.count++;
      if (job.restart_max > 0 && rd.count > job.restart_max) {
        this.logger.warn(`[${job.id}] reached restart_max=${job.restart_max}; giving up`);
        break;
      }

      this.logger.info(`[${job.id}] restarting in ${job.restart_delay}s (attempt=${rd.count})`);
      await this._sleep(job.restart_delay * 1000);
    }

    if (this.jobStatus.get(job.id) !== "flapping") {
      this._setStatus(job.id, "stopped");
    }
  }

  async run(job, scheduledFor, { onSpawned } = {}) {
    if (this.shuttingDown) {
      this.logger.jobLine(job.id, "Skipping trigger while shutting down.");
      return { skipped: true };
    }

    if (!this.allowOverlap && this.active.has(job.id)) {
      this.logger.warn(`[${job.id}] previous run still active; skipping overlap trigger.`);
      return { skipped: true };
    }

    const startedAt = Date.now();
    this.logger.jobLine(job.id, `start schedule=${job.schedule ?? "none"} at=${new Date().toISOString()} planned=${scheduledFor.toISOString()}`);

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

    this.active.set(job.id, { child, job });

    if (this.pidDir && child.pid != null) {
      writePidFile(this.pidDir, job.id, child.pid).catch((err) => {
        this.logger.warn(`[${job.id}] failed to write pid file: ${err.message}`);
      });
    }

    if (onSpawned) {
      try { onSpawned(); } catch (_) {}
    }

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

        if (this.pidDir) {
          removePidFile(this.pidDir, job.id).catch(() => {});
        }

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

  killAll(signal = "SIGTERM", filter = null) {
    for (const [id, { child, job }] of this.active.entries()) {
      if (filter && !filter(job)) continue;
      try {
        child.kill(signal);
        this.logger.warn(`[${id}] sent ${signal}`);
      } catch (error) {
        this.logger.error(`[${id}] failed to send ${signal}: ${error.message}`);
      }
    }
  }
}
