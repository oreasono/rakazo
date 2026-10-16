# Codex fork: integration status and configuration

Updated 2026-10-16. **The initial real Rakazo API/worker → native Codex child →
temporary Incus Ubuntu VM → web refresh → worker restart chain passed its eight
automated checks.** Recovery was tested between two completed turns, preserving
the native root thread. This fork has no published release.

The private run receipt records `passed: true`. A separate target-side readback
confirmed the exact 39-byte nonce and its SHA-256; native identities were verified
in durable events/messages and the session binding. The authenticated web client
retained those identities after refresh and restart. A browser-only recapture
verified the root and two child rows fully inside the viewport, with identical
tree-image hashes before and after refresh. The images were visually reviewed and
accepted. This follow-up reused the completed runs and made no new model calls;
the original run receipt and earlier screenshots remain preserved.

This acceptance does **not** cover automatic replay of a turn interrupted by a hard
crash, real native mobile/Electron app sessions, voice, macOS or Windows computers.

## Implemented in source

| Area | Current implementation | Acceptance boundary |
| --- | --- | --- |
| Product entry points | API and independent Graphile worker construct `CodexAgentRuntime` | Real model and temporary VM chain accepted |
| Codex ownership | Native root/child threads, inherited scoped MCP tools, persistent bindings/checkpoints | Runtime owns history and scheduling; no Pi fallback loop |
| Native session tree | Native IDs are projected into events and durable subagent message blocks; web/Electron and Expo render them | Web identity, viewport screenshots and refresh visually accepted; native app runs untested |
| Recovery | Bindings and Codex state persist across processes | Same root verified after a worker restart between completed turns; ambiguous admitted turns are not automatically replayed |
| Incus Ubuntu | Attach-only explicit instance bindings; commands, files, screenshots and GUI actions | Real temporary VM product chain and independent nonce readback accepted; no automatic VM creation |
| Local test environment | Isolated PostgreSQL, HTTP signup/session/RPC and authenticated web rendering verified | No model or VM evidence follows from this preflight |
| macOS / Windows computers | Architecture separates runtime from computer backends | Drivers, host management and mixed-computer acceptance remain planned |
| Codex realtime voice | Experimental app-server interfaces identified | Client wiring and real audio/delegation acceptance remain planned |

Incus currently advertises no PTY, snapshots, live screen/takeover or multi-screen
support. Native tree rows display runtime identity; they do not turn a Codex child
ID into a Rakazo bot-navigation or authorization capability. Do not assume upstream
published clients, Docker images or existing provider adapters have been accepted
with the new runtime.

## Configuration

Use a supported Node version from `package.json`, pnpm 9, PostgreSQL, and a Codex
CLI installed on the API/worker host. Set these consistently on API and worker:

```dotenv
AGENT_RUNTIME=codex
WAKEUP_DRIVER=graphile
DATA_DIR=/absolute/path/to/private-data
SANDBOX_PROVIDER=incus
INCUS_CONFIG_FILE=/absolute/path/to/private-incus.json
# Acceptance only: automatic idle sleep is outside the completed-turn recovery gate.
SANDBOX_IDLE_MS=0
# Optional; otherwise resolves codex on PATH. Do not set this to an empty executable.
# CODEX_BINARY=/absolute/path/to/codex
```

The protocol probe and this scoped live chain used Codex CLI 0.147.0. Other runtime
versions must repeat the acceptance; the result is not full release qualification. API and worker
must also share their normal database, secret-store and encryption configuration.
`DATA_DIR/codex-sessions` holds private native history and product/native bindings;
preserve it across process restarts and exclude it from the public repository.

### Model connection

In the product, connect **OpenAI-compatible** with an API key, base URL and explicit
model ID. The `models/connect` RPC payload uses:

```json
{
  "json": {
    "provider": "openai-compatible",
    "baseUrl": "https://models.example.test/v1",
    "modelId": "test-model",
    "apiKey": "<supplied privately>",
    "reasoning": true,
    "supportsImages": true
  }
}
```

That endpoint must support **Responses**, including the model/tool features required
by Codex; accepting Chat Completions alone is insufficient. For a public custom
endpoint, explicitly enable `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1` on API and worker.
Otherwise `models/connect` returns HTTP 400 with “Public model endpoints are blocked.”
This is an endpoint policy gate, not an invalid `openai-compatible` provider name.
Restart the services after changing the environment, then connect again.

The isolated acceptance launcher reads a configured credential-store command and
uses this normal product RPC. The key is encrypted in its private test database;
it is not printed or written into a tracked configuration. Do not copy private
configurations, raw rollouts or credentials into the repository.

### Incus connection

`INCUS_CONFIG_FILE` contains a private `IncusSandboxOptions` object. Example values
below are placeholders; obtain IDs from the actual product records:

```json
{
  "project": "acceptance",
  "transport": {
    "kind": "ssh",
    "argv": ["ssh", "vm-host"],
    "incusArgv": ["incus"]
  },
  "instances": [
    {
      "instance": "disposable-desktop",
      "spaceId": "product-space-id",
      "botId": "computer-home-key",
      "ownerBotId": "product-bot-id",
      "workspacePath": "/home/agent/rakazo-workspace",
      "owned": false
    }
  ]
}
```

Set `workspacePath` explicitly to a dedicated task directory such as
`/home/agent/rakazo-workspace`. Before attaching the VM, create that directory in
the guest and make it readable and writable by the configured guest user; the
provider checks the directory but does not create it. Keep desktop configuration,
browser profiles and caches outside this directory.

For compatibility, omitting `workspacePath` still selects `/home/<guestUser>`
(`/home/agent` by default). Avoid that default for new deployments: checkpoints
recursively export the workspace, with a separate transport call for each directory
and file. Exporting an entire desktop home over SSH can keep idle sleep in
`suspending` for a long time and delay queued runs. Individual calls have timeouts,
but the full export has no overall deadline. Disabling idle sleep does not disable
other workspace checkpoints.
The isolated acceptance launcher forces `SANDBOX_IDLE_MS=0` on API and worker,
including when an existing state directory is reused. Automatic idle sleep/export
requires a separate gate; disabling its schedule does not cancel an already-running job.

`instances[].botId` is the persisted **Computer.homeKey**. For the current dedicated
computer mode it equals the product bot ID, but read the record instead of assuming
it. `ownerBotId` defaults to that home key and names the product bot authorized to
use the desktop. The binding also requires the matching space. `owned: false`
keeps deletion ownership with the external operator; hand deletion ownership over
only for explicitly disposable instances. No model-supplied provider reference can
select a different target or widen the allowlist.

The Ubuntu guest must already contain its desktop session, execution dependencies
and the `pac-computerd` driver (or a configured compatible `computerdArgv`). The
provider default display is `:1` and guest user is `agent`. Its provision operation
attaches to or starts the configured instance; it never allocates a new VM.

## Run the acceptance gate

Follow [the executable acceptance guide](../scripts/accept-codex-incus.md). It creates
an isolated PostgreSQL cluster and actual API/web processes, seeds the product over
HTTP, then starts a separate worker only after the operator supplies the one ready
temporary VM and model connection. It does not use an in-memory executor or mock
browser state to report client acceptance.

Required evidence includes native parent/child IDs in product events **and** durable
messages, child MCP call/successful-output provenance, independent exact nonce readback from
the assigned VM, real client screenshots before and after refresh, and the same
native root in durable checkpoint events and the owner-bound session file after a worker
process restart. Completed runs can clear the product checkpoint column. A completed model response
alone cannot pass. Unexpected approval, timeout or failure stops the harness for
inspection instead of silently replaying a side-effecting run.

An explicit `--new-attempt` archives the prior attempt only after product runs are
terminal, then reuses the same seed, VM and native session with a new test nonce.
The failure evidence and scoped database/native history remain available. See the
acceptance guide for the archive contents and operator-controlled retry command.

Keep receipts outside the checkout. The chain receipt explicitly records whether
its disposable VM remains; obtain a separate independent inventory readback for
cleanup. Real approval/interruption recovery, mid-turn crash reconciliation,
multi-child/multi-computer concurrency, mixed operating systems and live voice are
separate later gates. Publish only verified, scoped results.
