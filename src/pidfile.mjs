import { readFile, writeFile, unlink, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";

export function pidFilePath(pidDir, jobId) {
  return resolve(pidDir, `${jobId}.pid`);
}

// Atomic write: temp file → rename to avoid partial reads
export async function writePidFile(pidDir, jobId, pid) {
  await mkdir(pidDir, { recursive: true });
  const path = pidFilePath(pidDir, jobId);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${pid}\n`, "utf8");
  await rename(tmp, path);
}

export async function removePidFile(pidDir, jobId) {
  try {
    await unlink(pidFilePath(pidDir, jobId));
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

// Called at crony startup. Finds stale PID files and removes them.
// Since crony is the owner of these PIDs (it spawns them), any file left over
// at startup means a previous crony instance exited uncleanly.
export async function cleanStalePidFiles(pidDir, jobs, logger) {
  for (const job of jobs) {
    const path = pidFilePath(pidDir, job.id);
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }

    const pid = parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      logger.warn(`[${job.id}] stale pid file (invalid content); removing ${path}`);
      await removePidFile(pidDir, job.id);
      continue;
    }

    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (_) {}

    if (alive) {
      logger.warn(`[${job.id}] pid file contains live PID ${pid} — leftover from previous session; removing ${path}`);
    } else {
      logger.warn(`[${job.id}] stale pid file (PID ${pid} not running); removing ${path}`);
    }
    await removePidFile(pidDir, job.id);
  }
}
