#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const outputRoot = process.env.STATUS_OUTPUT_DIR
  ? join(process.cwd(), process.env.STATUS_OUTPUT_DIR)
  : repoRoot;

const STATUSES = new Set(["up", "degraded", "down"]);
const WORST_STATUS_RANK = { up: 0, degraded: 1, down: 2 };
const MAX_DAILY_BUCKETS = 90;
const RAW_RETENTION_DAYS = 91;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcNow() {
  return new Date();
}

function isoDate(date) {
  return date.toISOString();
}

function utcDay(value) {
  return value.slice(0, 10);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, round2(value)));
}

function normalizeStatus(value) {
  return STATUSES.has(value) ? value : "down";
}

function normalizeLatency(value, fallback) {
  const candidate = Number(value);
  if (Number.isFinite(candidate) && candidate >= 0)
    return Math.round(candidate);
  return Math.max(0, Math.round(fallback));
}

function normalizeIso(value, fallback) {
  if (typeof value !== "string") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function worstStatus(statuses) {
  return statuses.reduce(
    (worst, status) =>
      WORST_STATUS_RANK[status] > WORST_STATUS_RANK[worst] ? status : worst,
    "up",
  );
}

function interpolateEnv(value) {
  return value.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_, name) => process.env[name] ?? "",
  );
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function loadConfig() {
  const config = await readJson(join(repoRoot, "config.json"), null);
  if (!config || !Array.isArray(config.services)) {
    throw new Error("config.json must define a services array");
  }
  return {
    ...config,
    baseUrl: (
      process.env.BASE_URL ||
      config.baseUrl ||
      "https://craftrfp.com"
    ).replace(/\/+$/, ""),
    timeoutMs: Number(config.timeoutMs) || 10000,
  };
}

function serviceHeaders(service) {
  const headers = {};
  for (const [key, value] of Object.entries(service.headers ?? {})) {
    headers[key] = interpolateEnv(String(value));
  }
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return { response, measuredLatency: performance.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkMarketing(service, config, checkedAt) {
  const url = new URL(service.path, config.baseUrl).toString();
  const { response, measuredLatency } = await fetchWithTimeout(
    url,
    { headers: serviceHeaders(service) },
    config.timeoutMs,
  );
  return {
    status: response.status === (service.expectStatus ?? 200) ? "up" : "down",
    latency_ms: normalizeLatency(null, measuredLatency),
    checked_at: checkedAt,
  };
}

async function checkProbe(service, config, checkedAt) {
  const url = new URL(service.path, config.baseUrl).toString();
  const { response, measuredLatency } = await fetchWithTimeout(
    url,
    { headers: serviceHeaders(service) },
    config.timeoutMs,
  );

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (response.status === 503) {
    return {
      status: "down",
      latency_ms: normalizeLatency(body.latency_ms, measuredLatency),
      checked_at: normalizeIso(body.checked_at, checkedAt),
    };
  }

  if (!response.ok) {
    return {
      status: "down",
      latency_ms: normalizeLatency(body.latency_ms, measuredLatency),
      checked_at: normalizeIso(body.checked_at, checkedAt),
    };
  }

  return {
    status: normalizeStatus(body.status),
    latency_ms: normalizeLatency(body.latency_ms, measuredLatency),
    checked_at: normalizeIso(body.checked_at, checkedAt),
  };
}

async function checkService(service, config, checkedAt) {
  try {
    const result =
      service.id === "marketing"
        ? await checkMarketing(service, config, checkedAt)
        : await checkProbe(service, config, checkedAt);
    return [service.id, result];
  } catch {
    return [
      service.id,
      {
        status: "down",
        latency_ms: null,
        checked_at: checkedAt,
      },
    ];
  }
}

function trimRawChecks(checks, now) {
  const cutoff = now.getTime() - RAW_RETENTION_DAYS * DAY_MS;
  return checks
    .filter((check) => {
      const time = new Date(check.checked_at).getTime();
      return (
        Number.isFinite(time) && time >= cutoff && STATUSES.has(check.status)
      );
    })
    .sort((a, b) => a.checked_at.localeCompare(b.checked_at));
}

function dailyFromChecks(service, checks) {
  const byDate = new Map();
  for (const check of checks) {
    const date = utcDay(check.checked_at);
    const bucket = byDate.get(date) ?? { statuses: [], up: 0, total: 0 };
    bucket.statuses.push(check.status);
    bucket.total += 1;
    if (check.status === "up") bucket.up += 1;
    byDate.set(date, bucket);
  }

  return {
    service,
    daily: [...byDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-MAX_DAILY_BUCKETS)
      .map(([date, bucket]) => ({
        date,
        status: worstStatus(bucket.statuses),
        uptime_pct: clampPercent((bucket.up / bucket.total) * 100),
      })),
  };
}

function uptime24h(checks, now) {
  const cutoff = now.getTime() - DAY_MS;
  const recent = checks.filter(
    (check) => new Date(check.checked_at).getTime() >= cutoff,
  );
  if (recent.length === 0) return 0;
  return clampPercent(
    (recent.filter((check) => check.status === "up").length / recent.length) *
      100,
  );
}

function uptime90d(history) {
  if (history.daily.length === 0) return 0;
  return clampPercent(
    history.daily.reduce((sum, day) => sum + day.uptime_pct, 0) /
      history.daily.length,
  );
}

async function updateServiceHistory(service, snapshot, now) {
  const rawPath = join(outputRoot, "history", ".raw", `${service}.json`);
  const historyPath = join(outputRoot, "history", `${service}.json`);
  const raw = await readJson(rawPath, { service, checks: [] });
  const checks = trimRawChecks(
    [
      ...(Array.isArray(raw.checks) ? raw.checks : []),
      {
        checked_at: snapshot.checked_at,
        status: snapshot.status,
        latency_ms: snapshot.latency_ms,
      },
    ],
    now,
  );
  const history = dailyFromChecks(service, checks);

  await writeJson(rawPath, { service, checks });
  await writeJson(historyPath, history);

  return {
    uptime_24h: uptime24h(checks, now),
    uptime_90d: uptime90d(history),
  };
}

function validateSummary(summary, serviceIds) {
  if (
    !summary.generated_at ||
    Number.isNaN(new Date(summary.generated_at).getTime())
  ) {
    throw new Error("summary.generated_at must be an ISO timestamp");
  }
  for (const service of serviceIds) {
    const snapshot = summary.services[service];
    if (!snapshot) throw new Error(`summary missing ${service}`);
    if (!STATUSES.has(snapshot.status))
      throw new Error(`${service} has invalid status`);
    if (
      snapshot.latency_ms !== null &&
      (!Number.isFinite(snapshot.latency_ms) || snapshot.latency_ms < 0)
    ) {
      throw new Error(`${service} has invalid latency_ms`);
    }
    for (const key of ["uptime_24h", "uptime_90d"]) {
      if (
        !Number.isFinite(snapshot[key]) ||
        snapshot[key] < 0 ||
        snapshot[key] > 100
      ) {
        throw new Error(`${service} has invalid ${key}`);
      }
    }
  }
}

async function main() {
  const now = utcNow();
  const checkedAt = isoDate(now);
  const config = await loadConfig();
  const serviceIds = config.services.map((service) => service.id);
  const results = await Promise.all(
    config.services.map((service) => checkService(service, config, checkedAt)),
  );

  const services = {};
  for (const [service, snapshot] of results) {
    const uptime = await updateServiceHistory(service, snapshot, now);
    services[service] = { ...snapshot, ...uptime };
  }

  const summary = {
    generated_at: checkedAt,
    services,
  };
  validateSummary(summary, serviceIds);
  await writeJson(join(outputRoot, "summary.json"), summary);
  console.log(`Updated ${serviceIds.length} services at ${checkedAt}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
