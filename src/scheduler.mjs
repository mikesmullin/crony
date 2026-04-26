import { compileCron, computeNextRun, cronMatches } from "./cron.mjs";

const MAX_TIMEOUT_MS = 2_147_000_000;

function formatAbsolute(date) {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
  const month = new Intl.DateTimeFormat("en-US", { month: "short" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date).replace(" ", "");
  return `${weekday}, ${month} ${day} @ ${time}`;
}

function formatRelative(target, now) {
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) {
    return "now";
  }

  const totalMinutes = Math.ceil(diffMs / 60000);
  if (totalMinutes < 60) {
    return `in ${totalMinutes}min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    if (minutes === 0) {
      return `in ${hours}h`;
    }
    return `in ${hours}h ${minutes}min`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (remHours === 0) {
    return `in ${days}d`;
  }
  return `in ${days}d ${remHours}h`;
}

function setLongTimeout(callback, delayMs) {
  const state = {
    cancelled: false,
    timer: null
  };

  const arm = (remaining) => {
    if (state.cancelled) {
      return;
    }

    const slice = Math.min(remaining, MAX_TIMEOUT_MS);
    state.timer = setTimeout(() => {
      if (state.cancelled) {
        return;
      }

      if (remaining > MAX_TIMEOUT_MS) {
        arm(remaining - MAX_TIMEOUT_MS);
        return;
      }

      callback();
    }, slice);
  };

  arm(delayMs);

  return {
    cancel() {
      state.cancelled = true;
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
  };
}

export class Scheduler {
  constructor({ jobs, onTrigger, logger }) {
    this.jobs = jobs;
    this.onTrigger = onTrigger;
    this.logger = logger;
    this.stopped = false;
    this.pendingTimers = new Map();
    this.compiled = new Map();
    this.runningJobs = new Set();
  }

  verifySchedules() {
    for (const job of this.jobs) {
      try {
        const compiled = compileCron(job.schedule);
        computeNextRun(compiled, new Date());
        this.compiled.set(job.id, compiled);
      } catch (error) {
        throw new Error(`Invalid cron schedule for '${job.id}': ${error.message}`);
      }
    }
  }

  start() {
    this.verifySchedules();
    this.logger.info(`Loaded ${this.jobs.length} job(s). Scheduler running.`);

    const now = new Date();
    const currentMinute = new Date(now.getTime());
    currentMinute.setSeconds(0, 0);

    for (const job of this.jobs) {
      const compiled = this.compiled.get(job.id);
      const immediate = cronMatches(compiled, now);
      const nextAt = immediate ? currentMinute : computeNextRun(compiled, now);
      this.logger.info(
        `[${job.id}] next run ${formatAbsolute(nextAt)} (${formatRelative(nextAt, now)})`
      );

      this.scheduleNext(job, now);

      if (cronMatches(compiled, now)) {
        this.logger.debug(`[${job.id}] matches current minute; running immediately on startup.`);
        void this.triggerJob(job, currentMinute);
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const handle of this.pendingTimers.values()) {
      handle.cancel();
    }
    this.pendingTimers.clear();
  }

  scheduleNext(job, fromDate) {
    if (this.stopped) {
      return;
    }

    const compiled = this.compiled.get(job.id);
    const nextRun = computeNextRun(compiled, fromDate);
    const delayMs = Math.max(0, nextRun.getTime() - Date.now());
    this.logger.debug(`[${job.id}] next run at ${nextRun.toISOString()} (in ${delayMs}ms)`);

    const handle = setLongTimeout(async () => {
      this.pendingTimers.delete(job.id);
      if (this.stopped) {
        return;
      }

      // Keep cron evaluation aligned to schedule by arming the next trigger first.
      this.scheduleNext(job, new Date(nextRun.getTime() + 1000));
      await this.triggerJob(job, nextRun);
    }, delayMs);

    this.pendingTimers.set(job.id, handle);
  }

  async triggerJob(job, scheduledFor) {
    if (this.runningJobs.has(job.id)) {
      this.logger.warn(`[${job.id}] scheduled while previous run is still active; skipping overlap.`);
      return;
    }

    this.runningJobs.add(job.id);

    try {
      await this.onTrigger(job, scheduledFor);
    } catch (error) {
      this.logger.error(`[${job.id}] trigger callback failed: ${error.stack || error.message}`);
    } finally {
      this.runningJobs.delete(job.id);
    }
  }
}
