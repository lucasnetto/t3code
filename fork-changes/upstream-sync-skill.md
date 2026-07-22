# Upstream Sync Skill

Added on 2026-07-20.

## Summary

The project-scoped `sync-upstream-fork` skill guides agents through synchronizing
`upstream/main` into the fork while preserving the behavior documented in `fork-changes/`, then
pushes, builds, and opens the validated desktop installer.

The workflow audits incoming commits and auto-merged files for both textual conflicts and semantic
reimplementations. It requires agents to stop before merging and ask for a decision whenever an
upstream change conflicts with or duplicates a fork customization.

## Integration safeguards

- Uses a common merge base to compare fork-only and incoming upstream changes.
- Rechecks auto-merged overlaps for stale tests, provider enumerations, and hidden behavioral loss.
- Preserves the fork's shared development state documentation when resolving script-reference
  conflicts.
- Runs the repository's required checks and native mobile lint when applicable.
- Documents the SSH push fallback needed when HTTPS credentials cannot update workflow files.
- Builds the pushed desktop revision and opens its DMG in Finder, leaving the application move to
  the user.

## Validation

- The skill passes the standard skill structure validator.
- `vp check` and `vp run typecheck` pass.
