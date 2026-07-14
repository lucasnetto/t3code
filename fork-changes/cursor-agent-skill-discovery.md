# Cursor Agent Skill Discovery

Added on 2026-07-14.

## Summary

Cursor provider snapshots now include Agent Skills discovered from the filesystem. These skills
appear in T3 Code's composer and use Cursor-compatible slash invocation, while Codex skill behavior
remains unchanged.

## Discovery locations

The Cursor provider scans directories containing `SKILL.md` under these roots:

| Root                         | Scope   |
| ---------------------------- | ------- |
| `~/.agents/skills`           | User    |
| `~/.cursor/skills`           | User    |
| `<workspace>/.agents/skills` | Project |
| `<workspace>/.cursor/skills` | Project |

Duplicate skill names are resolved deterministically. Higher-precedence definitions replace lower
ones in this order:

1. Project definitions override user definitions.
2. Cursor-native `.cursor/skills` definitions override shared `.agents/skills` definitions within
   the same scope.

Discovery follows directory symlinks while preventing cycles. Unreadable directories, malformed
YAML frontmatter, and invalid skill definitions are logged and skipped without making the Cursor
provider unavailable.

The `disable-model-invocation: true` frontmatter field does not disable a skill in T3 Code. Such
skills remain available for explicit manual invocation, matching Cursor's intended behavior.

## Composer behavior

- Cursor skills appear alongside commands when searching with `/` and are inserted as
  `/skill-name`.
- The existing `$` skill picker also inserts the provider-appropriate form when a skill is selected.
- Codex skills continue to be inserted as `$skill-name`.

## Implementation

- `apps/server/src/provider/cursorSkillDiscovery.ts` owns filesystem traversal, frontmatter parsing,
  precedence, and de-duplication.
- `CursorDriver` discovers skills for the initial provider snapshot.
- `checkCursorProviderStatus` refreshes skills during provider status checks and retains them across
  disabled, unavailable, timeout, and incompatible-version snapshot paths.
- The web composer uses a shared provider-aware serializer for skill invocation syntax.

## Current limitation

Project-scoped discovery uses the server's configured startup workspace. Cursor skills are not yet
refreshed specifically for each project switch in T3 Code's multi-project UI. User-scoped skills are
unaffected by this limitation.

## Validation

- Cursor discovery/provider/composer tests: 36 passed.
- `vp check`: passed.
- `vp run typecheck`: passed.
- The remaining repository suite passed 4,544 tests when the independently failing
  `apps/server/src/git/GitManager.test.ts` file was excluded. Its two commit-hook progress tests time
  out on the unchanged baseline, including when run alone outside the sandbox.
