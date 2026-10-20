---
name: omp-trace-triage
description: "Diagnose failures in a past omp session — model errors, tool-call error rates, subagent deaths (including instant exit-1 startup crashes) — by querying ~/.omp/stats.db and reading the session JSONL/artifact layout. Use when asked why a model failed, why subagents died, or whether a model is misbehaving in a recorded trace."
---

# Triaging an omp session trace

Answer "why did model X fail / why is tool error rate high" from recorded data, not guesswork.

## Where the data lives

| Thing | Path |
|---|---|
| Aggregate stats | `~/.omp/stats.db` (tables: `messages`, `tool_calls`, `user_messages`, `meta`) |
| Session transcript | `~/.omp/agent/sessions/<slugified-cwd>/<ts>_<uuid>.jsonl` |
| Subagent transcripts + spilled tool output | sibling dir `<ts>_<uuid>/` — `<AgentName>.jsonl`, `<AgentName>.md`, `<N>.<tool>.log` |
| User config | `~/.omp/agent/config.yml` |

`stats.db` mtime lags; the `-wal` holds recent writes. `sqlite3` reads it fine.

## Step 0 — instant subagent death (failed before its first turn)

`status="failed (exit 1)"`, duration under ~150ms, `<meta lines="1" size="0B" />`: the subagent failed while its session was being built. That is a reason to find the exception first, not a verdict. Two causes look identical here:
- **Policy rejection** — model selection throws `Usage depleted for <provider>/<model>…` or `Usage reserve reached…` when `retry.usageAwareFallback` is on and the reserve policy is fail-closed (`sdk.ts`). Quota, not a bug.
- **Harness exception** — a `TypeError`/stack from session construction. Code bug; provider is irrelevant.

Don't rule out quota/credentials until the error text says which.

1. The subagent's `<Name>.jsonl` holds only `title`/`session` lines and zero turns — it died before turn one; no diagnostics there.
2. The error is in the **parent** `.jsonl`: a `custom_message` with `customType: "async-result"` for background (async) tasks, or the parent `task` call's `toolResult` for blocking/synchronous tasks (`async.enabled` off or `blocking` agents). Follow `artifact://` references if the output spilled. JSON escapes the newlines, so regex the raw text:
   ```python
   raw = open(parent_jsonl).read()
   for m in re.finditer(r'.{600}<symbol-or-TypeError>.{600}', raw, re.S):
       print(m.group(0).replace('\\n', '\n'))
   ```
   `~/.omp/logs/` won't have it.
3. Crashes on one model role only ⇒ look for a model-conditional code path reached during construction (compare the dead and live roles in `modelRoles`). Verify the gate empirically in a script rather than reasoning about it.
4. This is a fork: check `git log --oneline <synced-tag>..upstream/main -- <file>` before writing a fix; cherry-pick upstream's (`git cherry-pick -n <sha>`) to avoid sync conflicts. Never `git checkout <sha> -- <file>` for one hunk (takes the whole file). Read the CHANGELOG diff — a cherry-picked entry can land in a released section; move it under `## [Unreleased]`.
5. Regression test must be red before the fix: pin the deciding condition via `Settings.isolated({...})` instead of depending on a specific model.
6. **Module cache:** the running omp keeps the pre-fix module. Re-dispatching from the same session still crashes with a trace showing code no longer on disk — not a failed fix. Verify in a fresh process; scratch scripts must live inside the workspace (e.g. `packages/coding-agent/verify.tmp.ts`) or `@oh-my-pi/*` imports fail. Then tell the user to restart omp.
7. Typecheck with `bun run check:ts`; `bun check` also runs `check:rs`, which fails here for missing `ninja` (environmental). For an unrelated batch failure, prove ownership: run the file alone, then the batch with your fix stashed.

## Step 1 — model-level failures

```sh
sqlite3 -header -column ~/.omp/stats.db \
 "select model, provider, api, stop_reason, count(*) n,
         sum(case when error_message is not null then 1 else 0 end) errs
  from messages where folder like '%<project>%' group by 1,2,3,4 order by n desc;"
```

`stop_reason='error'` rows are hard model failures. Get the text:

```sh
sqlite3 ~/.omp/stats.db \
 "select session_file, timestamp, duration, error_message from messages
  where folder like '%<project>%' and error_message is not null;"
```

`session_file` names the exact subagent that died.

## Step 2 — tool-level failures

```sh
sqlite3 -header -column ~/.omp/stats.db \
 "select model, tool_name, agent_type, count(*) n, sum(coalesce(is_error,0)) err
  from tool_calls where folder like '%<project>%'
  group by 1,2,3 order by err desc, n desc;"
```

Then resolve the error **text** — `is_error` alone tells you nothing about blame.

## Step 3 — read the actual error bodies

Common JSONL entry shapes (`type` field): `title`, `title_change`, `session`, `model_change`, `thinking_level_change`,
`session_init`, `custom_message`, `credential_pin`, `message`, `custom`, `compaction`, `branch_summary`.

`message.role` ∈ `user` | `assistant` | `toolResult`. **Tool results are top-level messages with
`role: "toolResult"`**, keyed by `message.toolCallId` — not `toolResult` content blocks inside user
messages. Assistant content blocks are `text` | `toolCall` | `thinking` | `image`.

Join error ids from `tool_calls` to `toolResult` messages across the main jsonl *and* every
`<AgentName>.jsonl` in the session dir:

```js
const ids = new Set(/* tool_call_id where is_error=1 */);
for (const m of entries)
  if (m.type === "message" && m.message.role === "toolResult" && ids.has(m.message.toolCallId))
    console.log(m.message.toolName, m.message.content.map(c => c.text).join("\n"));
```

## Step 4 — classify, don't accuse the model

Bucket every error before reporting a rate:

- **Environmental** — `extract_failed`, browser/eval timeouts, `fatal: not a git repository`, 403/bot-wall. Not the model.
- **Coordination no-ops** — e.g. `IRC wait aborted: no running peers remain` (removed `hub` tool; older traces). Flagged `is_error`, but a correct outcome; it inflates every rate.
- **Cascade** — parse errors on `agent://<Name>` output when that agent died upstream. Fix the root, these vanish.
- **Genuine model fault** — malformed function calls, schema rejections. Provider/stream failures show up as `stop_reason='error'` at the **message** layer, but malformed or schema-invalid tool arguments do **not**: they come back as ordinary `toolResult` messages with `isError: true` carrying the validation message (`validateAgentToolArguments`, `packages/agent/src/agent-loop.ts`). Zero message-layer errors does not clear the model; read the tool-result error text.

## Step 5 — subagent model routing

Which model ran each subagent:

```sh
cd <session-dir> && for f in *.jsonl; do
  printf "%-24s " "$f"; grep -m1 '"model_change"' $f | sed 's/.*"model":"\([^"]*\)".*/\1/'
done
```

Builtin agents pin **role aliases**, not models — `scout` → `@smol`, bundled `task` agent → `@task`
(`packages/coding-agent/src/task/agents.ts`). The alias resolves through `modelRoles` in
`config.yml`. A dead role = every subagent of that type dies instantly.

## Step 6 — the fallback gap

When a subagent dies on the first token with a quota/429 error, check:

```sh
grep -n -A6 "^retry:" ~/.omp/agent/config.yml
```

- `retry.modelFallback` defaults **true** — mechanism is live.
- `retry.fallbackChains: {}` — nothing to fall back *to*. This is the usual culprit.
- `retry.fallbackOn` (`any` | `usage-limit` | `except-usage-limit`, default `any`) — `except-usage-limit` deliberately skips fallback on quota errors.

A subagent uses its role's chain, and **falls back to `default` when the role has none**
(`resolveSubagentInheritedRetryFallbackChain`, `task/executor.ts`). An explicit empty role chain
(`smol: []`) disables that inheritance. Keys may also be model selectors or provider wildcards
(see `retry.fallbackChains` in `session/settings.ts`). For a scout-specific fallback, key on `smol`:

```yaml
retry:
  fallbackChains:
    smol: [openai-codex/gpt-5.6-luna:medium]
```

## Google RESOURCE_EXHAUSTED 429 note

`Resource has been exhausted (e.g. check quota).` + `status: RESOURCE_EXHAUSTED` is classified
`QUOTA_EXHAUSTED` in `packages/ai/src/error/rate-limit.ts` — the **account-quota lane**, not the short transient one.
That means a long backoff (30 min heuristic when no reset time is given), credential rotation, model fallback, or —
with `retry.waitForUsageReset: true` — sleeping until the reported reset and retrying the same model. Not proof of permanent exhaustion.
Contrast `Too many requests` / per-minute wording → `RATE_LIMIT_EXCEEDED`, which *is* backed off.
