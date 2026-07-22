---
name: sync-upstream-fork
description: Safely synchronize pingdotgg/t3code upstream/main into this fork, preserve documented fork behavior, push the result, and open the updated desktop installer. Use when asked to pull, merge, sync, or update from the main T3 Code project, audit incoming upstream changes against fork customizations, resolve an upstream-sync conflict, or prepare the locally installed fork for an update.
---

# Sync Upstream Fork

Synchronize `upstream/main` into the fork's `main` branch without silently losing or duplicating a change documented under `fork-changes/`.

## Guardrails

- Read the repository `AGENTS.md` and every `fork-changes/*.md` file before integrating.
- Preserve unrelated user work. Never reset, clean, or overwrite a dirty worktree.
- Do not print raw remote URLs; this repository may store credentials in them.
- Fetching and analysis are allowed before a decision. Do not merge when an incoming change conflicts with or reimplements a fork change until the user chooses how to proceed.
- Treat semantic overlap as seriously as a textual Git conflict.

## 1. Establish the baseline

1. Confirm the current branch, worktree status, remote names, and fork-change documents without displaying remote URLs.
2. Require a clean worktree before merging. If it is dirty, determine whether the changes belong to the user and stop when they cannot be preserved safely.
3. Fetch both remotes with pruning:

   ```sh
   git fetch --prune upstream
   git fetch --prune origin
   ```

4. Compute the merge base and ahead/behind counts:

   ```sh
   base=$(git merge-base HEAD upstream/main)
   git rev-list --left-right --count HEAD...upstream/main
   git log --oneline --no-merges HEAD..upstream/main
   ```

## 2. Audit incoming changes

Build both sides of the comparison from the same merge base:

```sh
base=$(git merge-base HEAD upstream/main)
git diff --name-status "$base"..HEAD
git diff --name-status "$base"..upstream/main
git merge-tree "$base" HEAD upstream/main
```

For each file changed on both sides:

1. Identify which `fork-changes/*.md` entry owns the fork behavior.
2. Inspect the relevant fork commit and incoming upstream commits, not only the aggregate diff.
3. Classify the overlap as:
   - orthogonal and safely auto-mergeable;
   - a textual conflict with compatible intent;
   - an upstream reimplementation that may make the fork code redundant;
   - a behavioral conflict requiring a product choice.
4. Check tests and configuration assertions for stale enumerations or expectations. Provider lists are especially likely to require inclusion of the fork-only `cursorSdk` provider after upstream edits.

If any conflict or reimplementation exists, stop before merging and ask the user. Report the upstream commit, affected fork-change document, behavioral difference, and a recommended resolution. Continue only after receiving a choice.

## 3. Merge without losing fork behavior

After approval, or when the audit finds no conflict:

```sh
git merge --no-edit upstream/main
```

Resolve conflicts according to the approved behavior. Prefer combining compatible improvements. For `docs/reference/scripts.md`, keep upstream's current `vp` commands, ports, and asset paths while retaining the fork's shared `~/.t3/userdata` behavior and concurrent-process warning.

After resolving textual conflicts, inspect every auto-merged overlap again. Verify that each documented fork feature still has its implementation and regression coverage. Update an existing `fork-changes/` document only when the fork-specific behavior or its implementation contract changed; do not create a fork-change document for a pure upstream merge.

## 4. Validate

If the lockfile or workspace dependencies changed, synchronize dependencies before judging missing-module errors:

```sh
CI=true vp install
```

Run the repository completion checks:

```sh
vp check
vp run typecheck
```

Run `vp run lint:mobile` when incoming changes touch native mobile code. Run focused tests for every conflict resolution and fork-overlap adjustment. For a broad upstream batch, run `vp test` as well.

When tests fail because the sandbox cannot bind loopback ports, rerun with the required permission. Distinguish environment failures from real merge regressions. Reproduce timeout failures independently before modifying production code.

Do not complete the sync while required checks fail. Fix unambiguous integration defects, such as a stale provider enumeration. Ask the user before making a behavioral choice not covered by the earlier approval.

## 5. Commit, push, and verify

Stage only the merge resolutions and integration fixes, then finish the merge commit. Push `main` to `origin` when the request is to update the fork.

If the configured HTTPS credential is rejected because an incoming `.github/workflows/` change requires workflow scope, use the user's existing SSH key without the repository's global SSH-to-HTTPS rewrite:

```sh
GIT_CONFIG_GLOBAL=/dev/null git push git@github.com:lucasnetto/t3code.git main:main
```

Finally fetch `origin/main` and verify:

```sh
git merge-base --is-ancestor upstream/main HEAD
git rev-parse HEAD origin/main
git status --short --branch
```

## 6. Build and open the pushed desktop version

After the commit is pushed and `origin/main` matches `HEAD`, build the desktop installer from that exact source revision. Do not build an uncommitted or unpushed revision. Skip this step only when the user explicitly asks.

On macOS:

1. Inspect `uname -m` and build the matching DMG. Use `vp run dist:desktop:dmg:arm64` on Apple Silicon or `vp run dist:desktop:dmg:x64` on Intel.
2. Use the exact DMG path reported by the build under `release/`; do not guess between stale artifacts.
3. Request GUI permission and run `open <exact-dmg-path>` so macOS mounts the image and shows it in Finder.
4. Leave the application move to the user. Do not quit the running app, write to `/Applications`, or replace an installed bundle.

On another platform, build the matching artifact and reveal it to the user without installing it automatically.

Report the merge commit, push result, opened installer path, conflict decisions, fork behaviors preserved, required checks, and any test flakes that only passed in isolation.
