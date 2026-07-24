# Multi-repository task shell state

- Added tasks to lightweight shell snapshots and live shell stream updates.
- Added shared client-runtime task atoms and environment-scoped task references for web and mobile
  consumers.
- Kept shell subscriptions backward compatible by requiring clients to opt in to task snapshot
  fields and task events after checking the advertised `taskShellEvents` capability.
- Refetches task live events through a single-task projection query so malformed unrelated project
  or thread rows cannot strand task shell state at an older value.
- Kept the `taskThreads` capability unadvertised until the task creation and navigation UI is
  available, avoiding exposure of an incomplete feature during stacked rollout.
