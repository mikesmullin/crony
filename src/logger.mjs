const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[38;2;255;95;95m";
const YELLOW = "\x1b[38;2;255;190;92m";
const CYAN = "\x1b[38;2;120;220;255m";

function hashString(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function colorFromId(id) {
  const h = hashString(id);
  const r = 80 + (h & 0x7f);
  const g = 80 + ((h >> 8) & 0x7f);
  const b = 80 + ((h >> 16) & 0x7f);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function nowStamp() {
  return new Date().toISOString();
}

export class Logger {
  constructor(level = process.env.CRONY_LOG_LEVEL || "info") {
    this.level = level;
    this.levelRank = {
      debug: 10,
      info: 20,
      warn: 30,
      error: 40
    };
  }

  shouldLog(level) {
    return this.levelRank[level] >= this.levelRank[this.level];
  }

  line(level, message) {
    if (!this.shouldLog(level)) {
      return;
    }

    const color = level === "error" ? RED : level === "warn" ? YELLOW : level === "debug" ? DIM : CYAN;
    process.stdout.write(`${DIM}${nowStamp()}${RESET} ${color}${level.toUpperCase()}${RESET} ${message}\n`);
  }

  debug(message) {
    this.line("debug", message);
  }

  info(message) {
    this.line("info", message);
  }

  warn(message) {
    this.line("warn", message);
  }

  error(message) {
    this.line("error", message);
  }

  jobPrefix(id) {
    return `${BOLD}${colorFromId(id)}[${id}]${RESET}`;
  }

  jobLine(id, message) {
    process.stdout.write(`${this.jobPrefix(id)} ${message}\n`);
  }

  bell() {
    process.stdout.write("\x07");
  }
}
