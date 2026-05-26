import { resolve, isAbsolute } from "node:path";

function expandHome(input) {
  if (typeof input !== "string") {
    return input;
  }

  if (input === "~") {
    return process.env.HOME || input;
  }

  if (input.startsWith("~/")) {
    return `${process.env.HOME || "~"}/${input.slice(2)}`;
  }

  return input;
}

function normalizePath(pathValue, baseDir) {
  const expanded = expandHome(pathValue);
  if (!expanded) {
    return null;
  }

  if (isAbsolute(expanded)) {
    return expanded;
  }

  return resolve(baseDir, expanded);
}

function assertString(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
}

function parseSizeToBytes(rawSize, loc) {
  if (rawSize == null) {
    return null;
  }

  if (typeof rawSize === "number") {
    if (!Number.isFinite(rawSize) || rawSize <= 0) {
      throw new Error(`${loc}.logrotate must be a positive number of bytes`);
    }
    return Math.floor(rawSize);
  }

  if (typeof rawSize !== "string") {
    throw new Error(`${loc}.logrotate must be a size string like '1M' or a positive number`);
  }

  const trimmed = rawSize.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)(?:b)?$/i);
  if (!match) {
    throw new Error(`${loc}.logrotate has invalid size '${rawSize}'`);
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${loc}.logrotate must be > 0`);
  }

  const unit = match[2].toUpperCase();
  const multipliers = {
    "": 1,
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024
  };

  return Math.floor(value * multipliers[unit]);
}

function normalizeEnv(rawEnv, loc) {
  if (rawEnv == null) {
    return {};
  }

  if (typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    throw new Error(`${loc}.env must be an object of key/value pairs`);
  }

  const env = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!key || typeof key !== "string") {
      throw new Error(`${loc}.env contains an invalid key`);
    }

    const valueType = typeof value;
    if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
      throw new Error(`${loc}.env.${key} must be a string, number, or boolean`);
    }

    env[key] = String(value);
  }

  return env;
}

function parsePositiveNumber(raw, defaultVal, loc, field) {
  if (raw == null) return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${loc}.${field} must be a positive number`);
  }
  return n;
}

function parseNonNegInt(raw, defaultVal, loc, field) {
  if (raw == null) return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error(`${loc}.${field} must be a non-negative integer`);
  }
  return n;
}

function parseStringArray(raw, loc, field) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`${loc}.${field} must be an array of non-empty strings`);
  }
  return raw.map((v) => v.trim());
}

function parseHealthcheck(raw, loc) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${loc}.healthcheck must be an object`);
  }
  if (typeof raw.cmd !== "string" || !raw.cmd.trim()) {
    throw new Error(`${loc}.healthcheck.cmd must be a non-empty string`);
  }
  return {
    cmd: raw.cmd.trim(),
    interval: parsePositiveNumber(raw.interval, 30, loc, "healthcheck.interval"),
    timeout: parsePositiveNumber(raw.timeout, 5, loc, "healthcheck.timeout"),
    retries: parsePositiveNumber(raw.retries, 3, loc, "healthcheck.retries"),
    start_period: parsePositiveNumber(raw.start_period, 10, loc, "healthcheck.start_period"),
  };
}

const VALID_RESTART = ["never", "on-failure", "always"];

function validateAndNormalizeJob(rawJob, index, projectDir) {
  const loc = `jobs[${index}]`;

  if (!rawJob || typeof rawJob !== "object") {
    throw new Error(`${loc} must be an object`);
  }

  assertString(rawJob.id, `${loc}.id must be a non-empty string`);
  assertString(rawJob.cmd, `${loc}.cmd must be a non-empty string`);

  // schedule is now optional
  const schedule = rawJob.schedule != null ? String(rawJob.schedule).trim() : null;
  if (schedule !== null && schedule.length === 0) {
    throw new Error(`${loc}.schedule must be a non-empty cron string when provided`);
  }

  const autostart = rawJob.autostart === true;

  if (!schedule && !autostart) {
    throw new Error(`${loc}: must have at least 'schedule' or 'autostart: true'`);
  }

  const pwd = normalizePath(rawJob.pwd || projectDir, projectDir);
  const args = rawJob.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new Error(`${loc}.args must be an array of strings`);
  }

  const log = rawJob.log ? String(rawJob.log) : null;
  const env = normalizeEnv(rawJob.env, loc);
  const logrotate = rawJob.logrotate != null ? String(rawJob.logrotate).trim() : null;
  const logrotateBytes = parseSizeToBytes(rawJob.logrotate, loc);

  if (logrotateBytes != null && !log) {
    throw new Error(`${loc}.logrotate requires ${loc}.log to be set`);
  }

  const restart = rawJob.restart != null ? String(rawJob.restart).trim() : "never";
  if (!VALID_RESTART.includes(restart)) {
    throw new Error(`${loc}.restart must be one of: ${VALID_RESTART.join(", ")}`);
  }

  return {
    id: rawJob.id.trim(),
    schedule,
    autostart,
    pwd,
    cmd: rawJob.cmd.trim(),
    args,
    log,
    env,
    logrotate,
    logrotateBytes,
    restart,
    restart_delay: parsePositiveNumber(rawJob.restart_delay, 5, loc, "restart_delay"),
    restart_max: parseNonNegInt(rawJob.restart_max, 0, loc, "restart_max"),
    after: parseStringArray(rawJob.after, loc, "after"),
    requires: parseStringArray(rawJob.requires, loc, "requires"),
    flap_window: parsePositiveNumber(rawJob.flap_window, 60, loc, "flap_window"),
    flap_limit: parseNonNegInt(rawJob.flap_limit, 5, loc, "flap_limit"),
    healthcheck: parseHealthcheck(rawJob.healthcheck, loc),
  };
}

function validateDependencyGraph(jobs) {
  const ids = new Set(jobs.map((j) => j.id));

  for (const job of jobs) {
    for (const dep of [...job.after, ...job.requires]) {
      if (!ids.has(dep)) {
        throw new Error(`Job '${job.id}' depends on unknown job '${dep}'`);
      }
    }
  }

  // Cycle detection via DFS coloring
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(jobs.map((j) => [j.id, WHITE]));
  const depMap = new Map(jobs.map((j) => [j.id, [...j.after, ...j.requires]]));

  const visit = (id, stack) => {
    if (color.get(id) === GRAY) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" → ");
      throw new Error(`Circular dependency detected: ${cycle}`);
    }
    if (color.get(id) === BLACK) return;
    color.set(id, GRAY);
    for (const dep of depMap.get(id) || []) {
      visit(dep, [...stack, id]);
    }
    color.set(id, BLACK);
  };

  for (const job of jobs) {
    visit(job.id, []);
  }
}

export async function loadConfig(configPath, projectDir) {
  const raw = await Bun.file(configPath).text();
  const parsed = Bun.YAML.parse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Config must be a YAML object");
  }

  const rawJobs = parsed.jobs;
  if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
    throw new Error("Config must contain a non-empty jobs array");
  }

  const jobs = rawJobs.map((job, index) => validateAndNormalizeJob(job, index, projectDir));

  const unique = new Set();
  for (const job of jobs) {
    if (unique.has(job.id)) {
      throw new Error(`Duplicate job id '${job.id}'`);
    }
    unique.add(job.id);
  }

  validateDependencyGraph(jobs);

  return { jobs };
}
