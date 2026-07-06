#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
export const MAX_AI_CALLS_PER_RUN = 3;
export const MIN_CONSECUTIVE = 2;
const INCIDENT_RETENTION_DAYS = 90;
const AI_TIMEOUT_MS = 8000;
const FABRICATION_PATTERN = /\b(due to|caused by|because of|provider)\b/i;
const INCIDENT_STATES = new Set(["identified", "monitoring", "resolved"]);

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
  const body = await response.text().catch(() => "");
  const maintenance =
    response.status === 503 &&
    (response.headers.has("retry-after") || /\bmaintenance\b/i.test(body));
  return {
    status: response.status === (service.expectStatus ?? 200) ? "up" : "down",
    latency_ms: normalizeLatency(null, measuredLatency),
    checked_at: checkedAt,
    maintenance,
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
        maintenance: service.id === "marketing" ? false : undefined,
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

export function durationHuman(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "unknown duration";
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins ? `${hours} h ${mins} m` : `${hours} h`;
}

function minutesBetween(startIso, endIso) {
  return Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000,
  );
}

function isIncidentStatus(status) {
  return status === "down" || status === "degraded";
}

function countsTowardIncident(service, check) {
  if (!isIncidentStatus(check.status)) return false;
  if (check.maintenance === true) return false;
  // Pre-launch marketing has legacy down checks before the maintenance flag
  // existed. Those are the intentional 503 maintenance wall; after launch,
  // marketing outages are recorded explicitly as maintenance:false.
  if (service.id === "marketing") return check.maintenance === false;
  return true;
}

function incidentSortNewest(left, right) {
  return right.started_at.localeCompare(left.started_at);
}

function incidentRetentionTime(incident) {
  return new Date(incident.resolved_at ?? incident.started_at).getTime();
}

function withinIncidentRetention(incident, checkedAt) {
  const cutoff = new Date(checkedAt).getTime() - INCIDENT_RETENTION_DAYS * DAY_MS;
  return incidentRetentionTime(incident) >= cutoff;
}

function updateTimestamp(base, state, index, total) {
  if (state === "identified") return base.started_at;
  if (state === "resolved") return base.resolved_at ?? base.started_at;
  const start = new Date(base.started_at).getTime();
  const end = new Date(base.resolved_at ?? base.started_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return base.started_at;
  }
  const divisor = Math.max(total - 1, 2);
  return new Date(start + ((end - start) * index) / divisor).toISOString();
}

function normalizeUpdate(base, update, index, total) {
  const state = INCIDENT_STATES.has(update?.state) ? update.state : "identified";
  const text = typeof update?.text === "string" ? update.text.trim() : "";
  if (!text) return null;
  return {
    at: updateTimestamp(base, state, index, total),
    state,
    text,
  };
}

function normalizeUpdates(base, updates) {
  if (!Array.isArray(updates)) return null;
  const normalized = updates
    .slice(0, 3)
    .map((update, index, list) =>
      normalizeUpdate(base, update, index, list.length),
    )
    .filter(Boolean);
  return normalized.length ? normalized : null;
}

export function normalizeNarratedUpdates(base, updates) {
  const normalized = normalizeUpdates(base, updates);
  if (!normalized || normalized.length < 2 || normalized.length > 3) {
    throw new Error("Gemini returned invalid incident updates");
  }
  if (normalized.some((update) => FABRICATION_PATTERN.test(update.text))) {
    throw new Error("Gemini returned fabricated-cause wording");
  }
  return normalized;
}

export function templateUpdates(base) {
  const severityText =
    base.severity === "major" ? "unreachable" : "running slower than normal";
  const peakText = Number.isFinite(base.peak_latency_ms)
    ? `, latency peaked at ${base.peak_latency_ms} ms`
    : "";
  const recoveredText = `${base.label} recovered automatically after ${durationHuman(base.duration_min)}. No action needed from users.`;
  return [
    {
      at: base.started_at,
      state: "identified",
      text: `${base.label} was ${severityText} (checks failing${peakText}).`,
    },
    {
      at: base.resolved_at ?? base.started_at,
      state: "resolved",
      text: recoveredText,
    },
  ];
}

function detectServiceIncidents(service, rawChecks) {
  const checks = (Array.isArray(rawChecks) ? rawChecks : [])
    .filter((check) => {
      if (!check || (!isIncidentStatus(check.status) && check.status !== "up")) {
        return false;
      }
      return !Number.isNaN(new Date(check.checked_at).getTime());
    })
    .sort((left, right) => left.checked_at.localeCompare(right.checked_at));
  const incidents = [];
  let index = 0;

  while (index < checks.length) {
    if (!countsTowardIncident(service, checks[index])) {
      index += 1;
      continue;
    }

    const startIndex = index;
    while (index < checks.length && countsTowardIncident(service, checks[index])) {
      index += 1;
    }
    const run = checks.slice(startIndex, index);
    if (run.length < MIN_CONSECUTIVE) continue;

    const firstUp = checks.slice(index).find((check) => check.status === "up");
    const startedAt = run[0].checked_at;
    const resolvedAt = firstUp?.checked_at ?? null;
    const peakLatency = run.reduce((peak, check) => {
      const latency = Number(check.latency_ms);
      return Number.isFinite(latency) ? Math.max(peak, Math.round(latency)) : peak;
    }, -Infinity);

    incidents.push({
      id: `${service.id}:${startedAt}`,
      service: service.id,
      label: service.label,
      severity: run.some((check) => check.status === "down") ? "major" : "minor",
      started_at: startedAt,
      resolved_at: resolvedAt,
      status: resolvedAt ? "resolved" : "ongoing",
      duration_min: resolvedAt ? minutesBetween(startedAt, resolvedAt) : null,
      peak_latency_ms: Number.isFinite(peakLatency) ? peakLatency : null,
    });
  }

  return incidents;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

async function vertexAccessToken(signal) {
  const key = JSON.parse(process.env.VERTEX_SA_KEY);
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    clientOptions: { transporterOptions: { signal } },
  });
  const client = await auth.getClient();
  return client.getAccessToken();
}

function incidentPrompt(base) {
  return {
    service_label: base.label,
    severity: base.severity,
    started_at: base.started_at,
    resolved_at: base.resolved_at,
    duration_human: durationHuman(base.duration_min),
    peak_latency_ms: base.peak_latency_ms,
  };
}

function parseGeminiJson(data) {
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned no text");
  return JSON.parse(text);
}

export async function narrateIncident(base) {
  const project = process.env.VERTEX_PROJECT;
  const location = process.env.VERTEX_LOCATION || "us-central1";
  if (!process.env.VERTEX_SA_KEY || !project) {
    throw new Error("Vertex credentials are not configured");
  }

  const timeout = timeoutSignal(AI_TIMEOUT_MS);
  try {
    const token = await vertexAccessToken(timeout.signal);
    const accessToken = typeof token === "string" ? token : token?.token;
    if (!accessToken) throw new Error("Unable to mint Vertex access token");

    const response = await fetch(
      `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/gemini-2.5-flash:generateContent`,
      {
        method: "POST",
        signal: timeout.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: 'You write concise, factual status-page incident retrospectives for CraftRFP, an AI proposal tool. You are given ONLY monitoring measurements. Rules: (1) Describe ONLY what the data shows — the service, minor(slow)-vs-major(unreachable), duration, latency. (2) NEVER invent or guess a root cause, provider, or internal detail. No "due to", no "caused by", no "our provider". (3) Past tense, calm, plain English, ≤22 words per update, one sentence each. (4) No apologies, no marketing. Return only the JSON.',
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify(incidentPrompt(base)) }],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 320,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                updates: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      state: {
                        type: "string",
                        enum: ["identified", "monitoring", "resolved"],
                      },
                      text: { type: "string" },
                    },
                    required: ["state", "text"],
                  },
                },
              },
              required: ["updates"],
            },
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Vertex returned ${response.status}`);
    }
    const payload = parseGeminiJson(await response.json());
    return normalizeNarratedUpdates(base, payload.updates);
  } finally {
    timeout.clear();
  }
}

export async function buildIncidentsFeed({
  config,
  outputRoot,
  checkedAt,
  skipAi =
    process.env.SKIP_AI === "1" ||
    !process.env.VERTEX_SA_KEY ||
    !process.env.VERTEX_PROJECT,
  narrateIncident: narrate = narrateIncident,
} = {}) {
  const previous = await readJson(join(outputRoot, "incidents.json"), {
    incidents: [],
  });
  const overridesFile = await readJson(
    join(outputRoot, "incidents.overrides.json"),
    { overrides: {} },
  );
  const prevById = new Map(
    (Array.isArray(previous.incidents) ? previous.incidents : []).map(
      (incident) => [incident.id, incident],
    ),
  );
  const prevByServiceResolvedAt = new Map(
    (Array.isArray(previous.incidents) ? previous.incidents : [])
      .filter((incident) => incident.service && incident.resolved_at)
      .map((incident) => [`${incident.service}:${incident.resolved_at}`, incident]),
  );
  const overrides =
    overridesFile && typeof overridesFile.overrides === "object"
      ? overridesFile.overrides
      : {};
  let aiBudget = MAX_AI_CALLS_PER_RUN;
  let deferredCount = 0;
  const detected = [];

  for (const service of config.services) {
    const raw = await readJson(
      join(outputRoot, "history", ".raw", `${service.id}.json`),
      { checks: [] },
    );
    const serviceIncidents = detectServiceIncidents(service, raw.checks).filter(
      (incident) => withinIncidentRetention(incident, checkedAt),
    );

    for (const base of serviceIncidents) {
      const override = overrides[base.id];
      const previousIncident =
        prevById.get(base.id) ??
        (base.resolved_at
          ? prevByServiceResolvedAt.get(`${base.service}:${base.resolved_at}`)
          : undefined);
      if (override) {
        detected.push({
          ...base,
          narrative_source: "override",
          title: typeof override.title === "string" ? override.title : undefined,
          updates:
            normalizeUpdates(base, override.updates) ??
            (base.status === "ongoing" ? undefined : templateUpdates(base)),
        });
      } else if (previousIncident?.narrative_source) {
        detected.push({
          ...base,
          narrative_source: previousIncident.narrative_source,
          title: previousIncident.title,
          updates: previousIncident.updates,
        });
      } else if (base.status === "ongoing") {
        detected.push(base);
      } else if (skipAi) {
        detected.push({
          ...base,
          narrative_source: "template",
          updates: templateUpdates(base),
        });
      } else if (aiBudget > 0) {
        aiBudget -= 1;
        try {
          detected.push({
            ...base,
            narrative_source: "ai",
            updates: await narrate(base),
          });
        } catch (error) {
          console.error(
            `Incident narration failed for ${base.id}: ${error?.message ?? error}`,
          );
          detected.push({
            ...base,
            narrative_source: "template",
            updates: templateUpdates(base),
          });
        }
      } else {
        deferredCount += 1;
        detected.push(base);
      }
    }
  }

  if (deferredCount > 0) {
    console.log(
      `Deferred AI narration for ${deferredCount} resolved incident${deferredCount === 1 ? "" : "s"} because MAX_AI_CALLS_PER_RUN=${MAX_AI_CALLS_PER_RUN}`,
    );
  }

  const incidents = detected
    .sort(incidentSortNewest);

  return {
    generated_at: checkedAt,
    active_count: incidents.filter((incident) => incident.status !== "resolved")
      .length,
    incidents,
  };
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
        maintenance:
          typeof snapshot.maintenance === "boolean"
            ? snapshot.maintenance
            : undefined,
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
  const incidents = await buildIncidentsFeed({ config, outputRoot, checkedAt });
  await writeJson(join(outputRoot, "incidents.json"), incidents);
  console.log(
    `Updated ${serviceIds.length} services and ${incidents.incidents.length} incidents at ${checkedAt}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
