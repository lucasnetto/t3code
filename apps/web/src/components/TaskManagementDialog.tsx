import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentTask,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { BotIcon, FolderGit2Icon, ListPlusIcon, ListTodoIcon, Undo2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useThread } from "../state/entities";
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
  onCreateRepositoryThread,
  agentThreads,
  onRevertThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: EnvironmentTask;
  projects: ReadonlyArray<EnvironmentProject>;
  onApproveProject: (project: EnvironmentProject) => Promise<void>;
  onCreateThread: () => Promise<void>;
  onCreateRepositoryThread: (project: EnvironmentProject) => Promise<void>;
  agentThreads: ReadonlyArray<EnvironmentThreadShell>;
  onRevertThread: (thread: EnvironmentThreadShell, turnCount: number) => Promise<void>;
}) {
  const [approvingProjectId, setApprovingProjectId] = useState<string | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [creatingProjectId, setCreatingProjectId] = useState<string | null>(null);
  const [revertingThreadId, setRevertingThreadId] = useState<string | null>(null);
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

  const createRepositoryThread = async (project: EnvironmentProject) => {
    setCreatingProjectId(project.id);
    try {
      await onCreateRepositoryThread(project);
      onOpenChange(false);
    } finally {
      setCreatingProjectId(null);
    }
  };

  const revertThread = async (thread: EnvironmentThreadShell, turnCount: number) => {
    setRevertingThreadId(thread.id);
    try {
      await onRevertThread(thread, turnCount);
    } finally {
      setRevertingThreadId(null);
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

          {agentThreads.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium">Agent threads</h3>
              <div className="grid gap-2">
                {agentThreads.map((thread) => (
                  <TaskAgentThreadRow
                    key={thread.id}
                    thread={thread}
                    isReverting={revertingThreadId === thread.id}
                    disabled={revertingThreadId !== null}
                    onRevert={(turnCount) => void revertThread(thread, turnCount)}
                  />
                ))}
              </div>
            </section>
          ) : null}

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
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!taskIsActive || creatingProjectId !== null}
                    aria-label={`New thread in ${project.title}`}
                    onClick={() => void createRepositoryThread(project)}
                  >
                    {creatingProjectId === project.id ? "Creating…" : "New thread"}
                  </Button>
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

function TaskAgentThreadRow({
  thread,
  isReverting,
  disabled,
  onRevert,
}: {
  thread: EnvironmentThreadShell;
  isReverting: boolean;
  disabled: boolean;
  onRevert: (turnCount: number) => void;
}) {
  const detail = useThread(scopeThreadRef(thread.environmentId, thread.id));
  const checkpoints = (detail?.checkpoints ?? []).toSorted(
    (left, right) => right.checkpointTurnCount - left.checkpointTurnCount,
  );
  const currentTurnCount = checkpoints[0]?.checkpointTurnCount ?? 0;
  const revertTurnCounts = [
    ...new Set([
      ...checkpoints
        .filter((checkpoint) => checkpoint.checkpointTurnCount < currentTurnCount)
        .map((checkpoint) => checkpoint.checkpointTurnCount),
      ...(currentTurnCount > 0 ? [0] : []),
    ]),
  ];

  return (
    <div className="space-y-2 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-center gap-3">
        <BotIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{thread.title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {thread.branch ?? "Task workspace"}
          </span>
        </span>
      </div>
      {thread.worktreePath === null ? (
        <p className="text-[11px] text-muted-foreground">
          Conversation-only restore is unavailable for this task-root thread.
        </p>
      ) : revertTurnCounts.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No earlier checkpoint is available.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {revertTurnCounts.map((turnCount) => (
            <Button
              key={turnCount}
              size="xs"
              variant="outline"
              disabled={disabled || thread.latestTurn?.state === "running"}
              onClick={() => onRevert(turnCount)}
            >
              <Undo2Icon className="size-3" />
              {isReverting ? "Reverting…" : `Restore turn ${turnCount}`}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
