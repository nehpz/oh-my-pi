---
title: Cursor direct-delete policy denial must return CursorExecRejection
date: 2026-07-30
category: logic-errors
module: cursor-exec
problem_type: logic_error
component: assistant
symptoms:
- Cursor direct-delete policy refusals return a tool failure instead of a policy rejection
- Denied delete calls remain blocked but are reported with retryable failure semantics
- File-preservation assertions pass while the bridge response contract is wrong
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [cursor-exec, policy-denial, replant, rejection-contract, delete-tool]
related_components: [tooling, development-workflow, testing-framework]
---
# Cursor direct-delete policy denial must return `CursorExecRejection`

## Problem

The v17.2.0 replant retained the fork's Cursor policy-rejection patch and migrated its tests (`docs/fork-maintenance.md:88-113`). The conflict itself could be resolved mechanically, but a review of the surrounding execution path found contract drift in an adjacent upstream branch: direct `delete` policy refusals were represented as ordinary error `ToolResultMessage` values instead of `CursorExecRejection` values.

That distinction is behavioral, not cosmetic. The bridge documents that a protocol-level rejection makes the model treat the response as policy, while an error result reads as a broken environment and can trigger retries (`packages/coding-agent/src/cursor.ts:230-236`). The provider enforces the distinction: `CursorExecRejection` goes through `buildRejected(...)` (`packages/ai/src/providers/cursor.ts:2266-2270`), whereas a plain tool result goes through `buildFromToolResult(...)` (`packages/ai/src/providers/cursor.ts:2286-2288`).

## Symptoms

- A native delete blocked by `tools.approval = { delete: "deny" }` left the file intact but returned the wrong member of `ToolResultMessage | CursorExecRejection`.
- An `always-ask` session, which has no prompt channel for Cursor exec calls, failed closed but likewise reported an execution error rather than a policy rejection.
- Tests that asserted only `isError` and file preservation could pass without defending the provider-visible response variant.

## What Didn't Work

- **Stopping at the conflict markers.** A conflict can be mechanical while nearby upstream additions still violate a fork-owned contract. Textual resolution says nothing about the semantic compatibility of adjacent branches.
- **Treating every refusal as a tool error.** The message text alone does not select the provider's rejection path. `resolveExecHandler` dispatches by result shape, so an error `ToolResultMessage` still follows `buildFromToolResult(...)` even if its text says not to retry (`packages/ai/src/providers/cursor.ts:2266-2288`).
- **Testing only the side effect.** Both an error result and a structured rejection can leave the file untouched. File preservation proves the safety boundary, but not the protocol contract.

## Solution

`executeDelete` now converts every refusal returned by `refuseByWritePolicy(...)` into the same structured rejection used for ungranted native tools:

```typescript
const refusal = refuseByWritePolicy(options, toolName, pathArg);
if (refusal) {
	return buildNotGrantedRejection(
		options,
		toolName,
		toolCallId,
		`${refusal} This is a policy restriction, not a failure — do not retry.`,
	);
}
```

The implementation is at `packages/coding-agent/src/cursor.ts:337-362`. `buildNotGrantedRejection(...)` returns both the protocol discriminator and the paired transcript result (`packages/coding-agent/src/cursor.ts:238-253`):

```typescript
return {
	rejected,
	toolResult: createToolResultMessage(toolCallId, toolName, result, true),
};
```

The regression tests narrow the handler result with `asRejection(...)`, which fails if it receives a tool result (`packages/coding-agent/test/cursor-exec.test.ts:67-76`). They cover both policy branches:

- `deny` must include `"blocked by user policy"` and `"do not retry"`, and the target must remain (`packages/coding-agent/test/cursor-exec.test.ts:1489-1511`).
- `always-ask` must include `"requires approval"` and `"do not retry"`, and the target must remain (`packages/coding-agent/test/cursor-exec.test.ts:1513-1533`).

## Why This Works

The result now carries two complementary views of the same refusal:

1. `rejected` selects Cursor's protocol-level rejected variant through `buildRejected(...)`.
2. `toolResult` preserves a paired, error-marked transcript entry for the resolved call.

This keeps the model-facing policy semantics and the user-visible transcript consistent. The tests defend both observable contracts: the call is reported as a rejection, and the denied mutation does not occur.

## Prevention

- **Review the semantic radius of a mechanical conflict.** After resolving markers, inspect newly introduced conditionals and early returns around the hunk. A clean rebase does not prove the fork's return-shape, error, or policy contracts still hold.
- **Assert union discriminators explicitly.** For handlers returning `ToolResultMessage | CursorExecRejection`, use a narrowing helper such as `asRejection(...)`; do not infer the variant from shared text or `isError` fields.
- **Trace policy responses through the provider adapter.** Verify that denial branches reach `buildRejected(...)`, while genuine execution failures reach `buildFromToolResult(...)` or `buildError(...)`.
- **Test policy semantics and side effects separately.** A denial test should assert the response variant and reason, then independently assert that the protected resource is unchanged.
- **Cover promptless approval modes.** Any channel unable to ask the user must have an explicit, structured behavior for `always-ask`, not an accidental fallback through ordinary tool errors.

## Related Issues

- [Upstream sync for a history-truncated fork](../workflow-issues/upstream-sync-history-truncated-fork.md) — parent replant and verification workflow
- [Fork sync `.gitignore` rebase conflict](../workflow-issues/fork-sync-upstream-gitignore-rebase-conflict.md) — sibling mechanical-conflict incident
- [`docs/fork-maintenance.md`](../../fork-maintenance.md) — operating runbook and v17.2.0 sync log
- [`CONCEPTS.md`](../../../CONCEPTS.md) — fork-maintenance vocabulary
