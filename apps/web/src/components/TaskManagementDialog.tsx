import type { EnvironmentProject, EnvironmentTask } from "@t3tools/client-runtime/state/models";
import { FolderGit2Icon, ListPlusIcon, ListTodoIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

export function TaskManagementDialog({
  open,
  onOpenChange,
  task,
  projects,
  onApproveProject,
  onCreateThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: EnvironmentTask;
  projects: ReadonlyArray<EnvironmentProject>;
  onApproveProject: (project: EnvironmentProject) => Promise<void>;
  onCreateThread: () => Promise<void>;
}) {
  const [approvingProjectId, setApprovingProjectId] = useState<string | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const approvedProjectIds = useMemo(
    () => new Set(task.approvedProjectIds),
    [task.approvedProjectIds],
  );
  const approvedProjects = useMemo(
    () => projects.filter((project) => approvedProjectIds.has(project.id)),
    [approvedProjectIds, projects],
  );
  const availableProjects = useMemo(
    () => projects.filter((project) => !approvedProjectIds.has(project.id)),
    [approvedProjectIds, projects],
  );
  const taskIsActive = task.status === "active";

  const approveProject = async (project: EnvironmentProject) => {
    setApprovingProjectId(project.id);
    try {
      await onApproveProject(project);
    } finally {
      setApprovingProjectId(null);
    }
  };

  const createThread = async () => {
    setIsCreatingThread(true);
    try {
      await onCreateThread();
      onOpenChange(false);
    } finally {
      setIsCreatingThread(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodoIcon className="size-4" />
            {task.title}
          </DialogTitle>
          <DialogDescription>
            Manage coordination threads and repositories. Approving a repository does not create a
            checkout.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium">User threads</h3>
              <Button
                size="sm"
                variant="outline"
                disabled={!taskIsActive || isCreatingThread}
                onClick={() => void createThread()}
              >
                <ListPlusIcon className="size-3.5" />
                {isCreatingThread ? "Creating…" : "New coordination thread"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              The new thread starts at the task workspace and becomes durable with its first
              message.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium">Approved repositories</h3>
            <div className="grid gap-2">
              {approvedProjects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
                >
                  <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{project.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {availableProjects.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium">Add repository</h3>
              <div className="grid gap-2">
                {availableProjects.map((project) => {
                  const isApproving = approvingProjectId === project.id;
                  return (
                    <div
                      key={project.id}
                      className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5"
                    >
                      <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{project.title}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!taskIsActive || approvingProjectId !== null}
                        aria-label={`Approve ${project.title}`}
                        onClick={() => void approveProject(project)}
                      >
                        {isApproving ? "Approving…" : "Approve"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
