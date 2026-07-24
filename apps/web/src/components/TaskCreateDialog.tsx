import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { ListTodoIcon } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import {
  createTaskCreateDialogFormState,
  reconcileTaskCreateEnvironmentSelection,
  resolveTaskCreateDialogLifecycleTransition,
  taskCreateDialogFormReducer,
} from "./TaskCreateDialog.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export interface TaskCreateDialogEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function TaskCreateDialog({
  open,
  onOpenChange,
  environments,
  primaryEnvironmentId,
  projects,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environments: ReadonlyArray<TaskCreateDialogEnvironment>;
  primaryEnvironmentId: EnvironmentId | null;
  projects: ReadonlyArray<EnvironmentProject>;
  onCreate: (input: {
    title: string;
    approvedProjects: ReadonlyArray<ScopedProjectRef>;
  }) => Promise<void>;
}) {
  const [formState, dispatchForm] = useReducer(
    taskCreateDialogFormReducer,
    undefined,
    createTaskCreateDialogFormState,
  );
  const [isCreating, setIsCreating] = useState(false);
  const [environmentSelection, setEnvironmentSelection] = useState<{
    readonly environmentId: EnvironmentId | null;
    readonly touched: boolean;
  }>({ environmentId: null, touched: false });
  const wasOpenRef = useRef(false);
  const environmentWasOpenRef = useRef(false);
  const projectEntries = useMemo(
    () =>
      projects.map((project) => {
        const ref = scopeProjectRef(project.environmentId, project.id);
        return {
          project,
          ref,
          key: scopedProjectKey(ref),
        };
      }),
    [projects],
  );
  const environmentOptions = useMemo(
    () =>
      environments.map((environment) => ({
        ...environment,
        hasEligibleProjects: projectEntries.some(
          (entry) => entry.project.environmentId === environment.environmentId,
        ),
      })),
    [environments, projectEntries],
  );
  const selectedEnvironmentProjects = useMemo(
    () =>
      environmentSelection.environmentId === null
        ? []
        : projectEntries.filter(
            (entry) => entry.project.environmentId === environmentSelection.environmentId,
          ),
    [environmentSelection.environmentId, projectEntries],
  );
  const availableProjectKeys = useMemo(
    () => selectedEnvironmentProjects.map((entry) => entry.key),
    [selectedEnvironmentProjects],
  );

  useEffect(() => {
    const wasOpen = environmentWasOpenRef.current;
    environmentWasOpenRef.current = open;
    setEnvironmentSelection((selection) => {
      const next = reconcileTaskCreateEnvironmentSelection({
        wasOpen,
        open,
        primaryEnvironmentId,
        environments: environmentOptions,
        selection,
      });
      return next.environmentId === selection.environmentId && next.touched === selection.touched
        ? selection
        : {
            environmentId: next.environmentId as EnvironmentId | null,
            touched: next.touched,
          };
    });
  }, [environmentOptions, open, primaryEnvironmentId]);

  useEffect(() => {
    const transition = resolveTaskCreateDialogLifecycleTransition({
      wasOpen: wasOpenRef.current,
      open,
      availableProjectKeys,
    });
    wasOpenRef.current = transition.nextWasOpen;
    if (transition.action) {
      dispatchForm(transition.action);
    }
  }, [availableProjectKeys, open]);

  const approvedProjects = useMemo(
    () =>
      selectedEnvironmentProjects
        .filter((entry) => formState.selectedProjectKeys.has(entry.key))
        .map((entry) => entry.ref),
    [formState.selectedProjectKeys, selectedEnvironmentProjects],
  );
  const canCreate = formState.title.trim().length > 0 && approvedProjects.length > 0 && !isCreating;

  const handleCreate = async () => {
    if (!canCreate) {
      return;
    }
    setIsCreating(true);
    try {
      await onCreate({
        title: formState.title.trim(),
        approvedProjects,
      });
      onOpenChange(false);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isCreating && onOpenChange(nextOpen)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListTodoIcon className="size-4" />
            New task
          </DialogTitle>
          <DialogDescription>
            Start a coordination thread with access to the repositories you approve. Checkouts are
            created only when a thread needs one.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium">Task title</span>
            <Input
              autoFocus
              value={formState.title}
              onChange={(event) =>
                dispatchForm({ type: "title-changed", title: event.target.value })
              }
              placeholder="Ship the payments release"
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
            />
          </label>
          {environmentOptions.length > 1 && environmentSelection.environmentId !== null ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">Execution environment</span>
              <Select
                value={environmentSelection.environmentId}
                onValueChange={(value) => {
                  const environmentId = value as EnvironmentId;
                  const nextProjectKeys = projectEntries
                    .filter((entry) => entry.project.environmentId === environmentId)
                    .map((entry) => entry.key);
                  setEnvironmentSelection({ environmentId, touched: true });
                  dispatchForm({
                    type: "environment-changed",
                    availableProjectKeys: nextProjectKeys,
                  });
                }}
                items={environmentOptions.map((environment) => ({
                  value: environment.environmentId,
                  label: environment.label,
                }))}
              >
                <SelectTrigger aria-label="Execution environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {environmentOptions.map((environment) => (
                    <SelectItem
                      key={environment.environmentId}
                      value={environment.environmentId}
                      disabled={!environment.hasEligibleProjects}
                    >
                      <span className="flex items-center justify-between gap-4">
                        <span>{environment.label}</span>
                        {!environment.hasEligibleProjects ? (
                          <span className="text-[11px] text-muted-foreground">
                            No Git repositories
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          ) : null}
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium">Approved repositories</legend>
            {selectedEnvironmentProjects.length === 0 ? (
              <div
                role="status"
                className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground"
              >
                No eligible Git repositories are available. Add a Git repository to a task-enabled
                environment before creating a task.
              </div>
            ) : null}
            {selectedEnvironmentProjects.map(({ project, key }) => {
              const checked = formState.selectedProjectKeys.has(key);
              return (
                <label
                  key={`${project.environmentId}:${project.id}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent/50"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(nextChecked) =>
                      dispatchForm({
                        type: "project-toggled",
                        projectKey: key,
                        selected: nextChecked,
                      })
                    }
                    aria-label={`Approve ${project.title}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{project.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate}>
            {isCreating ? "Creating…" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
