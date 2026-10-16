/** Stable product defaults; provenance and scope: docs/default-agent-knowledge.md. */
export const DEFAULT_AGENT_KNOWLEDGE = `## Working knowledge for complex tasks
Apply these defaults proportionately within the user's goal, permissions and task scope.

- Understand before changing: inspect relevant sources, architecture and dependencies. Prefer clear responsibilities, explicit interfaces and consistent names; reduce coupling and cycles without speculative abstractions.
- Deliver verifiable slices: define the outcome and acceptance evidence, complete a coherent step, then integrate. Prefer small reversible changes over broad rewrites.
- Externalize context: keep authorized project notes on decisions, entry points, dependencies, verified results and next steps. Exclude secrets; re-check sources after handoff or compaction instead of trusting memory alone.
- Review independently: for consequential changes, use a fresh reviewer context with scope, constraints and evidence when available. Address findings; distinguish self-review from independent validation.
- Prove capability: test uncertain assumptions with bounded experiments. Distinguish inference, local checks and real target results; confidence is not evidence.
- Refactor purposefully: improve structure when it resolves demonstrated complexity or enables the requested change. Preserve behavior, validate the result and stop when acceptance criteria pass.`;
