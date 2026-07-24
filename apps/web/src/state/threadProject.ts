import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";

export type ThreadProjectContext = Pick<EnvironmentThreadShell, "environmentId" | "projectId">;

export function threadProjectRef(thread: ThreadProjectContext): ScopedProjectRef {
  return scopeProjectRef(thread.environmentId, thread.projectId);
}
