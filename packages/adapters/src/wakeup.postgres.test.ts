import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { runContinueJob, runRecoveryJob } from "@rakazo/adapter-kit";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

let pool: Pool | undefined;
const contractSchema = `worker_recovery_contract_${process.pid}_${Date.now().toString(36)}`;
function testPool(): Pool {
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 4,
    // Prisma stores DateTime as a UTC timestamp without time zone. Exercise the
    // SQL comparison under a non-UTC server session as well as real row locks.
    options: `-c search_path=${contractSchema},public -c TimeZone=Asia/Tokyo`,
  });
  return pool;
}
afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

function handlers(overrides: Partial<BackgroundJobHandlers> = {}): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

describePostgres("Graphile background jobs (PostgreSQL contract)", () => {
  let createdSchema = false;
  beforeAll(async () => {
    // Lease fixtures live in a private schema; never modify real product Runs.
    // These are the exact columns the publisher's SQL uses from the Prisma Run.
    await testPool().query(`create schema "${contractSchema}"`);
    createdSchema = true;
    await testPool().query(`create table runs (
      id text primary key,
      status text not null,
      "leaseFence" integer not null,
      "leaseExpiresAt" timestamp(3)
    )`);
  });
  afterAll(async () => {
    try {
      if (createdSchema) await testPool().query(`drop schema "${contractSchema}" cascade`);
    } finally {
      await pool?.end();
      pool = undefined;
    }
  });

  async function seedRunState(
    runId: string,
    {
      status = "running",
      fence = 7,
      expiresInSeconds = -60,
    }: {
      status?: string;
      fence?: number;
      expiresInSeconds?: number | null;
    } = {},
  ) {
    await testPool().query(
      `insert into runs (id, status, "leaseFence", "leaseExpiresAt")
       values ($1, $2, $3, (clock_timestamp() at time zone 'UTC') + $4::integer * interval '1 second')`,
      [runId, status, fence, expiresInSeconds],
    );
  }

  it("retires the original retry and dispatches fenced recovery without unlocking active jobs", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 3, pollInterval: 25 });
    const runId = `contract-recovery-${Date.now()}`;
    const original = runContinueJob(runId);
    const recovery = runRecoveryJob(runId, 7);
    const originalEntered = deferred();
    const recoveryEntered = deferred();
    const release = deferred();
    const received: Array<{ runId: string; recoveryFence?: number }> = [];
    const target = handlers({
      "run.continue": async (payload) => {
        received.push(payload);
        if (received.length === 1) {
          originalEntered.resolve();
          await release.promise;
          throw new Error("original worker failed after recovery took over");
        } else if (received.length === 2) {
          recoveryEntered.resolve();
          await release.promise;
        }
      },
    });

    try {
      await seedRunState(runId);
      await host.start(target);
      await publisher.enqueue(original);
      await originalEntered.promise;
      const before = await testPool().query<{ id: string; locked_at: Date; locked_by: string }>(
        "select id, locked_at, locked_by from graphile_worker._private_jobs where key = $1",
        [original.replaceKey],
      );
      expect(before.rows[0]?.locked_at).toBeInstanceOf(Date);

      await publisher.enqueue(recovery);
      await recoveryEntered.promise;
      // Model a second worker crash before the Run claim: its Graphile handler
      // is still locked, so republishing must create a runnable replacement.
      await publisher.enqueue(recovery);
      await waitFor(() => expect(received).toHaveLength(3));

      expect(received).toEqual([
        { runId },
        { runId, recoveryFence: 7 },
        { runId, recoveryFence: 7 },
      ]);
      const after = await testPool().query(
        "select id, locked_at, locked_by, key, attempts, max_attempts from graphile_worker._private_jobs where id = $1",
        [before.rows[0]!.id],
      );
      expect(after.rows[0]).toMatchObject({ ...before.rows[0], key: null });
      expect(after.rows[0].attempts).toBe(after.rows[0].max_attempts);

      // When Graphile eventually unlocks the original job, it must remain
      // unavailable. Otherwise its unguarded payload can resume a human wait.
      release.resolve();
      await vi.waitFor(async () => {
        const released = await testPool().query(
          "select locked_at, attempts, max_attempts, is_available from graphile_worker._private_jobs where id = $1",
          [before.rows[0]!.id],
        );
        expect(released.rows[0]).toMatchObject({ locked_at: null, is_available: false });
        expect(released.rows[0].attempts).toBe(released.rows[0].max_attempts);
      });
      expect(received).toHaveLength(3);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.cancel(original.replaceKey!).catch(() => undefined);
      await publisher.cancel(recovery.replaceKey!).catch(() => undefined);
      await publisher.close();
    }
  });

  it("does not remove an unlocked explicit continuation when an old recovery wakeup arrives", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const runId = `contract-delayed-recovery-${Date.now()}`;
    const original = { ...runContinueJob(runId), availableAt: new Date(Date.now() + 60_000) };
    const recovery = runRecoveryJob(runId, 7);
    try {
      await seedRunState(runId);
      await publisher.enqueue(original);
      const before = await keyedRow(original.replaceKey!);

      await publisher.enqueue(recovery);

      expect(await keyedRow(original.replaceKey!)).toEqual(before);
    } finally {
      await publisher.cancel(original.replaceKey!).catch(() => undefined);
      await publisher.cancel(recovery.replaceKey!).catch(() => undefined);
      await publisher.close();
    }
  });

  it.each([
    { label: "new-fence", state: { fence: 8 } },
    { label: "human-wait", state: { status: "waiting_input" } },
    { label: "takeover", state: { status: "waiting_takeover" } },
    { label: "queued-answer", state: { status: "queued" } },
    { label: "renewed", state: { expiresInSeconds: 60 } },
    { label: "unknown-expiry", state: { expiresInSeconds: null } },
    { label: "completed", state: { status: "completed" } },
  ])(
    "does not retire a locked normal job after the Run changes to $label",
    async ({ label, state }) => {
      const publisher = new GraphileJobPublisher(testPool());
      const host = new GraphileJobWorkerHost(testPool(), { concurrency: 2, pollInterval: 25 });
      const runId = `contract-stale-${label}-${Date.now()}`;
      const original = runContinueJob(runId);
      const recovery = runRecoveryJob(runId, 7);
      const entered = deferred();
      const release = deferred();
      try {
        await seedRunState(runId, state);
        await host.start(
          handlers({
            "run.continue": async (payload) => {
              if (payload.recoveryFence === undefined) {
                entered.resolve();
                await release.promise;
              }
            },
          }),
        );
        await publisher.enqueue(original);
        await entered.promise;
        const read = () =>
          testPool().query(
            "select id, key, attempts, max_attempts, locked_at, locked_by from graphile_worker._private_jobs where key = $1",
            [original.replaceKey],
          );
        const before = await read();
        expect(before.rows[0]?.locked_at).toBeInstanceOf(Date);
        expect(before.rows[0].attempts).toBeLessThan(before.rows[0].max_attempts);

        await publisher.enqueue(recovery);

        expect((await read()).rows).toEqual(before.rows);
      } finally {
        release.resolve();
        await host.stop();
        await publisher.cancel(original.replaceKey!).catch(() => undefined);
        await publisher.cancel(recovery.replaceKey!).catch(() => undefined);
        await publisher.close();
      }
    },
  );

  it("rechecks the Run predicate after a concurrent newer claim releases its row lock", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 2, pollInterval: 25 });
    const runId = `contract-retirement-race-${Date.now()}`;
    const original = runContinueJob(runId);
    const recovery = runRecoveryJob(runId, 7);
    const entered = deferred();
    const release = deferred();
    const writer = await testPool().connect();
    let transactionOpen = false;
    let publication: Promise<void> | undefined;
    try {
      await seedRunState(runId);
      await host.start(
        handlers({
          "run.continue": async (payload) => {
            if (payload.recoveryFence === undefined) {
              entered.resolve();
              await release.promise;
            }
          },
        }),
      );
      await publisher.enqueue(original);
      await entered.promise;
      const before = await testPool().query(
        "select id, key, attempts, max_attempts, locked_at, locked_by from graphile_worker._private_jobs where key = $1",
        [original.replaceKey],
      );
      await writer.query("begin");
      transactionOpen = true;
      await writer.query('update runs set "leaseFence" = 8 where id = $1', [runId]);

      publication = publisher.enqueue(recovery);
      void publication.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const blocked = await testPool().query(
            `select count(*)::integer as count from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like 'with eligible_run as materialized%'`,
          );
          expect(blocked.rows[0].count).toBe(1);
        },
        { timeout: 5_000, interval: 25 },
      );
      await writer.query("commit");
      transactionOpen = false;
      await publication;

      const after = await testPool().query(
        "select id, key, attempts, max_attempts, locked_at, locked_by from graphile_worker._private_jobs where key = $1",
        [original.replaceKey],
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      if (transactionOpen) await writer.query("rollback");
      writer.release();
      await publication?.catch(() => undefined);
      release.resolve();
      await host.stop();
      await publisher.cancel(original.replaceKey!).catch(() => undefined);
      await publisher.cancel(recovery.replaceKey!).catch(() => undefined);
      await publisher.close();
    }
  });

  it("waits for an active handler during graceful shutdown", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const entered = deferred();
    const release = deferred();
    let completed = false;
    const target = handlers({
      "run.continue": async () => {
        entered.resolve();
        await release.promise;
        completed = true;
      },
    });

    try {
      await host.start(target);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "graceful-stop" } });
      await entered.promise;

      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);

      release.resolve();
      await stopping;
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("replaces a keyed delayed job without running the old payload or schedule", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    const target = handlers({
      "computer.sleep": async ({ computerId }) => {
        received.push(computerId);
      },
    });
    const key = `contract:replacement:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "old" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "replacement" },
        availableAt: new Date(Date.now() + 800),
        replaceKey: key,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received).toEqual([]);
      await waitFor(() => expect(received).toEqual(["replacement"]));
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("removes a keyed delayed job before a worker can run it", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    const target = handlers();
    const key = `contract:cancellation:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "cancelled" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.cancel(key);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  async function keyedRow(key: string): Promise<{
    attempts: number;
    maxAttempts: number;
    runAt: Date;
    payload: string;
  } | null> {
    const result = await testPool().query<{
      attempts: number;
      max_attempts: number;
      run_at: Date;
      payload: unknown;
    }>(
      "select attempts, max_attempts, run_at, payload from graphile_worker._private_jobs where key = $1",
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      runAt: new Date(row.run_at),
      payload: JSON.stringify(row.payload),
    };
  }

  it("keeps attempts and run_at while a keyed job is still in backoff", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-backoff:${Date.now()}`;
    const runAt = new Date(Date.now() + 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "backed-off" },
        availableAt: runAt,
        replaceKey: key,
        maxAttempts: 5,
      });
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = 2, run_at = $2 where key = $1",
        [key, runAt],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "pulled-forward" },
        availableAt: new Date(),
        replaceKey: key,
        keepExisting: true,
      });
      const kept = await keyedRow(key);
      expect(kept?.attempts).toBe(2);
      expect(kept?.maxAttempts).toBe(5);
      expect(kept?.runAt.getTime()).toBe(runAt.getTime());
      expect(kept?.payload).toContain("backed-off");
      expect(kept?.payload).not.toContain("pulled-forward");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("re-enqueues an exhausted job with fresh attempts", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-exhausted:${Date.now()}`;
    const revivedAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "exhausted" },
        availableAt: new Date(Date.now() + 60 * 60 * 1000),
        replaceKey: key,
        maxAttempts: 3,
      });
      await testPool().query(
        "update graphile_worker._private_jobs set attempts = max_attempts where key = $1",
        [key],
      );
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "revived" },
        availableAt: revivedAt,
        replaceKey: key,
        keepExisting: true,
      });
      const revived = await keyedRow(key);
      expect(revived?.attempts).toBe(0);
      expect(revived?.runAt.getTime()).toBe(revivedAt.getTime());
      expect(revived?.payload).toContain("revived");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("enqueues a keepExisting job when the key is missing", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const key = `contract:keep-missing:${Date.now()}`;
    const runAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
    try {
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "fresh" },
        availableAt: runAt,
        replaceKey: key,
        keepExisting: true,
      });
      const inserted = await keyedRow(key);
      expect(inserted?.attempts).toBe(0);
      expect(inserted?.runAt.getTime()).toBe(runAt.getTime());
      expect(inserted?.payload).toContain("fresh");
    } finally {
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("persists a handler failure and retries the job successfully", async () => {
    const publisher = new GraphileJobPublisher(testPool());
    const host = new GraphileJobWorkerHost(testPool(), { concurrency: 1, pollInterval: 25 });
    let attempts = 0;
    const target = handlers({
      "run.continue": async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("intentional contract-test failure");
      },
    });
    const key = `contract:retry:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "retry" },
        replaceKey: key,
      });
      await waitFor(() => expect(attempts).toBe(2), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts).toBe(2);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });
});
