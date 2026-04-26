const MONTH_NAMES = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
};

const DOW_NAMES = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

function normalizeDow(n) {
  return n === 7 ? 0 : n;
}

function parseSingleValue(raw, names, min, max, fieldName) {
  const lower = raw.toLowerCase();
  if (names && Object.prototype.hasOwnProperty.call(names, lower)) {
    return names[lower];
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${fieldName}: invalid value '${raw}'`);
  }

  const n = Number(raw);
  if (Number.isNaN(n) || n < min || n > max) {
    throw new Error(`${fieldName}: value out of range '${raw}'`);
  }

  return n;
}

function addRange(out, start, end, step, transform) {
  if (start > end) {
    throw new Error(`invalid range ${start}-${end}`);
  }

  for (let v = start; v <= end; v += step) {
    out.add(transform ? transform(v) : v);
  }
}

function parseField(field, { min, max, names, fieldName, transform }) {
  const trimmed = field.trim();
  if (!trimmed) {
    throw new Error(`${fieldName}: empty field`);
  }

  const out = new Set();
  let any = false;

  for (const tokenRaw of trimmed.split(",")) {
    const token = tokenRaw.trim();
    if (!token) {
      throw new Error(`${fieldName}: empty token`);
    }

    let body = token;
    let step = 1;
    if (token.includes("/")) {
      const parts = token.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`${fieldName}: invalid step token '${token}'`);
      }
      body = parts[0];
      if (!/^\d+$/.test(parts[1])) {
        throw new Error(`${fieldName}: invalid step '${parts[1]}'`);
      }
      step = Number(parts[1]);
      if (step <= 0) {
        throw new Error(`${fieldName}: step must be > 0`);
      }
    }

    if (body === "*") {
      any = true;
      addRange(out, min, max, step, transform);
      continue;
    }

    if (body.includes("-")) {
      const parts = body.split("-");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`${fieldName}: invalid range '${body}'`);
      }
      const start = parseSingleValue(parts[0], names, min, max, fieldName);
      const end = parseSingleValue(parts[1], names, min, max, fieldName);
      addRange(out, start, end, step, transform);
      continue;
    }

    if (step !== 1) {
      throw new Error(`${fieldName}: step requires '*' or range`);
    }

    const value = parseSingleValue(body, names, min, max, fieldName);
    out.add(transform ? transform(value) : value);
  }

  if (out.size === 0) {
    throw new Error(`${fieldName}: no values parsed`);
  }

  return { any, values: out };
}

export function compileCron(expression) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("cron expression must have exactly 5 fields");
  }

  const minute = parseField(parts[0], { min: 0, max: 59, fieldName: "minute" });
  const hour = parseField(parts[1], { min: 0, max: 23, fieldName: "hour" });
  const dom = parseField(parts[2], { min: 1, max: 31, fieldName: "day-of-month" });
  const month = parseField(parts[3], {
    min: 1,
    max: 12,
    names: MONTH_NAMES,
    fieldName: "month"
  });
  const dow = parseField(parts[4], {
    min: 0,
    max: 7,
    names: DOW_NAMES,
    fieldName: "day-of-week",
    transform: normalizeDow
  });

  return {
    expression,
    minute,
    hour,
    dom,
    month,
    dow
  };
}

function matchesDomDow(compiled, date) {
  const domMatch = compiled.dom.values.has(date.getDate());
  const dowMatch = compiled.dow.values.has(date.getDay());

  if (compiled.dom.any && compiled.dow.any) {
    return true;
  }

  if (compiled.dom.any) {
    return dowMatch;
  }

  if (compiled.dow.any) {
    return domMatch;
  }

  return domMatch || dowMatch;
}

export function cronMatches(compiled, date) {
  return (
    compiled.minute.values.has(date.getMinutes()) &&
    compiled.hour.values.has(date.getHours()) &&
    compiled.month.values.has(date.getMonth() + 1) &&
    matchesDomDow(compiled, date)
  );
}

export function computeNextRun(compiled, fromDate = new Date()) {
  const next = new Date(fromDate.getTime());
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  const hardLimit = 60 * 24 * 366 * 5;
  for (let i = 0; i < hardLimit; i += 1) {
    if (cronMatches(compiled, next)) {
      return new Date(next.getTime());
    }
    next.setMinutes(next.getMinutes() + 1);
  }

  throw new Error(`could not find next run for '${compiled.expression}' within search window`);
}
