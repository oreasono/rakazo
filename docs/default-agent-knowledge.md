# Default agent working knowledge

The product supplies a small, stable working-method block to every agent through
`userTurnInstructions`, alongside its own role instructions. It is not a saved
memory record or an optional skill. New agents receive it on their first run;
existing agents receive it on their next run after the updated worker is deployed.
Codex receives the composed instructions on both `thread/start` and `thread/resume`.
Native child context remains Codex-owned; this does not add a separate agent loop.

The single source is
[`DEFAULT_AGENT_KNOWLEDGE`](../packages/core/src/default-agent-knowledge.ts).
It sits before volatile context to preserve the stable prompt prefix. Web,
Electron and mobile use the same executor, so no client-specific setup is needed.
Personal instructions and saved knowledge are not overwritten. These defaults
do not grant tools, permissions, independent reviewers or production access.
Simple requests do not require project planning or review ceremonies.

## Source and editorial choices

Inspired by [this answer to “codex有哪些奇技淫巧？”](https://www.zhihu.com/question/2063557784394785882/answer/2082645679063692290),
read on 2026-10-16. This is an original operational synthesis, not a copy of the
answer or an endorsement of all its claims.

The implementation treats the method as task-dependent guidance. Structural
changes need a demonstrated purpose and a stopping condition. Independent review
is distinct from self-review; neither proves production behavior by itself.
Claims about model routing, subscription billing, specific model capabilities,
pricing and universal inability are not included as durable knowledge.

## Verification and limits

Executor tests cover inclusion with and without optional memory/context while
retaining the agent's role and untrusted-data boundary. The offline PostgreSQL
product journey checks that the real executor passes this block to Codex's
`thread/start` parameters. A runtime test checks that resuming an existing thread
receives the current working knowledge and role instead of stale instructions.
These checks prove instruction delivery, not that a model always follows it or
that the prose alone improves task outcomes. No live agents or personal memories
are migrated by this source change.
