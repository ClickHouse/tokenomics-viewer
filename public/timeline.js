(function timelineModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TokenomicsTimeline = api;
}(typeof globalThis === "object" ? globalThis : this, function createTimelineApi() {
  "use strict";

  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;
  const MONTH_ESTIMATE_MS = 30 * DAY_MS;
  const YEAR_ESTIMATE_MS = 365 * DAY_MS;
  const WHEEL_ZOOM_FACTOR = 1.16;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function stringHash(value) {
    let hash = 0;
    for (const char of String(value)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    return Math.abs(hash);
  }

  function createCategoricalColorScale(palette) {
    const colors = (palette || []).filter(Boolean);
    const assignments = new Map();
    const usedColors = new Set();
    return function colorFor(value) {
      const key = String(value || "unknown");
      if (assignments.has(key)) return assignments.get(key);
      const hash = stringHash(key);
      let color = null;
      for (let offset = 0; offset < colors.length; offset += 1) {
        const candidate = colors[(hash + offset) % colors.length];
        if (!usedColors.has(candidate)) {
          color = candidate;
          break;
        }
      }
      if (!color) {
        let hue = hash % 360;
        color = `hsl(${hue} 68% 44%)`;
        while (usedColors.has(color)) {
          hue = (hue + 137) % 360;
          color = `hsl(${hue} 68% 44%)`;
        }
      }
      assignments.set(key, color);
      usedColors.add(color);
      return color;
    };
  }

  function rememberBounded(cache, key, value, limit = 2) {
    if (!(cache instanceof Map)) throw new TypeError("rememberBounded requires a Map");
    const capacity = Math.max(1, Math.floor(limit));
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > capacity) cache.delete(cache.keys().next().value);
    return value;
  }

  function nearestPointByX(points, x) {
    let nearest = null;
    let distance = Infinity;
    for (const point of points || []) {
      const candidateDistance = Math.abs(point.x - x);
      if (candidateDistance < distance) {
        nearest = point;
        distance = candidateDistance;
      }
    }
    return nearest;
  }

  function periodStart(name) {
    if (typeof name !== "string") return NaN;
    if (/^\d{4}$/.test(name)) return Date.parse(`${name}-01-01T00:00:00Z`);
    if (/^\d{4}-\d{2}$/.test(name)) return Date.parse(`${name}-01T00:00:00Z`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return Date.parse(`${name}T00:00:00Z`);
    return Date.parse(name);
  }

  function rangeDomain(range = {}) {
    let start;
    let end;
    if (range.mode === "absolute") {
      start = periodStart(range.from);
      end = periodStart(range.to) + DAY_MS;
    } else if (range.calendarMonth) {
      start = Date.parse(range.monthStartAt);
      end = Date.parse(range.monthEndAt);
    } else {
      const availableStart = periodStart(range.availableFrom);
      const availableEnd = periodStart(range.availableTo);
      if (!Number.isFinite(availableEnd)) return null;
      start = Number.isFinite(range.days)
        ? availableEnd - (range.days - 1) * DAY_MS
        : availableStart;
      if (Number.isFinite(availableStart)) start = Math.max(start, availableStart);
      end = availableEnd + DAY_MS;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
    return { start, end };
  }

  function bucketName(name, resolution) {
    if (resolution === "15m") return name;
    if (resolution === "hourly") return `${name.slice(0, 13)}:00Z`;
    if (resolution === "daily") return name.slice(0, 10);
    if (resolution === "weekly") {
      const date = new Date(periodStart(name));
      if (Number.isNaN(date.getTime())) throw new RangeError(`invalid timeline period: ${name}`);
      const daysSinceMonday = (date.getUTCDay() + 6) % 7;
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - daysSinceMonday);
      return date.toISOString().slice(0, 10);
    }
    if (resolution === "monthly") return name.slice(0, 7);
    if (resolution === "yearly") return name.slice(0, 4);
    throw new RangeError(`unsupported timeline resolution: ${resolution}`);
  }

  function resolutionIntervalMs(resolution) {
    if (resolution === "15m") return QUARTER_HOUR_MS;
    if (resolution === "hourly") return HOUR_MS;
    if (resolution === "daily") return DAY_MS;
    if (resolution === "weekly") return WEEK_MS;
    if (resolution === "monthly") return MONTH_ESTIMATE_MS;
    if (resolution === "yearly") return YEAR_ESTIMATE_MS;
    return null;
  }

  function bucketCenter(name, resolution) {
    const start = periodStart(name);
    if (!Number.isFinite(start)) return NaN;
    if (resolution === "monthly") {
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      return start + (end.getTime() - start) / 2;
    }
    if (resolution === "yearly") {
      const end = new Date(start);
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      return start + (end.getTime() - start) / 2;
    }
    const interval = resolutionIntervalMs(resolution);
    return Number.isFinite(interval) ? start + interval / 2 : NaN;
  }

  function chooseAdaptiveResolution(start, end, pointBudget = 160) {
    const span = Math.max(QUARTER_HOUR_MS, end - start);
    const budget = Math.max(1, Math.floor(pointBudget));
    if (span / QUARTER_HOUR_MS <= budget) return "15m";
    if (span / HOUR_MS <= budget) return "hourly";
    if (span / DAY_MS <= Math.min(budget, 90)) return "daily";
    if (span / WEEK_MS <= Math.min(budget, 26)) return "weekly";
    if (span / MONTH_ESTIMATE_MS <= Math.min(budget, 24)) return "monthly";
    return "yearly";
  }

  function domainForRows(rows) {
    const times = (rows || []).map((row) => periodStart(row.name)).filter(Number.isFinite);
    if (!times.length) return null;
    return {
      start: Math.min(...times),
      end: Math.max(...times) + QUARTER_HOUR_MS,
    };
  }

  function tickIndexes(count, target) {
    if (count <= 0 || target <= 0) return [];
    if (count === 1) return [0];
    const steps = Math.min(target, count - 1);
    const seen = new Set();
    for (let index = 0; index <= steps; index += 1) {
      seen.add(Math.round((index * (count - 1)) / steps));
    }
    return [...seen].sort((left, right) => left - right);
  }

  function fitDomain(start, end, full, minSpan = QUARTER_HOUR_MS) {
    const fullSpan = Math.max(minSpan, full.end - full.start);
    const span = clamp(Math.max(minSpan, end - start), minSpan, fullSpan);
    let nextStart = start;
    let nextEnd = nextStart + span;
    if (nextStart < full.start) {
      nextStart = full.start;
      nextEnd = nextStart + span;
    }
    if (nextEnd > full.end) {
      nextEnd = full.end;
      nextStart = nextEnd - span;
    }
    return { start: nextStart, end: nextEnd };
  }

  function zoomDomain(current, full, anchorRatio, direction) {
    const ratio = clamp(anchorRatio, 0, 1);
    const currentSpan = Math.max(QUARTER_HOUR_MS, current.end - current.start);
    const steps = Math.max(1, Math.abs(direction));
    const factor = direction < 0
      ? Math.pow(1 / WHEEL_ZOOM_FACTOR, steps)
      : Math.pow(WHEEL_ZOOM_FACTOR, steps);
    const fullSpan = Math.max(QUARTER_HOUR_MS, full.end - full.start);
    const nextSpan = clamp(currentSpan * factor, QUARTER_HOUR_MS, fullSpan);
    const anchor = current.start + currentSpan * ratio;
    return fitDomain(anchor - nextSpan * ratio, anchor + nextSpan * (1 - ratio), full);
  }

  function selectDomain(current, full, startRatio, endRatio) {
    const left = clamp(Math.min(startRatio, endRatio), 0, 1);
    const right = clamp(Math.max(startRatio, endRatio), 0, 1);
    const span = current.end - current.start;
    return fitDomain(current.start + span * left, current.start + span * right, full);
  }

  function panDomain(current, full, dragRatio) {
    const span = current.end - current.start;
    const offset = span * dragRatio;
    return fitDomain(current.start - offset, current.end - offset, full);
  }

  return {
    QUARTER_HOUR_MS,
    HOUR_MS,
    DAY_MS,
    bucketCenter,
    bucketName,
    chooseAdaptiveResolution,
    createCategoricalColorScale,
    domainForRows,
    nearestPointByX,
    periodStart,
    panDomain,
    rangeDomain,
    rememberBounded,
    resolutionIntervalMs,
    selectDomain,
    tickIndexes,
    zoomDomain,
  };
}));
