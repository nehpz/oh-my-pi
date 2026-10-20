---
name: omp-provider-429-triage
description: "Distinguish a real account-quota 429 from a misclassified/provider-side 429 in omp, and trace which subagent model role a failing agent resolved to. Use when a model or subagent dies immediately with rate-limit/quota errors, or when asked why a specific agent type ran on a specific model."
---

# omp provider 429 triage

Two independent questions get conflated. Answer them separately.

## A. Is the 429 actually quota?

**Never infer quota from the error text or from omp's classification label.** Read the meter.

```bash
T=$(cat ~/.omp/auth-broker.token)
curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8765/v1/usage \
  | python3 -c "import json,sys;[print(json.dumps(r,indent=1)) for r in json.load(sys.stdin)['reports'] if r['provider']=='<PROVIDER>']"
```

Each report lists per-window `amount.usedFraction` / `remainingFraction`, `window.resetsAt`, and provider `metadata` (e.g. `endpoint`).

Related routes on the broker (`packages/ai/src/auth-broker/server.ts`, request handler):
`/v1/usage/history?sinceMs=`, `/v1/usage/clients`, `POST /v1/usage/observed`, `POST /v1/usage/stale` (invalidate the 5-min cache), `/v1/credentials/disabled?provider=`.

**Meter near 100% remaining + persistent 429 ⇒ investigate, don't conclude.** The report can be stale: the broker may serve a retained last-good report for hours after usage fetching fails, and `/usage` can lag the request path that just returned 429 (`packages/ai/src/auth/blocks.ts`). Check each report's `fetchedAt`, match the failing credential/account and model scope (the filter above is provider-only), `POST /v1/usage/stale` and refetch. Quota stays a candidate until a fresh, correctly scoped report rules it out.

## B. Reproduce serially

Concurrency and subagent fan-out are red herrings until ruled out:

```bash
omp --model <provider>/<model> -p "Reply with exactly: OK"
```

Note: the flag is `--model`, there is no `-m`.

Then try a sibling model on the same provider. Provider-wide failure ⇒ credential/project-level, not model-level.

## C. Why did this agent run on that model?

Chain, in order:

1. Subagent model in the trace: `grep -m1 '"model_change"' <Agent>.jsonl` inside the session artifact dir.
2. Agent definition: `packages/coding-agent/src/task/agents.ts` — `EMBEDDED_AGENT_DEFS` (scout's frontmatter lives in `src/prompts/agents/scout.md`). Bundled agents use role aliases, not concrete models:
   - `scout` → `@smol`, `tools: read, find, grep, glob, web_search`, structured `output:` schema
   - `sonic` → `@smol`, **`taskMd` template, full toolkit, no output schema**, fixed medium thinking, no `spawns`
   - `task` → `@task`, full toolkit, `spawns: "*"`, auto thinking
3. Role → model: `modelRoles` in `~/.omp/agent/config.yml`.

`sonic` is the flexible drop-in for `scout`: same model role, but full tools and a plain-text return, so it can write findings to a file instead of squeezing them through scout's read-only structured yield. It inherits the same `@smol` model, so a dead `smol` provider kills both.

## D. Survivability

A subagent on a dead role dies at first token when no fallback chain applies, even though `retry.modelFallback` defaults `true`. Also check `retry.fallbackOn`: `except-usage-limit` skips fallback on quota errors. The subagent uses its role's chain and **falls back to `default` when the role has none** (`resolveSubagentInheritedRetryFallbackChain`, `packages/coding-agent/src/task/executor.ts`); an explicit `smol: []` disables that inheritance. Model-selector and provider-wildcard keys also work. Role-specific override:

```yaml
retry:
  fallbackChains:
    smol: [<live-provider>/<model>:medium]
```

## Reading tool-call error rates

```sql
-- ~/.omp/stats.db
select model, tool_name, agent_type, count(*) n, sum(coalesce(is_error,0)) err
from tool_calls where folder like '%<repo>%' group by 1,2,3 order by err desc;

select model, provider, api, stop_reason, count(*) n,
       sum(case when error_message is not null then 1 else 0 end) errs
from messages where folder like '%<repo>%' group by 1,2,3,4;
```

Then read the actual failure text — counts alone mislead. Tool results live in the session JSONL as `role: "toolResult"` entries keyed by `toolCallId`; subagent results live in `<SessionDir>/<Agent>.jsonl`.

Before calling a model "bad at tool calls": message-layer `stop_reason='error'` rows are provider/stream failures, but malformed or schema-invalid tool arguments surface as `toolResult` messages with `isError: true` and the validation message — read those before clearing or blaming the model. Environmental failures that inflate the rate and mean nothing about the model:

- `Error: extract_failed` — bot-walled sites, an MCP/network fact
- `IRC wait aborted: no running peers remain` — a correct wait outcome from the removed `hub` tool (older traces) reported as `is_error`
- eval/browser 30s timeouts
- `fatal: not a git repository` — the cwd isn't a repo
- downstream parse errors caused by an *earlier* subagent dying
