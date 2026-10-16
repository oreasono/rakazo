# Codex recovery after a worker crash

Codex remains the agent runtime. Rakazo restores the same product Run and native
root, reconciles previously admitted computer operations, and projects their native
session tree back into the client. Recovery does not resend the original prompt.

## Operation boundary

Before a turn can run, the controller creates a private journal manifest. Each
tool operation then passes through durable `prepared`, `dispatched`, and `completed`
records. Files and directory entries are synced before acknowledgement.

- `prepared`: dispatch has not been admitted. Recovery can dispatch this exact
  authorized request once, under the new worker's ordinary run/computer leases.
- `dispatched`: the destination may already have changed. Recovery only queries a
  supported provider's execution receipt. It never resends the operation.
- `completed`: recovery reuses the saved result. An uncertain or still-running
  result is not a completion receipt.

Incus shell operations have a second, root-owned journal inside the assigned VM.
A detached supervisor reserves the operation identity before execution, runs it
as the configured guest user, and saves bounded output and an exit code. Losing
the controller or SSH receiver does not rerun the command. Reusing an identity
with another command is rejected. Querying an identity cannot execute anything.
See [worker recovery](worker-recovery.md) for the lease and guest trust boundaries.

If a receipt is missing, inconsistent, timed out, or otherwise uncertain, recovery
stops with **Needs review**. A new message in the same native session cannot bypass
an unresolved operation. This version does not offer an operator resolution UI;
do not delete the journal or mark a run completed to get around the guard.

Once all admitted operations are accounted for, Codex receives their verified
results in a reporting-only continuation on the same native root. Both MCP
operation admission and new native subagent creation are closed for that turn.
This also prevents a regenerated command or a new tool-call ID from repeating an
effect. The continuation reports confirmed outcomes and unfinished work; it does
not automatically initiate additional side effects to finish a larger task.

## Session tree

Native IDs and parent links remain stable. `Recovering` is a transient state;
`Interrupted` means the child's reasoning turn ended with the crashed process.
A recovered shell receipt does not make that child turn successful. The root can
complete its recovery report while the child remains interrupted. Unknown outcomes
show `Needs review`, never green completion.

Missing lineage is repaired from Codex with effects disabled before receipt
reconciliation. Historical collab messages cannot overwrite newer known node
states. Native revisions, durable product messages and events reconstruct the
same tree after a browser refresh.

## Verification

The opt-in [crash acceptance harness](../scripts/accept-codex-incus.md) exercises
the actual API, independent Graphile worker, Codex child and disposable Incus VM.
It kills the owned worker with `SIGKILL` at three boundaries:

1. Tool prepared, before dispatch.
2. A non-idempotent append has happened in the VM, before its result returns.
3. The controller has durably saved the result, before returning it to Codex.

The command has no deduplication guard: a duplicate invocation appends a second
line. Independent target-side readback must find exactly one line after recovery.
The harness also requires the same product Run/native root/child IDs, a fresh
reconciliation checkpoint, closed mutation admission, and authenticated browser
tree/status evidence before and after refresh. It never edits leases or run states
to simulate recovery. Default lease expiry is used.

Live results are recorded in private receipts outside the repository. An unfinished
or failed receipt is not a pass. This gate does not establish arbitrary GUI
transaction recovery, guest/host power-loss recovery, multi-computer execution,
or native mobile/Electron acceptance. Unknown GUI effects stop for review.
