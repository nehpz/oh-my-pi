---
title: omp Hosts Consume a Remote Auth Service as Broker Clients, Not Gateway Clients
date: 2026-10-03
category: decisions
module: coding-agent
problem_type: architecture_pattern
component: authentication
related_components:
  - api_layer
  - development_workflow
severity: medium
applies_when:
  - "moving omp auth-broker/auth-gateway off the machine where omp itself runs (e.g. to an always-on Mac mini)"
  - "deciding how a trusted omp host should reach a remote broker or gateway"
  - "someone proposes pointing omp at the auth-gateway the way OpenAI-compatible harnesses are pointed at it"
retire_when: "upstream ships a gateway-client mode that populates omp's catalog from the gateway's /v1/models over pi-native (track can1357/oh-my-pi#2420); check the auth-gateway docs and models.yml discovery types for it"
tags:
  - auth-broker
  - auth-gateway
  - pi-native
  - broker-client
  - remote-service-host
  - ssh-tunnel
  - models-yml
---

# omp Hosts Consume a Remote Auth Service as Broker Clients, Not Gateway Clients

## Context

The broker and gateway moved from the laptop to an always-on Mac mini so other LAN hosts could use the gateway. The open question was how the laptop's own omp should reach them. The intuitive answer — "omp should use the gateway like every OpenAI-compatible harness does, and the broker never needs to leave the mini" — turned out to be wrong for omp, and this session went back and forth on it several times before a live experiment settled it:

- First proposals over-built transport (Tailscale, Caddy with an internal CA) before the constraint "LAN-only, existing UniFi VPN for remote access" was stated. Per-client CA trust was rejected as too much friction.
- A gateway-only laptop was then proposed, first with hand-written per-provider `models.yml` blocks, then with `openai-models-list` discovery. Both were presented with claims (e.g. "pi-native loses fidelity") that were not verified and were partly wrong.
- A research pass with a live experiment (a second gateway on `127.0.0.1:14000` against the live broker, an omp client in a temp agent dir) produced the verdict below.

## Guidance

**A trusted omp host stays a broker client.** Point `auth.broker.url` at the remote broker. Keep the broker bound to loopback on the service host and reach it through an SSH local forward, so the laptop config stays `http://127.0.0.1:8765`:

```bash
ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8765:127.0.0.1:8765 -L 127.0.0.1:4000:127.0.0.1:4000 stephen@10.0.0.98
```

**Only non-omp consumers use the gateway** (`--bind=0.0.0.0:4000`, `http://<host>:4000/v1` + gateway token). Not `--bind=<lan-ip>`: that drops loopback, and the gateway reaches its own broker at `127.0.0.1:8765`.

Why not gateway-client mode for omp — what the live experiment showed (session observations; the gateway served 1357 `/v1/models` rows):

| Path | Result | Gap |
|---|---|---|
| `transport: pi-native` provider blocks (`models-config-schema-bundle.ts:357-363`) | Inference works, lossless | One block per provider, no wildcard; the model list is the client's **bundled** catalog (806 chat models listed vs 1208 served), so it drifts both ways — a listed-but-unserved model answers `Unknown model` |
| `discovery.type: openai-models-list` against the gateway | 1354 models, inference works | OpenAI wire only; rows lose kind/api typing, cost, provider thinking ladders; `baseUrl` must end in `/v1` or chat posts to `/chat/completions` and 404s |
| discovery **plus** pi-native | 404 | The client sends `${model.provider}/${model.id}` (`pi-native-client.ts:185`), i.e. `gwpn/anthropic/x`; the gateway resolves ids by exact map lookup (`auth-gateway-cli.ts:330`) |

Features that read credentials outside `streamSimple` also break in gateway-only mode — e.g. web search pulls keys from `authStorage` directly (`packages/coding-agent/src/web/search/providers/exa.ts:439-444`), and usage/quota display reads the broker.

Broker-client mode has none of these gaps and costs nothing extra: `/login` in a broker-client session uploads the credential to the remote broker (`RemoteAuthCredentialStore.upsertAuthCredential` → `POST /v1/credential`, `packages/ai/src/auth-broker/remote-store.ts:858-867`), so accounts are still managed from the laptop.

**The service host needs no `~/.omp` sync.** `omp auth-gateway serve` builds its registry with `ignoreLocalModelConfig: true` (`auth-gateway-cli.ts:294`) and loads no plugins, MCP servers, or marketplaces; it reads `auth.broker.url`, account-policy keys, and the token files. Copying `~/.omp` would only risk overwriting the live credential DB with stale refresh tokens.

## Why This Matters

- Treating omp as a gateway client makes omp a second-class consumer of its own auth service: a hand-maintained, drifting catalog and missing features, for no security gain on a trusted host.
- The real reason to keep the broker off the LAN is that broker snapshots carry plaintext OAuth access tokens and every API key; the SSH tunnel addresses that directly without demoting omp.
- Running two brokers over the same credentials disables them: the second refresh of a rotated refresh token gets `invalid_grant`, which is treated as definitive. Cutover must stop the old broker before the new one holds credentials, and credentials move with `omp auth-broker migrate --from-local --include-oauth`, not by copying `agent.db`.

## When to Apply

- Relocating or adding an auth service host for omp.
- Adding a new trusted omp machine (second workstation, SSH dev box) that should share credentials.
- Not for sandboxes that must stay credential-free (containerized omp, robomp slots): those are the intended pi-native gateway clients and accept the catalog trade-off.

## Examples

Laptop `~/.omp/agent/config.yml` before and after the move — unchanged, because the tunnel preserves the URL:

```yaml
auth.broker.url: http://127.0.0.1:8765
```

Service host `~/.omp/agent/config.yml` — the whole file:

```yaml
auth.broker.url: http://127.0.0.1:8765
```

Rejected laptop config (gateway client), for contrast:

```yaml
providers:
  anthropic:
    baseUrl: http://10.0.0.98:4000
    transport: pi-native
    apiKey: <gateway token>
  # …one block per provider; catalog = bundled, not served
```

## Related

- `docs/fork-maintenance.md` → "Service host (Mac mini)": plists, tunnel LaunchAgent, cutover order, `sync-upstream.ts deploy`.
- `docs/auth-broker-gateway.md`: broker/gateway endpoints, snapshot cache, pi-native.
- `docs/solutions/workflow-issues/upstream-sync-history-truncated-fork.md`: sync workflow whose service-restart section assumed co-located services.
- can1357/oh-my-pi#2420 (open): distribute a provider catalog from broker/gateway to clients — would close the bundled-catalog drift gap.
