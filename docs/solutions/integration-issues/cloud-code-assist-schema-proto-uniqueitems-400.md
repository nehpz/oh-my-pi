---
title: Cloud Code Assist Rejects Tool Schemas Containing uniqueItems
date: 2026-08-27
category: integration-issues
module: ai
problem_type: integration_issue
component: api_layer
symptoms:
  - "Subagent spawn on google-antigravity/gemini-3.7-flash fails instantly with an opaque 400 from the Cloud Code Assist API"
  - "Provider error body reads Invalid JSON payload received. Unknown name \"uniqueItems\" at 'request.tools[0].function_declarations[130]...' Cannot find field."
  - "omp auth-gateway check passes and omp usage shows ~0% consumed, misdirecting diagnosis toward auth or quota"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags:
  - google-antigravity
  - cloud-code-assist
  - gemini
  - schema-normalization
  - uniqueitems
  - protojson
  - mcp-tools
  - http-400
---

# Cloud Code Assist Rejects Tool Schemas Containing uniqueItems

## Problem

Tool-enabled requests to the Google Antigravity provider (`google-antigravity/gemini-3.7-flash`) failed with an HTTP 400 from the Cloud Code Assist (CCA) API before any inference ran. An MCP server (netdata) declared `uniqueItems: true` on array parameters, and the CCA endpoint deserializes function declarations into a protobuf `Schema` via protojson, which rejects any unknown field outright — one unsupported keyword in one of 142 tool declarations 400s the entire request.

## Symptoms

- Agent turn or subagent spawn on `google-antigravity/gemini-3.7-flash` aborts immediately with an opaque 400.
- `~/.omp/logs/omp.<date>.<pid>.log` carries `warn "agent turn ended with provider error"` with the real body:

  ```text
  Cloud Code Assist API error (400): Invalid JSON payload received. Unknown name "uniqueItems"
  at 'request.tools[0].function_declarations[130].parameters.properties[5].value': Cannot find field.
  ```

- `omp auth-gateway check` passes (token valid) and `omp usage` shows near-zero consumption — the request dies at payload validation, before quota is touched.

## What Didn't Work

- **Suspecting auth/token expiry.** `omp auth-gateway check` passed; the token was never the problem. The 400 is a payload rejection, not 401/403.
- **Suspecting rate limits or quota.** `omp usage` showed 0.3% used. In observed failures (this session and a prior 429 investigation), requests rejected before inference left the usage counter flat — so a low reading cannot rule out failing requests.
- **Extrapolating from OpenAI/Anthropic behavior.** Those endpoints ignore unknown JSON-Schema keywords; Gemini's proto-based validation hard-fails on them. A toolset that works everywhere else can still 400 only on CCA.

## Solution

Fixed in `fix(ai): strip uniqueItems from Google/Antigravity tool schemas` (on `main` as `1883c786bc` after the v18.0.7 sync replay). One line — add the keyword to the Google/CCA strip list in `packages/ai/src/utils/schema/fields.ts` (`UNSUPPORTED_SCHEMA_FIELDS`, entry at line 31):

```typescript
export const UNSUPPORTED_SCHEMA_FIELDS: Record<string, true> = {
	// ...
	minItems: true,
	maxItems: true,
	uniqueItems: true, // added — CCA Schema proto has no such field
	minLength: true,
	// ...
};
```

Because `uniqueItems` is already in `LIFTABLE_TO_DESCRIPTION_FIELDS` (`fields.ts:77`), the constraint is not silently lost: the normalizer lifts it into the parameter description (`Dimensions\n\n{uniqueItems: true}`), so the model still sees the uniqueness intent while the wire schema stays proto-valid.

Regression test at `packages/ai/test/schema-normalization.test.ts:988` ("strips uniqueItems, which the Cloud Code Assist Schema proto rejects") asserts both the strip and the description lift, mirroring the existing `deprecated`/`readOnly` test.

### How the strip reaches the wire

- `normalizeSchemaForCCA` (`packages/ai/src/utils/schema/normalize.ts:1119`) runs with `unsupportedFields: isGoogleUnsupportedSchemaField` (`normalize.ts:196`, keyed on `UNSUPPORTED_SCHEMA_FIELDS`) and `liftStrippedToDescription: { format: "spill" }` (`normalize.ts:1129`).
- The Antigravity path converts each declaration's `parametersJsonSchema` to `parameters` through `normalizeAntigravityTools` (`packages/ai/src/providers/google-gemini-cli.ts:1201`), so every MCP tool schema passes through this strip before hitting CCA.

## Why This Works

CCA parses `functionDeclarations[].parameters` with strict protobuf deserialization: protojson treats any unrecognized field as `INVALID_ARGUMENT` ("Cannot find field") rather than ignoring it. Removing the keyword from the wire schema makes the payload proto-valid; the description lift preserves the semantic hint for the model. Same bug class was fixed before for `x-mcp-header` (`fields.ts:44`) and the annotation keywords `deprecated`/`readOnly`/`writeOnly`/`$comment` (`fields.ts:49-56`) — `uniqueItems` was simply missing from the list.

## Prevention

**Diagnosis recipe for any Antigravity/CCA 400:**

1. Don't trust `omp auth-gateway check` or `omp usage` to explain a 400 — both pass/stay flat when payload validation rejects the request pre-inference.
2. Grep `~/.omp/logs/omp.<date>.<pid>.log` for `agent turn ended with provider error` to get the raw error body.
3. The full request is dumped to `~/.omp/logs/http-400-requests/*.json`. Locate the offending keyword and tool:

   ```bash
   jq -r 'paths | select(.[-1]=="uniqueItems") | join(".")' <dump>.json
   jq -r '.body.request.tools[0].functionDeclarations[130].name' <dump>.json
   ```

**Fix pattern** — when CCA reports `Unknown name "<field>" ... Cannot find field`:

1. Add `<field>: true` to `UNSUPPORTED_SCHEMA_FIELDS` in `packages/ai/src/utils/schema/fields.ts` (and to `CCA_UNSUPPORTED_SCHEMA_FIELDS` if the Claude-on-CCA wire also rejects it).
2. If the field is a human-meaningful constraint (range, length, uniqueness, pattern), make sure it is in `LIFTABLE_TO_DESCRIPTION_FIELDS` so it lifts into the description instead of vanishing.
3. Add a regression test in `packages/ai/test/schema-normalization.test.ts` next to the `deprecated`/`readOnly` and `uniqueItems` tests.

## Related Issues

- `docs/solutions/workflow-issues/upstream-sync-history-truncated-fork.md` — separately notes `omp auth-gateway check --strict` is not a health gate.
- No matching GitHub issues found (`gh issue list --search "uniqueItems cloud code assist"`).
