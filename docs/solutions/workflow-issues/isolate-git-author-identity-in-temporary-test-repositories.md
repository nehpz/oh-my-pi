---
title: "Keep Git Fixture Identities Command-Scoped"
date: 2026-07-31
category: workflow-issues
module: sync-upstream
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - "Tests initialize temporary Git repositories and create fixture commits"
  - "Tests must pass without a developer's global or system Git identity"
  - "Placeholder commit identities appear in repository history and need attribution"
symptoms:
  - "Temporary repositories retain placeholder user.name and user.email values in local Git configuration"
  - "Fixture setup masks whether the command under test supplies the identity it requires"
root_cause: test_isolation
resolution_type: test_fix
related_components:
  - development_workflow
  - tooling
tags:
  - git-identity
  - test-isolation
  - sync-upstream
  - command-scoped-config
  - git-fixtures
---

# Keep Git Fixture Identities Command-Scoped

## Context

Tests for Git-aware tooling often initialize temporary repositories and create commits as fixtures. A fixture needs an author and committer identity, but persisting that identity with `git config user.name` and `git config user.email` changes the repository under test. Later commands then inherit test-only state, which can mask missing identity handling and makes the fixture less representative of an unconfigured environment.

An apparent identity leak into another repository also exposed a forensic trap: a historical commit's author and committer strings describe how that immutable commit object was created. They do not prove which configuration is active now or which process supplied the identity. Similar-looking placeholder addresses must not be attributed to a test or tool without matching timestamps, exact values, reachability, and process evidence.

## Guidance

### Scope identity to the commit command

Pass fixture identity through Git's command-scoped `-c` options on the operation that needs it:

```typescript
await $`git add tracked.txt && git -c user.name=Test -c user.email=test@example.invalid commit -m init`
	.cwd(dir)
	.quiet();
```

The sync test suite applies this pattern to each fixture commit rather than configuring the temporary repository (`scripts/sync-upstream.test.ts:366-378`, `scripts/sync-upstream.test.ts:392-440`). The `.invalid` top-level domain keeps the illustrative address deliberately non-resolving.

Avoid persistent fixture configuration:

```typescript
await $`git config user.email "test@example.com"`.cwd(dir).quiet();
await $`git config user.name "Test"`.cwd(dir).quiet();
await $`git commit -m init`.cwd(dir).quiet();
```

Repository-local configuration is less dangerous than `--global`, but it still mutates `.git/config` and affects every later Git command in that fixture. The narrow requirement is only to identify the fixture commit, so the narrowest configuration scope is the command itself.

### Assert the absence of local identity state

Exercise the observable contract after the commit:

```typescript
const localEmail = await $`git config --local --get user.email`.cwd(dir).quiet().nothrow();
const localName = await $`git config --local --get user.name`.cwd(dir).quiet().nothrow();
expect(localEmail.exitCode).not.toBe(0);
expect(localName.exitCode).not.toBe(0);
```

These assertions verify that both keys remain absent from repository-local configuration (`scripts/sync-upstream.test.ts:375-378`). They protect behavior rather than source shape: the test would still accept a different implementation that creates the commit without persisting identity.

### Verify without ambient Git identity

Run the affected suite with system and global configuration disabled:

```bash
GIT_CONFIG_NOSYSTEM=1 \
GIT_CONFIG_GLOBAL=/dev/null \
bun run test:scripts
```

This proves that fixture commits receive identity from their own command rather than the developer workstation. During the change that established this convention, the command completed with 79 passing script tests and no failures. The suite is part of the root `test:scripts` command (`package.json:120`), the shared repository script-test set (`scripts/ci-test-ts.ts:120-128`), and the full local TypeScript runner (`scripts/ci-test-ts.ts:385-400`).

### Investigate historical identities separately

When placeholder identities appear in published history:

1. Inspect both author and committer fields, timestamps, parents, and subjects.
2. Check which refs contain the commits and whether they are already remote.
3. Compare the exact email value; `test@example` and `test@example.invalid` are not the same evidence.
4. Inspect current local, global, environment, and tool-specific identity settings, but do not treat current settings as proof of historical origin.
5. Record the origin as unproven unless process logs or equivalent evidence connect the commit creation to a specific tool.

Do not rewrite published commits merely to correct attribution without treating it as a coordinated history rewrite: changing commit headers changes commit IDs and every descendant ID.

## Why This Matters

Command-scoped identity keeps temporary repositories hermetic. The commit succeeds even on a clean CI machine, while later operations still see the repository state the test intended rather than hidden setup state. Negative assertions prevent a regression back to persistent local configuration.

Separating prevention from attribution also avoids a false root-cause claim. Tightening a test fixture can eliminate one possible source of future placeholder metadata without proving that the fixture created unrelated historical commits.

## When to Apply

- Integration tests create real commits in temporary repositories.
- A test suite runs with global Git configuration removed or replaced.
- A helper creates multiple fixture repositories and must not carry identity state between them.
- A placeholder author appears in history and the producing process is not directly observed.

## Examples

Use command configuration for each commit that requires an identity:

```bash
git -c user.name=Test \
    -c user.email=test@example.invalid \
    commit -m "fixture commit"
```

Then confirm the repository was not configured:

```bash
git config --local --get user.name   # expected non-zero exit
git config --local --get user.email  # expected non-zero exit
```

Inspect historical metadata without assuming its source:

```bash
git log --all --format='%h %ad | %an <%ae> | %cn <%ce> | %s' --date=iso
git for-each-ref --contains <commit> --format='%(refname)'
git config --show-origin --get-regexp '^user\.(name|email)$'
```

## Related

- [Fork sync `.gitignore` conflicts and Bazel verification](./fork-sync-upstream-gitignore-rebase-conflict.md) — includes earlier isolation work in the same sync test suite.
- [Upstream sync for a history-truncated fork](./upstream-sync-history-truncated-fork.md) — describes the broader replant workflow these tests protect.
