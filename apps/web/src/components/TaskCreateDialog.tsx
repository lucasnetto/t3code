import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { ListTodoIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

export function TaskCreateDialog({
  open,
  onOpenChange,
  projects,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ReadonlyArray<EnvironmentProject>;
  onCreate: (input: {
    title: string;
    approvedProjects: ReadonlyArray<ScopedProjectRef>;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [selectedProjectIds, setSelectedProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle("");
    setSelectedProjectIds(new Set(projects[0] ? [projects[0].id] : []));
  }, [open, projects]);

  const approvedProjects = useMemo(
    () =>
      projects
        .filter((project) => selectedProjectIds.has(project.id))
        .map((project) => scopeProjectRef(project.environmentId, project.id)),
    [projects, selectedProjectIds],
  );
  const canCreate = title.trim().length > 0 && approvedProjects.length > 0 && !isCreating;

  const handleCreate = async () => {
    if (!canCreate) {
      return;
    }
    setIsCreating(true);
    try {
      await onCreate({
        title: title.trim(),
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
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Ship the payments release"
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  void handleCreate();
                }
              }}
            />
          </label>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-xs font-medium">Approved repositories</legend>
            {projects.map((project) => {
              const checked = selectedProjectIds.has(project.id);
              return (
                <label
                  key={`${project.environmentId}:${project.id}`}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-accent/50"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(nextChecked) =>
                      setSelectedProjectIds((current) => {
                        const next = new Set(current);
                        if (nextChecked) {
                          next.add(project.id);
                        } else {
                          next.delete(project.id);
                        }
                        return next;
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
