# Worker crash recovery

A dead worker's expired `leased` or `running` Run is continued automatically with
the same Run ID. The product does not create a new Run, native thread, or user
prompt to recover an execution. Native state and tool receipt reconciliation belong
to the Codex runtime; an unknown effect must stop safely rather than replay.

## Admission contract

The reconciler selects runs whose non-null `leaseExpiresAt` has passed. It publishes
`run.continue` with `{ runId, recoveryFence }` under
`run:<runId>:recovery:<leaseFence>`. The executor includes the recovery fence, expired
lease, and `leased|running` status in its atomic Run claim, alongside the observed
status and checkpoint. Successful admission increments the fence. A live lease,
newer fence, queued retry, human wait, or terminal status cannot be claimed by a
delayed recovery wakeup. Null expiry is unknown and is not automatically reclaimed.

Computer execution leases retain their own expiry and fence. Recovery must acquire
the computer through the ordinary executor path; it cannot force-release another
execution or a human takeover. Run heartbeat renewal must require an unexpired
lease as well as owner, fence, and running status. Lease loss aborts execution.

Graphile lock age is not worker liveness. Recovery uses a separate job key because
the original job can remain locked after SIGKILL. Before publishing recovery, the
publisher atomically rechecks and locks the expired Run with the expected fence
using database UTC time,
then locks its original job row only if the job is still locked. It retires that
job's retries using Graphile's public removal API. Its execution lock stays held.
This prevents the original unguarded payload from replaying into a human wait hours
later. Unlocked continuations, including new user answers, remain untouched.
If a recovery wakeup is itself locked, the publisher uses Graphile's supported
replacement operation to schedule a successor; it never clears locks. The Run
claim still decides whether any worker
may execute. Unlocked recovery jobs retain their retry backoff. Repeated scans
deduplicate by Run and fence, with at most one keyed pending wakeup per fence.

## Guest receipt trust boundary

Incus execution receipts under `/var/lib/rakazo-executions/v1` rely on an
unprivileged guest account. That account must have no alternate route to guest
root, including passwordless sudo, administrative group membership, privileged
helpers, or accessible administrator credentials. Root ownership and private
journal permissions do not protect receipts from a guest VM administrator.

The root supervisor drops the command child's supplementary groups, GID, and UID
to those of the configured guest account. This does not revoke elevation grants
already present in the image. Provisioning must enforce the account boundary;
scoped acceptance must verify it on the owned disposable VM, including denial of
`sudo -n true`. That probe alone does not rule out other routes to root.
The adapter does not modify image accounts, sudoers, or production VM policy.

Before persisting a completed receipt, the root supervisor redacts nonempty
values from that command's explicit environment, including their URI-component
and UTF-8 base64 forms. It derives these values in memory; no redaction list or
additional controller secrets are sent to the guest or saved in the journal.
Readback does not need the original credentials, so rotation does not reveal old
values. This does not cover unrelated secrets or arbitrary transformations of a
value; model gateway credentials must not enter the guest in the first place.
Older receipts without the redaction marker return `unknown` and retain their
execution reservation. If redaction expands output past the configured bound,
the operation also requires review without redispatch.

## Timing and configuration

Current defaults, verified in the installed worker implementation:

| Setting | Value | Configuration |
| --- | --- | --- |
| Run lease | 5 minutes | Executor constant |
| Computer execution lease | 5 minutes | Computer lifecycle constant |
| Heartbeat | 60 seconds | Executor constant |
| Reconciliation interval | 30 seconds | `createJobReconciler({ ... }, { intervalMs })` |
| Reconciliation batch | 100 | `createJobReconciler({ ... }, { batchSize })` |
| Worker concurrency | 4 | `GRAPHILE_WORKER_CONCURRENCY` |
| Queue driver | Graphile | `WAKEUP_DRIVER=graphile` |
| Graphile polling | 500 ms | `GraphileJobWorkerHost(pool, { pollInterval })` |

With an available replacement worker, healthy database, and a single scan batch,
readmission is normally within 5 minutes plus 30 seconds of the last heartbeat,
plus dispatch time. A later computer heartbeat can add a computer retry. Backlog,
database outage, or exhausted worker capacity can extend this; there is no absolute
wall-clock guarantee under those conditions. Restarting the worker starts a scan
immediately, but does not shorten a live lease.

Graphile Worker 0.17.3 expires locks after 4 hours and cleans them every 8–10 minutes
(initial cleanup is scheduled within a minute). Those delays no longer gate Run
recovery. Changing Graphile's `minResetLockedInterval`/`maxResetLockedInterval`
changes cleanup cadence, not the four-hour lock expiry. Do not shorten global lock
expiry to recover an individual Run.

## Verification boundary

Offline tests cover recovery payloads, queue replacement/backoff, bounded scans,
same-Run admission, live lease and pause protection, and concurrent claim races.
The opt-in PostgreSQL queue contract also checks dispatch around locked jobs using
normal publishers and workers, without editing database state by hand.

Live SIGKILL acceptance must independently confirm the original Run/native root,
durable child tree and statuses, exactly-once guest effects, and automatic runtime
reconciliation. Unit tests and queue admission alone do not establish that result.
