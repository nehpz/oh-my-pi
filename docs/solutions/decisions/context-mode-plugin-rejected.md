---
title: "Reject: context-mode Plugin for omp (Native Context Stack Overlap)"
module: coding-agent
date: 2026-08-12
problem_type: adoption_decision
component: context_management
severity: low
decision: reject
reversibility: tier-1 (two-way door)
applies_when:
  - "someone proposes adding the context-mode plugin (github.com/mksglu/context-mode) to omp"
  - "evaluating external context-optimization/MCP-sandbox plugins for omp"
tags:
  - context-mode
  - adoption-decision
  - context-management
  - mcp
  - plugins
---

# Reject: context-mode plugin for omp

**Decision (2026-08-12):** Do not add the `context-mode` plugin to omp. Tier 1 (reversible), so this is a judgment call, not a permanent bar — see revisit condition.

## Why

Near-total structural overlap with omp's native context stack. context-mode's headline features already exist natively:

| context-mode feature | omp native equivalent |
|---|---|
| Sandbox tools keep raw output out of context | `artifact://` spill + selector recovery (`packages/coding-agent/src/tools/output-meta.ts`) |
| "Think in code" (`ctx_execute`) | persistent `eval` kernel (`packages/coding-agent/src/eval/`) |
| SQLite session memory + BM25 retrieval | Mnemopi retain/recall (`packages/coding-agent/src/mnemopi/`) |
| Compaction-survival snapshots | native multi-trigger compaction (`docs/compaction.md`) |
| Routing enforcement | omp tool policy / bash litmus |

Its omp adapter is not passive: 5 lifecycle hooks, 11 self-registered MCP tools, hard-blocks bash `curl`/`wget` with redirects, injects snapshots at `session_before_compact` — all layered on top of the native machinery it duplicates.

## Evidence (verified 2026-08-12)

- **#1037** — routing redirects subagents to `ctx_*` tools they don't have; models flagged the redirect as prompt injection.
- **#1022** — resume snapshot ignored `maxBytes`: ~196 KB injected vs "<2 KB" claim (v1.0.169).
- **#1031** — 11 resident tool definitions cost ~6,200 tokens per model call even when unused.
- **BENCHMARK.md** — "98%" is fixture byte-reduction only; author confirmed on HN (news.ycombinator.com/item?id=47193064) no answer-quality benchmarks exist.
- **License:** ELv2 (local use fine; hosted-service restriction).

## Revisit condition

The only capability omp lacks natively is the persistent FTS5 knowledge index (`ctx_index`/`ctx_search`). If that becomes wanted, install **MCP-only** (no hooks) so it cannot fight omp routing/compaction, and weigh it against Mnemopi recall first.
