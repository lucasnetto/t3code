# Multi-repository task workspaces

- Added a server task workspace service that derives new task roots beneath the configured
  worktree base while continuing to honor persisted roots for existing tasks.
- Added stable per-thread managed worktree paths beneath each task root.
- Added atomic generation and refresh of `TASK.md` with approved repositories, durable thread
  lineage, and coordination guidance.
- Treats paired clients and models as trusted operators: new task roots are server-derived and
  task and thread identifier segments always use one URL-safe base64 encoding, keeping generated
  paths lexically contained and injective without adding filesystem capability, hashes, storage
  metadata, or symlink-identity machinery. Official generated UUID identifiers keep segment
  lengths bounded.
- Existing persisted task roots remain authoritative and are not recomputed with the current
  identifier encoding when their context is refreshed.
- Defers canonical containment checks to the destructive cleanup boundary introduced in Phase 5;
  workspace creation does not attempt to defend against a trusted operator swapping symlinks.
