# Real Codex / Incus product acceptance

This opt-in harness runs the actual API, a separate Graphile worker, PostgreSQL and the web
client. It never calls an `AgentRuntime` directly, creates a VM, reuses a shared `.env`, or
replays a failed live attempt automatically. The provisioning owner allocates **one new,
disposable** desktop and hands its identity to the Incus provider after API seeding.

Use a supported Node version and install the API, worker, web and testkit workspace dependencies.
Install the matching Playwright Chromium (`pnpm --filter @rakazo/testkit exec playwright install
chromium`) or supply a local Chromium executable in the private configuration. No Electron UI
is launched. Local PostgreSQL binaries are required; Docker and existing database services are
not used. All state, process logs, credentials and receipts stay in a newly generated private
temporary directory outside the checkout. Do not commit that directory.

## Prepare without models or VMs

```sh
node scripts/accept-codex-incus.mjs prepare --pg-bin="$(pg_config --bindir)"
# Set STATE to the private directory printed above. Do not copy state.json into the repository.
node scripts/accept-codex-incus.mjs migrate --state="$STATE"
node scripts/accept-codex-incus.mjs start --offline --services=api,web --state="$STATE"
node scripts/accept-codex-incus.mjs seed --state="$STATE"
```

This first seed exercises real HTTP signup, session cookies and `/rpc/me`. It creates no bot
and cannot prove any model, VM, delegation or recovery behavior. `status` reports only service
health. API and web listen on random loopback ports; PostgreSQL has a random password and its
own data directory. The worker is deliberately absent during setup.

## Connect the live stack

Create a private JSON configuration outside the checkout. It accepts:

- `env`: the finalized Incus provider environment and optional `CODEX_BINARY`. Database,
  directories, ports, auth, `WAKEUP_DRIVER`, `AGENT_RUNTIME`, `SANDBOX_IDLE_MS` and `SANDBOX_PROVIDER` are owned by
  the launcher. Do not override them. Use the provider's explicit, scoped instance allowlist.
  For this delegation/restart acceptance, the launcher forces `SANDBOX_IDLE_MS="0"`
  after merging private configuration, including when reusing older state directories,
  so API and worker do not schedule automatic idle sleep between phases. This does not
  cancel an already-running sleep job or disable other workspace checkpoints.
- `modelKeyCommand`: an argv array for an existing credential store command. Its captured output
  is sent to `models/connect` and never printed. No credential rotation is performed.
- `modelConnection`: a normal product model connection, for example `provider:
  "openai-compatible"`, `baseUrl: "https://models.example.test/v1"`, `modelId: "test-model"`,
  `reasoning: true`, `supportsImages: true`. Supply a real Responses-compatible model endpoint
  privately. The key is encrypted by the normal product secret store in this isolated database.
  Public endpoints also require `env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC` set to `"1"`
  before starting API and worker. Without it, `models/connect` returns HTTP 400
  ("Public model endpoints are blocked"); the provider/model field names above are valid.
- `provisionReceipt`: path to a private JSON file containing `ready: true`, `instance` (or `vm`),
  and `before` (an array of VM names captured **before** allocation) or `baseline` (Incus CSV,
  name first). The instance must not be in that baseline. A pending `ready: false` is refused.
- `inventoryCommand`: independent argv that prints current VM names as a JSON array (strings
  or Incus objects with `name`) or Incus CSV with the instance name first.
- `readbackCommand`: independent argv that reads exact file bytes, with `{computerRef}` and
  `{path}` placeholders. `{computerRef}` is the instance name from the allocation receipt.
  For remote SSH, use a trusted wrapper that correctly quotes remote argv. This harness does
  no shell evaluation and never obtains the nonce from a model response.
- Optional `chromiumExecutable` and `phaseTimeoutMs` (default ten minutes per completed turn).

```sh
node scripts/accept-codex-incus.mjs stop --keep-pg --state="$STATE"
node scripts/accept-codex-incus.mjs start --allow-live --config="$CONFIG" --services=api,web --state="$STATE"
node scripts/accept-codex-incus.mjs seed --state="$STATE"
```

The live seed creates a dedicated bot via `/rpc/bots/create`, cancels its automatic intro via
`/rpc/threads/stop`, and writes `binding-request.json` with its space, computer and `homeKey`.
The Incus allowlist must map `spaceId` and the **computer homeKey**, not the product bot ID.
An attach-only provider may need a temporary bootstrap allowlist entry to start the API before
these IDs exist; do not start the worker until the entry is replaced with the exact seed binding.
The provisioning owner now allocates the one disposable VM, updates the allowlist and saves the
allocation receipt. No second provisioning is performed by this harness.

Before starting API/worker with the final Incus binding, create a dedicated guest directory such as
`/home/agent/rakazo-workspace`, writable by the configured guest user, and set it as
`instances[].workspacePath` in the private Incus allowlist. The provider checks this directory
but does not create it. `readbackCommand` must read the exact absolute `{path}` supplied by
the harness; the synthetic nonce file currently lives under `/tmp`. Do not use the entire
`/home/agent`: the compatibility default includes desktop caches and profiles, which
are exported file by file over SSH during checkpoints and can block idle sleep and
queued runs. See [Incus configuration](../docs/codex-fork-status.md#incus-connection).

```sh
node scripts/accept-codex-incus.mjs connect-model --allow-live --state="$STATE"
node scripts/accept-codex-incus.mjs stop --keep-pg --state="$STATE"
node scripts/accept-codex-incus.mjs start --allow-live --config="$CONFIG" --services=api,web,worker --state="$STATE"
node scripts/accept-codex-incus.mjs run --allow-live --state="$STATE"
```

## Required evidence

1. The real HTTP `threads/send` enqueues work; the separate product worker consumes it.
2. Native root and child metadata appears in `thread.subagent` events **and durable message
   blocks**, with `runtime=codex`, `agentId=threadId`, explicit `rootThreadId` and `parentThreadId`.
   The root has a null parent. Model prose, a Pi task ID or a transient-only card cannot pass.
3. The native child rollout contains a matched **successful** Rakazo MCP call/output carrying
   the random nonce and guest file path. Both separate `namespace: "mcp__rakazo"` names and
   flattened `mcp__rakazo__*` names are recognized. Codex's exact timing envelope is unwrapped
   before parsing structured output; rejected calls, error results, unexecuted visual-loop
   actions and arbitrary prose do not count. Known GUI observation/action notes require valid
   frame metadata. Independent VM execution reads back the exact ASCII nonce, with **no
   trailing newline**, quotes or other bytes.
4. A real authenticated headless browser displays the exact native IDs and retains them after
   refreshing. The screenshot helper scrolls the tree into view, requires its bounds to fit
   the viewport and captures the tree container itself. DOM visibility alone does not prove
   that a full-page screenshot contains the tree. Screenshots are saved locally; no page
   content or model events are mocked.
5. After the first turn completes, the worker is stopped and a new process starts. A second
   HTTP turn emits a durable `run.checkpointed` event with `runtime=codex`, `resumed=true` and
   the **same native root ID**. Its owner-bound `session.json` must agree on the root and mark
   that exact run completed. Completed product runs clear `Run.checkpoint`, so that nullable
   column is not the acceptance source. The turn also recalls the original nonce, reads the
   VM again, and survives another client refresh.

The harness grants AI data sharing for this synthetic model test through the product API. An
unexpected tool approval, failure or timeout stops the run and saves a failure receipt; it does
not automatically approve, retry, regenerate the nonce or allocate another VM. Inspect private
events and the native binding before deciding how to recover.

## Explicit retry with the same seed and VM

Do not delete `run-attempt.json`, reset the database/native session, or reseed to bypass a
failed gate. Once the operator has inspected the failure and all product runs are terminal,
start the corrected services with the same state/configuration, then explicitly request:

```sh
node scripts/accept-codex-incus.mjs run --allow-live --new-attempt --state="$STATE"
```

The harness refuses a prior nonterminal run or running execution attempt. It requires the
same allocated VM and seed, copies the prior evidence into `attempts/<timestamp>-<id>/`,
then creates a new nonce, file path and product run. This is a new test message, not a replay
of a prior run ID. The archive contains prior root-level JSON/logs/screenshots, a scoped
database snapshot, a copy of native Codex session state/rollouts and a completed archive
manifest with hashes for copied root files. Current-attempt projections are cleared only
after that archive finishes. Seed, credentials, database, native bindings and append-only
logs remain in place. The new marker/receipt records the previous archive and new run IDs.
If archiving fails, the original evidence remains. A directory without a completed
`archive-manifest.json` is a partial archive, not a completed attempt backup; an explicit
retry creates a new directory and retains that partial copy for inspection.

Run only one acceptance process for a state directory at a time. An explicit retry is not
automatic crash reconciliation; resolve uncertain or still-running work before retrying.
Archives contain private configuration and history and must remain outside the checkout.

## Refresh browser evidence without running the model again

After the live receipt has a completion timestamp and all product runs/attempts are terminal,
leave the existing API/web services available and run:

```sh
node scripts/accept-codex-incus.mjs capture-tree --allow-live --state="$STATE"
```

This command reads the completed run IDs, fresh durable events/messages and the real
`threads/messages` API, signs in with the existing test account, then captures the native
tree before and after a page refresh. It does not send a thread message, restart the worker,
execute a VM command, or call the model. It saves a new timestamped directory under
`browser-recaptures/` containing `tree.png`, `tree-refreshed.png`, the readback data and a
separate browser-only receipt with image hashes/bounds. The command log records that path.
The original run receipt and screenshots remain unchanged. This evidence establishes the
current completed tree's browser rendering; it does not recreate a historical live view.

Wait for any coordinated UI change to be ready before capturing. Inspect the actual images
before describing the visual gate as accepted. A tree too large for the capture viewport
is refused explicitly rather than recorded as a clipped success.

`receipt.json` reports the chain/recovery checks. It explicitly records that the owned VM is
retained for the provisioning owner's coordinated cleanup: this is **not** evidence of VM
deletion. Save a separate external inventory confirming that only this run's VM was removed.
`stop` stops only owned local services and PG; it retains the database and receipts and never
deletes VM or production data. Use `stop --keep-pg` to preserve PG between service restarts.

Offline evidence-checker regression tests:

```sh
pnpm exec vitest run packages/testkit/src/codex-incus-proof.test.ts packages/testkit/src/codex-incus-attempt.test.ts
```

Their success is not live acceptance. No real model call or VM operation occurs in those tests.
The screenshot helper also has an offline, synthetic-page browser test. Set
`CODEX_INCUS_TEST_CHROMIUM` to an installed Chromium executable if Playwright's browser is
not installed, then run `packages/testkit/src/codex-incus-browser.test.ts` with Vitest.
It starts a headless test browser only; it does not access the product or test database.
