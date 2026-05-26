import { spawn } from "node:child_process";

export class HealthChecker {
  constructor({ job, logger, onUnhealthy }) {
    this.job = job;
    this.logger = logger;
    this.onUnhealthy = onUnhealthy;
    this.stopped = false;
    this.consecutiveFailures = 0;
    this._startTimer = null;
    this._probeTimer = null;
  }

  start() {
    const hc = this.job.healthcheck;
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      if (!this.stopped) {
        this._scheduleNextProbe();
      }
    }, hc.start_period * 1000);
  }

  stop() {
    this.stopped = true;
    if (this._startTimer) {
      clearTimeout(this._startTimer);
      this._startTimer = null;
    }
    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
    }
  }

  _scheduleNextProbe() {
    if (this.stopped) return;
    const hc = this.job.healthcheck;
    this._probeTimer = setTimeout(async () => {
      this._probeTimer = null;
      if (this.stopped) return;
      await this._runProbe();
      this._scheduleNextProbe();
    }, hc.interval * 1000);
  }

  async _runProbe() {
    if (this.stopped) return;
    const hc = this.job.healthcheck;
    const healthy = await this._spawnProbe(hc.cmd, hc.timeout);
    if (this.stopped) return;

    if (healthy) {
      if (this.consecutiveFailures > 0) {
        this.logger.debug(`[${this.job.id}] health probe recovered`);
      }
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures++;
      this.logger.warn(
        `[${this.job.id}] health probe failed (${this.consecutiveFailures}/${hc.retries})`
      );
      if (this.consecutiveFailures >= hc.retries) {
        this.logger.warn(
          `[${this.job.id}] unhealthy (${this.consecutiveFailures} consecutive failures); killing and restarting`
        );
        this.stop();
        this.onUnhealthy();
      }
    }
  }

  async _spawnProbe(cmd, timeoutSecs) {
    return new Promise((resolve) => {
      let done = false;

      const child = spawn(cmd, [], {
        shell: true,
        cwd: this.job.pwd,
        env: { ...process.env, ...(this.job.env || {}) },
        stdio: "ignore",
      });

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          try { child.kill(); } catch (_) {}
          resolve(false);
        }
      }, timeoutSecs * 1000);

      child.on("close", (code) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(code === 0);
        }
      });

      child.on("error", () => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
  }
}
