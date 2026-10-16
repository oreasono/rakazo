import type { Prisma } from "@rakazo/db";

/** Include in the Run claim's AND, never spread over its observed status/checkpoint. */
export function runRecoveryClaimFence(
  recoveryFence: number | undefined,
  now: Date,
): Prisma.RunWhereInput {
  if (recoveryFence === undefined) return {};
  if (!Number.isSafeInteger(recoveryFence) || recoveryFence < 0) {
    throw new Error("Invalid run recovery fence");
  }
  return {
    leaseFence: recoveryFence,
    status: { in: ["leased", "running"] },
    leaseExpiresAt: { lte: now },
  };
}
