# Real Codex / Incus product acceptance

The separate [mid-turn SIGKILL gate](#mid-turn-sigkill-gate) below covers three exact
operation boundaries. A completed-turn restart receipt from `run` does not establish
mid-turn crash recovery.

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

## Mid-turn SIGKILL gate

`crash-run` uses the same private-state launcher, real API, separate Graphile worker,
Codex root/native child, and provisioned Incus computer. It calls `threads/send` exactly
once. It never invokes `AgentRuntime` directly, edits DB rows/leases, resubmits the original
input, or fabricates recovery events. A passing offline test is not live acceptance.

Use a **fresh private state and freshly seeded bot for each boundary**. The seed may contain
the cancelled, never-executed intro created by setup, but no prior native history or executed
turn. Complete the normal migrate, live seed, VM binding and model connection steps first.
Stop the previous state's services before running another scenario. The provisioning owner
may explicitly reuse the same newly allocated disposable VM across the three isolated states;
only one worker may own it at a time. Each scenario uses a new random output path and nonce.
Preserve every state's evidence. This command has no automatic retry or `--new-attempt` mode.

Start the worker with the updated launcher so it records its **actual child PID**, parent
wrapper PID, generation and process start time in `worker-process.json`. Older wrapper-only
state cannot authorize a crash. `status` includes the actual worker identity when verified.

```sh
node scripts/accept-codex-incus.mjs crash-run --allow-live --boundary=tool_dispatched --state="$STATE"
# Run these in two separately prepared fresh states, after stopping the prior worker:
node scripts/accept-codex-incus.mjs crash-run --allow-live --boundary=tool_prepared --state="$STATE"
node scripts/accept-codex-incus.mjs crash-run --allow-live --boundary=tool_result_stored --state="$STATE"
```

`readbackCommand` must return the exact guest file bytes. For the initial absent file, it must
return empty bytes with exit status zero **only for file-not-found**. Connection, permission,
timeout and other failures must remain nonzero. Do not use `cat ... || true`. The independent
wrapper must use this scenario's `{computerRef}` and `{path}` placeholders; it never reads a
nonce or counter from model prose. An external inventory and provisioning receipt are still
required. Configure `phaseTimeoutMs` if needed; the crash gate defaults to twelve minutes
for reaching the boundary and another twelve minutes for recovery. It uses normal production
lease/heartbeat/reconciliation intervals, with no shortened TTL or Graphile unlock SQL.

| Boundary | Controller evidence before SIGKILL | Independent VM bytes before SIGKILL |
| --- | --- | --- |
| `tool_prepared` | Durable journal `prepared`; server latch reached before dispatch | Empty |
| `tool_dispatched` | Durable journal `dispatched`; the non-idempotent shell command is still sleeping | Exactly one nonce plus LF |
| `tool_result_stored` | Durable journal `completed`; server latch reached before bridge HTTP reply; stored result digest | Exactly one nonce plus LF |

The command deliberately uses unguarded `printf ... >> file`, then sleeps (90 seconds for
the dispatched case) and reads the file. There is no `test`, lock or deduplication guard in
the guest command. Executing it twice visibly appends twice. Every recovered scenario must
end with exactly one nonce line, including another independent readback after browser refresh.

### Trusted injection contract

Only the live **worker** receives `RAKAZO_CODEX_CRASH_GATE`, pointing at private
`crash-gate.json`; `NODE_ENV=test` is also required. The launcher reserves this environment
variable so private config cannot redirect the latch. The harness writes the following
control atomically. These are placeholders, never tracked live paths or credentials:

```json
{
  "phase": "tool_prepared",
  "tool": "shell",
  "argumentIncludes": "CRASH_<random nonce>",
  "reachedFile": "<private state>/crash-gate/reached.json",
  "releaseFile": "<private state>/crash-gate/release"
}
```

The runtime hook runs after the selected durable journal transition, atomically writes
mode-0600 `{phase,pid,executionId,at}`, and blocks for at most 120 seconds, until release or
cancellation. For `tool_result_stored` it must block before the HTTP response reaches Codex.
An already existing reached file makes the latch one-shot. The dispatched case uses
`{ "phase": "disabled" }` and external readback instead of blocking dispatch. The model cannot
choose injection paths or authorize SIGKILL. The harness correlates the reached record with
the known worker, exact shell command and the current run's real journal at
`sessionHome/operations/<sha256(runId)>/<sha256(executionId)>.json`.

The harness creates `crash-control.json` and `crash-hit.json` as evidence manifests; these
are not runtime state. It captures the running tree, verifies the native child's actual
rollout contains the pending append call with no result yet returned, then re-reads the
journal and external bytes immediately before killing. The launcher independently checks
fixture identity, PID, parent, generation, start time and worker entry point before sending
**SIGKILL to the worker child PID**. It confirms worker/wrapper exit and records the kill,
disables the test latch, and starts a replacement actual worker. It never treats killing
only the wrapper as worker-crash proof. The journal is read again after kill to detect a
missed boundary. `crash-worker` and `crash-restart-worker` are internal guarded commands;
both require `--allow-live` and the matching `--fixture-id`.

### Recovery and browser proof

The runtime must persist `run.checkpointed` events for the same product run and native root
with `recovery: "reconciling"` followed by `recovery: "reconciled"`. The latter must include
`mutationAdmission: "closed"` to attest that the summary continuation has no mutation tools.
Prepared work executes once; dispatched work queries the provider receipt only; a completed
result is reused. The summary must not enable new MCP mutations or native child creation,
even under different arguments or call IDs. Unknown GUI/generic outcomes remain
`recovery_required`/`needs_review` and cannot pass this automatic shell recovery gate.

After recovery, the product run and native root IDs must be unchanged, the root/run must
complete, and the original child's identity must remain. Its interrupted reasoning is
truthfully displayed as legacy `failed` plus native `interrupted`, even when its external
operation succeeded. Painting that child completed is rejected. Node revisions must not
regress and at least one must advance. Events, durable messages, owner-bound native session
state, and fresh `threads/messages` API responses must agree. The journal must still contain
exactly the one original execution ID, now completed; a previously stored result must retain
its digest. A replacement product run or native child is rejected.

The same run's latest `computer.command` event for the crashed `executionId`, selected by
durable `seq`, must have `status: "done"` and numeric `exitCode: 0`. A completed native root
does not excuse an Activity row left running. The stored-result case may use its already
durable done event from before the crash; prepared/dispatched recovery must leave the same
execution's activity completed. Older successful events, another execution/run, missing
events, null exit codes and nonzero exits cannot satisfy this check.

The existing browser helper is reused unchanged. Real authenticated browser captures show
root/child IDs and visible status text while the run is stopped at its boundary, after
recovery, and after an actual page reload. The harness checks rendered status attributes and
visible labels, requires the tree to fit the viewport, and saves tree and page PNGs with
hashes. It reads both product state and VM bytes again after refresh. The operator must
inspect the actual images before visual acceptance; `visualReview: "pending"` remains
explicit in the automated receipt.

All `crash-*` controls, source snapshots, journals, native call evidence, screenshots,
kill/restart receipts and `crash-receipt.json` stay inside the private state. The harness
leaves ambiguous work intact on failure: it does not auto-stop, release a latch, retry,
provision another VM or edit recovery state. Inspect before deciding the next action.
These receipts establish only this bounded shell-operation recovery; they do not claim
universal exactly-once execution of arbitrary GUI or external operations.

Offline regressions (no service, model, DB or VM):

```sh
pnpm exec vitest run packages/testkit/src/codex-crash-proof.test.ts packages/testkit/src/codex-crash-acceptance.test.ts
pnpm --filter @rakazo/testkit check
node --check scripts/accept-codex-incus.mjs
```

The acceptance test executes the generated append command in local Bash using an owned random
temporary file: one execution writes exact LF-terminated bytes; two executions are rejected
by the counter proof. The proof tests reject stale/wrong PIDs and runs, wrong boundaries,
duplicate writes, absent native revisions, old recovery events, a result already returned to
the model, incorrect child status, stale or unsuccessful command activity, and unknown
outcomes presented as success.
