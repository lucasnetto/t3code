import type { EnvironmentProject, EnvironmentTask } from "@t3tools/client-runtime/state/models";
import { FolderGit2Icon, ListPlusIcon, ListTodoIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

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
import { Input } from "./ui/input";

type TaskManagementFeedback =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "success"; readonly message: string };

interface TaskTitleEditorState {
  readonly draft: string;
  readonly lastTaskTitle: string;
  readonly saved: string;
}

function formatActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "The task update failed. Try again.";
}

export function TaskManagementDialog({
  open,
  onOpenChange,
  task,
  projects,
  onUpdateTitle,
  onApproveProject,
  onCreateThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: EnvironmentTask;
  projects: ReadonlyArray<EnvironmentProject>;
  onUpdateTitle: (title: string) => Promise<void>;
  onApproveProject: (project: EnvironmentProject) => Promise<void>;
  onCreateThread: () => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
  const [feedback, setFeedback] = useState<TaskManagementFeedback | null>(null);
  const [titleEditor, setTitleEditor] = useState<TaskTitleEditorState>({
    draft: task.title,
    lastTaskTitle: task.title,
    saved: task.title,
  });
  if (titleEditor.lastTaskTitle !== task.title) {
    setTitleEditor({
      draft: titleEditor.draft === titleEditor.saved ? task.title : titleEditor.draft,
      lastTaskTitle: task.title,
      saved: task.title,
    });
  }
  const [confirmedProjectIds, setConfirmedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const approvedProjectIds = useMemo(
    () => new Set([...task.approvedProjectIds, ...confirmedProjectIds]),
    [confirmedProjectIds, task.approvedProjectIds],
  );
  const approvedProjects = useMemo(
    () => projects.filter((project) => approvedProjectIds.has(project.id)),
    [approvedProjectIds, projects],
  );
  const availableProjects = useMemo(
    () =>
      projects.filter(
        (project) => !approvedProjectIds.has(project.id) && project.visibility !== "internal-task",
      ),
    [approvedProjectIds, projects],
  );
  const taskIsActive = task.status === "active";
  const isBusy = pendingAction !== null;
  const normalizedTitle = titleEditor.draft.trim();
  const titleChanged = normalizedTitle !== titleEditor.saved;

  const runAction = async (
    actionId: string,
    action: () => Promise<void>,
    successMessage: string,
  ): Promise<boolean> => {
    if (pendingActionRef.current !== null) {
      return false;
    }
    pendingActionRef.current = actionId;
    setPendingAction(actionId);
    setFeedback(null);
    try {
      await action();
      setFeedback({ kind: "success", message: successMessage });
      return true;
    } catch (error) {
      setFeedback({ kind: "error", message: formatActionError(error) });
      return false;
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  const updateTitle = async () => {
    if (!taskIsActive || normalizedTitle.length === 0 || !titleChanged) {
      return;
    }
    const didUpdate = await runAction(
      "update-title",
      () => onUpdateTitle(normalizedTitle),
      "Task title updated.",
    );
    if (didUpdate) {
      setTitleEditor({
        draft: normalizedTitle,
        lastTaskTitle: task.title,
        saved: normalizedTitle,
      });
    }
  };

  const approveProject = async (project: EnvironmentProject) => {
    const didApprove = await runAction(
      `approve-project:${project.id}`,
      () => onApproveProject(project),
      `${project.title} approved.`,
    );
    if (didApprove) {
      setConfirmedProjectIds((current) => new Set([...current, project.id]));
    }
  };

  const createThread = async () => {
    const didCreate = await runAction(
      "create-thread",
      onCreateThread,
      "Coordination thread created.",
    );
    if (didCreate) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isBusy && onOpenChange(nextOpen)}>
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
            <h3 className="text-xs font-medium">Task title</h3>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Task title"
                disabled={!taskIsActive || isBusy}
                onChange={(event) =>
                  setTitleEditor((current) => ({ ...current, draft: event.target.value }))
                }
                value={titleEditor.draft}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!taskIsActive || isBusy || normalizedTitle.length === 0 || !titleChanged}
                onClick={() => void updateTitle()}
              >
                {pendingAction === "update-title" ? "Saving…" : "Save"}
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium">User threads</h3>
              <Button
                size="sm"
                variant="outline"
                disabled={!taskIsActive || isBusy}
                onClick={() => void createThread()}
              >
                <ListPlusIcon className="size-3.5" />
                {pendingAction === "create-thread" ? "Creating…" : "New coordination thread"}
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
                  const isApproving = pendingAction === `approve-project:${project.id}`;
                  const isKnownNonRepository = project.repositoryIdentity === null;
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
                        disabled={!taskIsActive || isBusy || isKnownNonRepository}
                        aria-label={`Approve ${project.title}`}
                        onClick={() => void approveProject(project)}
                      >
                        {isKnownNonRepository
                          ? "Not a Git repository"
                          : isApproving
                            ? "Approving…"
                            : "Approve"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {feedback ? (
            <p
              className={
                feedback.kind === "error"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
              role={feedback.kind === "error" ? "alert" : "status"}
            >
              {feedback.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isBusy} variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
