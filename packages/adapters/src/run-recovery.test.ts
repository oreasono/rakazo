import type { Prisma, PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { runRecoveryClaimFence } from "./run-recovery.js";

const now = new Date("2030-01-01T00:00:00Z");
const expired = new Date(now.getTime() - 1);
const live = new Date(now.getTime() + 60_000);

type RunRow = {
  id: string;
  status: string;
  checkpoint: string | null;
  leaseFence: number;
  leaseOwner: string;
  leaseExpiresAt: Date | null;
};

// Evaluate the subset of Prisma predicates used for admission, so race tests
// exercise the executor's actual conditional update rather than a preflight read.
function matches(row: RunRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND" || key === "OR") {
      const clauses = Array.isArray(value) ? value : [value];
      const results = clauses.map((clause) => matches(row, clause));
      return key === "AND" ? results.every(Boolean) : results.some(Boolean);
    }
    const actual = row[key as keyof RunRow];
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const filter = value as { in?: unknown[]; lte?: Date; gt?: Date };
      if (filter.in) return filter.in.includes(actual);
      if (filter.lte) return actual instanceof Date && actual <= filter.lte;
      if (filter.gt) return actual instanceof Date && actual > filter.gt;
      throw new Error(`Unsupported admission predicate: ${key}`);
    }
    return actual === value;
  });
}

function admissionFixture(overrides: Partial<RunRow> = {}, beforeClaim?: (row: RunRow) => void) {
  const row: RunRow = {
    id: "original-run",
    status: "running",
    checkpoint: null,
    leaseFence: 7,
    leaseOwner: "previous-worker",
    leaseExpiresAt: expired,
    ...overrides,
  };
  const admitted = new Error("admitted: stop before computer or runtime setup");
  const updateMany = vi.fn(async (args: { where: Prisma.RunWhereInput; data: Partial<RunRow> }) => {
    beforeClaim?.(row);
    if (!matches(row, args.where)) return { count: 0 };
    Object.assign(row, args.data);
    return { count: 1 };
  });
  const findUniqueOrThrow = vi.fn(async () => {
    throw admitted;
  });
  const prisma = {
    run: { findUnique: vi.fn(async () => ({ ...row })), updateMany, findUniqueOrThrow },
  } as unknown as PrismaClient;
  const executor = createRunExecutor({ prisma } as Parameters<typeof createRunExecutor>[0]);
  return { row, admitted, updateMany, findUniqueOrThrow, executor };
}

afterEach(() => vi.useRealTimers());

describe("expired Run recovery admission", () => {
  it.each(["leased", "running"])("reclaims the same %s run with a higher fence", async (status) => {
    vi.useFakeTimers().setSystemTime(now);
    const test = admissionFixture({ status });

    await expect(test.executor.continueRun("original-run", "replacement-worker", 7)).rejects.toBe(
      test.admitted,
    );

    expect(test.row).toMatchObject({
      id: "original-run",
      leaseFence: 8,
      leaseOwner: "replacement-worker",
      status: "leased",
    });
    expect(test.row.leaseExpiresAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it.each([
    { label: "live lease", state: { leaseExpiresAt: live } },
    { label: "unknown expiry", state: { leaseExpiresAt: null } },
    { label: "newer execution", state: { leaseFence: 8 } },
    { label: "queued retry", state: { status: "queued" } },
    { label: "approval wait", state: { status: "waiting_input" } },
    { label: "human takeover", state: { status: "waiting_takeover" } },
    { label: "completed run", state: { status: "completed" } },
    { label: "cancelled run", state: { status: "cancelled" } },
    { label: "failed run", state: { status: "failed" } },
  ])("does not admit a delayed recovery job over a $label", async ({ state }) => {
    vi.useFakeTimers().setSystemTime(now);
    const test = admissionFixture(state);
    const previous = { ...test.row };

    await test.executor.continueRun("original-run", "replacement-worker", 7);

    expect(test.row).toEqual(previous);
    expect(test.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("checks renewal atomically even if it happens after the stale snapshot was read", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const test = admissionFixture({}, (row) => {
      row.leaseExpiresAt = live;
    });

    await test.executor.continueRun("original-run", "replacement-worker", 7);

    expect(test.row.leaseOwner).toBe("previous-worker");
    expect(test.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("admits only one of two racing recovery workers", async () => {
    vi.useFakeTimers().setSystemTime(now);
    const test = admissionFixture();

    const results = await Promise.allSettled([
      test.executor.continueRun("original-run", "replacement-a", 7),
      test.executor.continueRun("original-run", "replacement-b", 7),
    ]);

    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(test.findUniqueOrThrow).toHaveBeenCalledOnce();
    expect(test.row.leaseFence).toBe(8);
  });

  it("leaves explicit continuation admission unchanged and rejects malformed recovery fences", () => {
    expect(runRecoveryClaimFence(undefined, now)).toEqual({});
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => runRecoveryClaimFence(value, now)).toThrow("Invalid run recovery fence");
    }
  });
});
