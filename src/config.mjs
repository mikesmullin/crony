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

function validateAndNormalizeJob(rawJob, index, projectDir) {
  const loc = `jobs[${index}]`;

  if (!rawJob || typeof rawJob !== "object") {
    throw new Error(`${loc} must be an object`);
  }

  assertString(rawJob.id, `${loc}.id must be a non-empty string`);
  assertString(rawJob.schedule, `${loc}.schedule must be a non-empty cron string`);
  assertString(rawJob.cmd, `${loc}.cmd must be a non-empty string`);

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

  return {
    id: rawJob.id.trim(),
    schedule: rawJob.schedule.trim(),
    pwd,
    cmd: rawJob.cmd.trim(),
    args,
    log,
    env,
    logrotate,
    logrotateBytes
  };
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

  return { jobs };
}
