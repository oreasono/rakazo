import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function assertTerminalRuns(
  runs: Array<{ status: string }>,
  attempts: Array<{ status: string }> = [],
) {
  if (
    runs.some((run) => !["completed", "failed", "cancelled"].includes(run.status)) ||
    attempts.some((attempt) => attempt.status === "running")
  )
    throw new Error(
      "Previous product runs/attempts are not terminal; inspect and settle them before a new attempt",
    );
}

/** Copy evidence before changing any current-attempt file. Runtime/DB state is never reset. */
export function archivePreviousAttempt(options: {
  directory: string;
  sessionRoot: string;
  newAttempt: boolean;
  runs: Array<{ status: string }>;
  attempts?: Array<{ status: string }>;
  databaseSnapshot: unknown;
}): string | undefined {
  assertTerminalRuns(options.runs, options.attempts);
  const marker = path.join(options.directory, "run-attempt.json");
  if (!existsSync(marker)) {
    if (options.newAttempt)
      throw new Error("--new-attempt requires an existing attempt to archive");
    return;
  }
  if (!options.newAttempt)
    throw new Error(
      "An attempt already exists; inspect it and explicitly pass --new-attempt after all runs are terminal",
    );
  const archive = path.join(
    options.directory,
    "attempts",
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
  );
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const hashes: Record<string, string> = {};
  for (const entry of readdirSync(options.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(json|jsonl|png|log)$/.test(entry.name)) continue;
    const target = path.join(archive, entry.name);
    copyFileSync(path.join(options.directory, entry.name), target);
    hashes[entry.name] = createHash("sha256").update(readFileSync(target)).digest("hex");
  }
  if (existsSync(options.sessionRoot))
    cpSync(options.sessionRoot, path.join(archive, "codex-sessions"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  writeFileSync(
    path.join(archive, "database-snapshot.json"),
    JSON.stringify(options.databaseSnapshot, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(archive, "archive-manifest.json"),
    JSON.stringify({ complete: true, archivedAt: new Date().toISOString(), hashes }, null, 2),
    { mode: 0o600 },
  );
  // Clear only prior attempt projections, after a complete archive. Leave credentials, VM binding,
  // the actual database/native state, and append-only service logs untouched.
  for (const entry of readdirSync(options.directory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      /^(?:run-attempt\.json|receipt\.json|worker-restart\.json|(?:delegation|restored)-.*\.json|tree-.*\.png)$/.test(
        entry.name,
      )
    )
      unlinkSync(path.join(options.directory, entry.name));
  }
  return archive;
}
