import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MAX_AI_CALLS_PER_RUN,
  MIN_CONSECUTIVE,
  buildIncidentsFeed,
  normalizeNarratedUpdates,
  templateUpdates,
} from "../scripts/check.mjs";

const execFileAsync = promisify(execFile);

const config = {
  services: [
    { id: "api", label: "API" },
    { id: "db", label: "Database" },
    { id: "auth", label: "Authentication" },
    { id: "exports", label: "Document Exports" },
  ],
};

async function withRepo(files, fn) {
  const root = await mkdtemp(join(tmpdir(), "status-incidents-"));
  try {
    await mkdir(join(root, "history", ".raw"), { recursive: true });
    await writeFile(
      join(root, "incidents.overrides.json"),
      JSON.stringify({ overrides: {} }, null, 2),
    );
    for (const [path, data] of Object.entries(files)) {
      const fullPath = join(root, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(
        fullPath,
        typeof data === "string" ? data : JSON.stringify(data, null, 2),
      );
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function check(checked_at, status, latency_ms = 100) {
  return { checked_at, status, latency_ms };
}

test("constants pin AI call cap and incident noise floor", () => {
  assert.equal(MAX_AI_CALLS_PER_RUN, 3);
  assert.equal(MIN_CONSECUTIVE, 2);
});

test("detects a stable resolved incident and does not narrate it twice", async () => {
  const raw = {
    service: "api",
    checks: [
      check("2026-05-14T09:00:00.000Z", "up"),
      check("2026-05-14T09:05:00.000Z", "down", 1200),
      check("2026-05-14T09:10:00.000Z", "down", 1500),
      check("2026-05-14T09:15:00.000Z", "up", 200),
    ],
  };
  let calls = 0;
  await withRepo({ "history/.raw/api.json": raw }, async (root) => {
    const first = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-14T09:20:00.000Z",
      skipAi: false,
      narrateIncident: async () => {
        calls += 1;
        return [
          { at: raw.checks[1].checked_at, state: "identified", text: "API was unavailable during public checks." },
          { at: raw.checks[3].checked_at, state: "resolved", text: "API recovered automatically after 10 min." },
        ];
      },
    });

    assert.equal(first.incidents.length, 1);
    assert.equal(first.incidents[0].id, "api:2026-05-14T09:05:00.000Z");
    assert.equal(first.incidents[0].narrative_source, "ai");
    assert.equal(calls, 1);

    await writeFile(
      join(root, "incidents.json"),
      JSON.stringify(first, null, 2),
    );
    const second = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-14T09:25:00.000Z",
      skipAi: false,
      narrateIncident: async () => {
        calls += 1;
        throw new Error("must not narrate twice");
      },
    });

    assert.equal(second.incidents[0].id, first.incidents[0].id);
    assert.equal(second.incidents[0].narrative_source, "ai");
    assert.equal(calls, 1);
  });
});

test("ignores lone degraded checks and keeps ongoing incidents unnarrated", async () => {
  await withRepo(
    {
      "history/.raw/db.json": {
        service: "db",
        checks: [
          check("2026-05-14T10:00:00.000Z", "up"),
          check("2026-05-14T10:05:00.000Z", "degraded", 900),
          check("2026-05-14T10:10:00.000Z", "up", 200),
          check("2026-05-14T10:15:00.000Z", "degraded", 950),
          check("2026-05-14T10:20:00.000Z", "degraded", 1200),
        ],
      },
    },
    async (root) => {
      let calls = 0;
      const feed = await buildIncidentsFeed({
        config,
        outputRoot: root,
        checkedAt: "2026-05-14T10:25:00.000Z",
        narrateIncident: async () => {
          calls += 1;
          return [];
        },
      });

      assert.equal(feed.incidents.length, 1);
      assert.equal(feed.incidents[0].id, "db:2026-05-14T10:15:00.000Z");
      assert.equal(feed.incidents[0].status, "ongoing");
      assert.equal(feed.incidents[0].narrative_source, undefined);
      assert.equal(calls, 0);
    },
  );
});

test("caps narration at three incidents and defers the fourth without source", async () => {
  const files = {};
  config.services.forEach((service, index) => {
    const hour = String(index + 1).padStart(2, "0");
    files[`history/.raw/${service.id}.json`] = {
      service: service.id,
      checks: [
        check(`2026-05-15T${hour}:00:00.000Z`, "down", 1100 + index),
        check(`2026-05-15T${hour}:05:00.000Z`, "down", 1300 + index),
        check(`2026-05-15T${hour}:10:00.000Z`, "up", 200),
      ],
    };
  });

  await withRepo(files, async (root) => {
    let calls = 0;
    const feed = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-15T05:00:00.000Z",
      skipAi: false,
      narrateIncident: async (incident) => {
        calls += 1;
        return templateUpdates(incident);
      },
    });

    assert.equal(calls, MAX_AI_CALLS_PER_RUN);
    assert.equal(
      feed.incidents.filter((incident) => incident.narrative_source === "ai")
        .length,
      3,
    );
    assert.equal(
      feed.incidents.filter((incident) => !incident.narrative_source).length,
      1,
    );
  });
});

test("uses permanent template fallback when narration throws or SKIP_AI is set", async () => {
  const raw = {
    service: "auth",
    checks: [
      check("2026-05-16T12:00:00.000Z", "degraded", 800),
      check("2026-05-16T12:05:00.000Z", "degraded", 1500),
      check("2026-05-16T12:10:00.000Z", "up", 120),
    ],
  };

  await withRepo({ "history/.raw/auth.json": raw }, async (root) => {
    const thrown = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-16T12:15:00.000Z",
      skipAi: false,
      narrateIncident: async () => {
        throw new Error("quota");
      },
    });
    assert.equal(thrown.incidents[0].narrative_source, "template");
    assert.match(thrown.incidents[0].updates[0].text, /Authentication/);

    const skipped = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-16T12:15:00.000Z",
      skipAi: true,
      narrateIncident: async () => {
        throw new Error("must not call");
      },
    });
    assert.equal(skipped.incidents[0].narrative_source, "template");
  });
});

test("human overrides win over prior AI narration without another call", async () => {
  const id = "exports:2026-05-17T08:00:00.000Z";
  await withRepo(
    {
      "history/.raw/exports.json": {
        service: "exports",
        checks: [
          check("2026-05-17T08:00:00.000Z", "down", 1000),
          check("2026-05-17T08:05:00.000Z", "down", 1100),
          check("2026-05-17T08:10:00.000Z", "up", 100),
        ],
      },
      "incidents.json": {
        generated_at: "2026-05-17T08:15:00.000Z",
        active_count: 0,
        incidents: [
          {
            id,
            narrative_source: "ai",
            updates: [{ at: "2026-05-17T08:10:00.000Z", state: "resolved", text: "Old AI text." }],
          },
        ],
      },
      "incidents.overrides.json": {
        overrides: {
          [id]: {
            title: "Document export interruption",
            updates: [{ state: "resolved", text: "Editorial text." }],
          },
        },
      },
    },
    async (root) => {
      let calls = 0;
      const feed = await buildIncidentsFeed({
        config,
        outputRoot: root,
        checkedAt: "2026-05-17T08:20:00.000Z",
        narrateIncident: async () => {
          calls += 1;
          return [];
        },
      });

      assert.equal(feed.incidents[0].narrative_source, "override");
      assert.equal(feed.incidents[0].title, "Document export interruption");
      assert.equal(feed.incidents[0].updates[0].text, "Editorial text.");
      assert.equal(calls, 0);
    },
  );
});

test("suppresses marketing maintenance runs but detects explicit marketing outages", async () => {
  const marketingConfig = {
    services: [{ id: "marketing", label: "Marketing site" }],
  };

  await withRepo(
    {
      "history/.raw/marketing.json": {
        service: "marketing",
        checks: [
          check("2026-05-18T08:00:00.000Z", "down", 0),
          check("2026-05-18T08:05:00.000Z", "down", 0),
          check("2026-05-18T08:10:00.000Z", "down", 0),
        ],
      },
    },
    async (root) => {
      const feed = await buildIncidentsFeed({
        config: marketingConfig,
        outputRoot: root,
        checkedAt: "2026-05-18T08:15:00.000Z",
        skipAi: true,
      });

      assert.equal(feed.incidents.length, 0);
    },
  );

  await withRepo(
    {
      "history/.raw/marketing.json": {
        service: "marketing",
        checks: [
          check("2026-05-18T09:00:00.000Z", "down", 0),
          { ...check("2026-05-18T09:05:00.000Z", "down", 0), maintenance: true },
          { ...check("2026-05-18T09:10:00.000Z", "down", 0), maintenance: true },
          check("2026-05-18T09:15:00.000Z", "up", 100),
        ],
      },
    },
    async (root) => {
      const feed = await buildIncidentsFeed({
        config: marketingConfig,
        outputRoot: root,
        checkedAt: "2026-05-18T09:20:00.000Z",
        skipAi: true,
      });

      assert.equal(feed.incidents.length, 0);
    },
  );

  await withRepo(
    {
      "history/.raw/marketing.json": {
        service: "marketing",
        checks: [
          { ...check("2026-05-18T10:00:00.000Z", "down", 0), maintenance: false },
          { ...check("2026-05-18T10:05:00.000Z", "down", 0), maintenance: false },
          check("2026-05-18T10:10:00.000Z", "up", 100),
        ],
      },
    },
    async (root) => {
      const feed = await buildIncidentsFeed({
        config: marketingConfig,
        outputRoot: root,
        checkedAt: "2026-05-18T10:15:00.000Z",
        skipAi: true,
      });

      assert.equal(feed.incidents.length, 1);
      assert.equal(feed.incidents[0].id, "marketing:2026-05-18T10:00:00.000Z");
    },
  );
});

test("fetch-throw marketing checks are explicit real outages", async () => {
  await withRepo(
    {
      "history/.raw/marketing.json": {
        service: "marketing",
        checks: [
          {
            checked_at: "2026-05-19T10:00:00.000Z",
            status: "down",
            latency_ms: null,
            maintenance: false,
          },
        ],
      },
    },
    async (root) => {
      await execFileAsync(process.execPath, ["scripts/check.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BASE_URL: "http://127.0.0.1:9",
          STATUS_OUTPUT_DIR: relative(process.cwd(), root),
          STATUS_PROBE_SECRET: "local-test",
          SKIP_AI: "1",
        },
      });

      const raw = JSON.parse(
        await readFile(join(root, "history/.raw/marketing.json"), "utf8"),
      );
      assert.equal(raw.checks.at(-1).status, "down");
      assert.equal(raw.checks.at(-1).maintenance, false);

      const feed = JSON.parse(await readFile(join(root, "incidents.json"), "utf8"));
      assert.equal(feed.incidents.length, 1);
      assert.equal(feed.incidents[0].service, "marketing");
      assert.equal(feed.incidents[0].status, "ongoing");
    },
  );
});

test("maintenance wall during a marketing outage does not resolve it", async () => {
  await withRepo(
    {
      "history/.raw/marketing.json": {
        service: "marketing",
        checks: [
          {
            checked_at: "2026-05-19T11:00:00.000Z",
            status: "down",
            latency_ms: 0,
            maintenance: false,
          },
          {
            checked_at: "2026-05-19T11:05:00.000Z",
            status: "down",
            latency_ms: 0,
            maintenance: false,
          },
          {
            checked_at: "2026-05-19T11:10:00.000Z",
            status: "down",
            latency_ms: 0,
            maintenance: true,
          },
        ],
      },
    },
    async (root) => {
      const feed = await buildIncidentsFeed({
        config: { services: [{ id: "marketing", label: "Marketing site" }] },
        outputRoot: root,
        checkedAt: "2026-05-19T11:15:00.000Z",
        skipAi: true,
      });

      assert.equal(feed.incidents.length, 1);
      assert.equal(feed.incidents[0].status, "ongoing");
      assert.equal(feed.incidents[0].resolved_at, null);
      assert.equal(feed.incidents[0].narrative_source, undefined);
    },
  );
});

test("aged-out raw incidents are pruned before narration", async () => {
  await withRepo(
    {
      "history/.raw/api.json": {
        service: "api",
        checks: [
          check("2026-01-01T00:00:00.000Z", "down", 1000),
          check("2026-01-01T00:05:00.000Z", "down", 1200),
          check("2026-01-01T00:10:00.000Z", "up", 100),
        ],
      },
    },
    async (root) => {
      let calls = 0;
      const feed = await buildIncidentsFeed({
        config: { services: [{ id: "api", label: "API" }] },
        outputRoot: root,
        checkedAt: "2026-04-01T09:36:00.000Z",
        skipAi: false,
        narrateIncident: async () => {
          calls += 1;
          return [];
        },
      });

      assert.equal(feed.incidents.length, 0);
      assert.equal(calls, 0);
    },
  );
});

test("service and resolved_at fallback prevents id-drift re-narration", async () => {
  await withRepo(
    {
      "history/.raw/api.json": {
        service: "api",
        checks: [
          check("2026-05-20T00:05:00.000Z", "down", 1200),
          check("2026-05-20T00:10:00.000Z", "down", 1300),
          check("2026-05-20T00:15:00.000Z", "up", 100),
        ],
      },
      "incidents.json": {
        generated_at: "2026-05-20T00:20:00.000Z",
        active_count: 0,
        incidents: [
          {
            id: "api:2026-05-20T00:00:00.000Z",
            service: "api",
            resolved_at: "2026-05-20T00:15:00.000Z",
            narrative_source: "ai",
            updates: [
              {
                at: "2026-05-20T00:15:00.000Z",
                state: "resolved",
                text: "API recovered automatically after 15 min.",
              },
            ],
          },
        ],
      },
    },
    async (root) => {
      let calls = 0;
      const feed = await buildIncidentsFeed({
        config: { services: [{ id: "api", label: "API" }] },
        outputRoot: root,
        checkedAt: "2026-05-20T00:25:00.000Z",
        skipAi: false,
        narrateIncident: async () => {
          calls += 1;
          throw new Error("must not re-narrate id drift");
        },
      });

      assert.equal(feed.incidents[0].id, "api:2026-05-20T00:05:00.000Z");
      assert.equal(feed.incidents[0].narrative_source, "ai");
      assert.equal(calls, 0);
    },
  );
});

test("deferred cap overflow is retried on the next run", async () => {
  const files = {};
  ["api", "db", "auth", "exports"].forEach((service, index) => {
    const hour = String(index + 1).padStart(2, "0");
    files[`history/.raw/${service}.json`] = {
      service,
      checks: [
        check(`2026-05-21T${hour}:00:00.000Z`, "down", 1000),
        check(`2026-05-21T${hour}:05:00.000Z`, "down", 1100),
        check(`2026-05-21T${hour}:10:00.000Z`, "up", 100),
      ],
    };
  });

  await withRepo(files, async (root) => {
    let calls = 0;
    const first = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-21T06:00:00.000Z",
      skipAi: false,
      narrateIncident: async (incident) => {
        calls += 1;
        return templateUpdates(incident);
      },
    });
    await writeFile(join(root, "incidents.json"), JSON.stringify(first, null, 2));

    assert.equal(calls, 3);
    assert.equal(first.incidents.filter((incident) => !incident.narrative_source).length, 1);

    const second = await buildIncidentsFeed({
      config,
      outputRoot: root,
      checkedAt: "2026-05-21T06:05:00.000Z",
      skipAi: false,
      narrateIncident: async (incident) => {
        calls += 1;
        return templateUpdates(incident);
      },
    });

    assert.equal(calls, 4);
    assert.equal(second.incidents.filter((incident) => !incident.narrative_source).length, 0);
  });
});

test("fabricated-cause wording is rejected before narration is stored", () => {
  const incident = {
    label: "API",
    started_at: "2026-05-22T10:00:00.000Z",
    resolved_at: "2026-05-22T10:10:00.000Z",
  };

  assert.throws(
    () =>
      normalizeNarratedUpdates(incident, [
        { state: "identified", text: "API was unavailable due to a provider issue." },
        { state: "resolved", text: "API recovered automatically after 10 min." },
      ]),
    /fabricated-cause/,
  );
});
