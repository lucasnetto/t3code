import type { ReactElement, ReactNode } from "react";
import type { EnvironmentProject, EnvironmentTask } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, TaskId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      return [
        slots[index] as T,
        (value) => {
          slots[index] =
            typeof value === "function" ? (value as (current: T) => T)(slots[index] as T) : value;
        },
      ];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

import { TaskManagementDialog } from "./TaskManagementDialog";

const task = {
  id: TaskId.make("task-1"),
  environmentId: EnvironmentId.make("env-1"),
  title: "Ship task",
  status: "active",
  rootPath: "/tasks/task-1",
  workspaceProjectId: ProjectId.make("task-workspace-1"),
  approvedProjectIds: [ProjectId.make("project-approved")],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  completedAt: null,
} satisfies EnvironmentTask;

const projects = [
  {
    id: ProjectId.make("project-approved"),
    environmentId: EnvironmentId.make("env-1"),
    title: "Approved repository",
    workspaceRoot: "/repos/approved",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  },
  {
    id: ProjectId.make("project-candidate"),
    environmentId: EnvironmentId.make("env-1"),
    title: "Candidate repository",
    workspaceRoot: "/repos/candidate",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  },
] satisfies ReadonlyArray<EnvironmentProject>;

function projectById(projectId: string): EnvironmentProject {
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Missing project fixture ${projectId}.`);
  }
  return project;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
}

type TestElement = ReactElement<{ readonly children?: ReactNode; readonly [key: string]: unknown }>;

function descendants(node: ReactNode): TestElement[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(descendants);
  }
  if (typeof node !== "object" || !("props" in node)) {
    return [];
  }
  const element = node as TestElement;
  return [element, ...descendants(element.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join("");
  }
  if (typeof node === "object" && "props" in node) {
    return textContent((node as TestElement).props.children);
  }
  return "";
}

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  task,
  projects,
  onUpdateTitle: vi.fn(async () => {}),
  onApproveProject: vi.fn(async () => {}),
  onCreateThread: vi.fn(async () => {}),
  onCreateRepositoryThread: vi.fn(async () => {}),
};

function render(
  props: Partial<Parameters<typeof TaskManagementDialog>[0]> = {},
): ReadonlyArray<TestElement> {
  hooks.beginRender();
  return descendants(TaskManagementDialog({ ...defaultProps, ...props }));
}

function byAriaLabel(elements: ReadonlyArray<TestElement>, label: string): TestElement {
  const element = elements.find(
    (candidate) => (candidate.props as { readonly "aria-label"?: string })["aria-label"] === label,
  );
  if (!element) {
    throw new Error(`Missing element with aria-label ${JSON.stringify(label)}.`);
  }
  return element;
}

function buttonByText(elements: ReadonlyArray<TestElement>, text: string): TestElement {
  const element = elements.find(
    (candidate) =>
      textContent(candidate.props.children) === text &&
      typeof (candidate.props as { readonly onClick?: unknown }).onClick === "function",
  );
  if (!element) {
    throw new Error(`Missing button with text ${JSON.stringify(text)}.`);
  }
  return element;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TaskManagementDialog", () => {
  beforeEach(() => {
    hooks.reset();
    defaultProps.onOpenChange.mockReset();
    defaultProps.onUpdateTitle.mockReset();
    defaultProps.onApproveProject.mockReset();
    defaultProps.onCreateThread.mockReset();
    defaultProps.onCreateRepositoryThread.mockReset();
  });

  it("keeps repository approval pending once and surfaces a retryable failure", async () => {
    const approval = deferred<void>();
    defaultProps.onApproveProject.mockReturnValue(approval.promise);

    const approveButton = byAriaLabel(render(), "Approve Candidate repository");
    (approveButton.props as { readonly onClick: () => void }).onClick();
    (approveButton.props as { readonly onClick: () => void }).onClick();

    expect(defaultProps.onApproveProject).toHaveBeenCalledTimes(1);
    const pendingElements = render();
    expect(textContent(byAriaLabel(pendingElements, "Approve Candidate repository"))).toBe(
      "Approving…",
    );
    expect(
      (
        buttonByText(pendingElements, "New coordination thread").props as {
          readonly disabled: boolean;
        }
      ).disabled,
    ).toBe(true);

    approval.reject(new Error("Repository approval was rejected."));
    await flushPromises();

    const failedElements = render();
    expect(textContent(byAriaLabel(failedElements, "Approve Candidate repository"))).toBe(
      "Approve",
    );
    expect(
      failedElements.some(
        (element) =>
          (element.props as { readonly role?: string }).role === "alert" &&
          textContent(element) === "Repository approval was rejected.",
      ),
    ).toBe(true);
  });

  it("moves a repository to the approved list only after the command succeeds", async () => {
    const approval = deferred<void>();
    defaultProps.onApproveProject.mockReturnValue(approval.promise);

    (
      byAriaLabel(render(), "Approve Candidate repository").props as {
        readonly onClick: () => void;
      }
    ).onClick();
    expect(byAriaLabel(render(), "Approve Candidate repository")).toBeDefined();

    approval.resolve();
    await flushPromises();

    const succeededElements = render();
    expect(
      succeededElements.some(
        (element) =>
          (element.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Approve Candidate repository",
      ),
    ).toBe(false);
    expect(
      succeededElements.some(
        (element) =>
          (element.props as { readonly role?: string }).role === "status" &&
          textContent(element) === "Candidate repository approved.",
      ),
    ).toBe(true);
  });

  it("offers Git candidates, disables known non-repositories, and hides internal projects", () => {
    const approvedProject = projectById("project-approved");
    const candidateProject = projectById("project-candidate");
    const eligibleProject = {
      ...candidateProject,
      repositoryIdentity: {
        canonicalKey: "example.test/candidate",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://example.test/candidate.git",
        },
      },
    } satisfies EnvironmentProject;
    const nonGitProject = {
      ...candidateProject,
      id: ProjectId.make("project-non-git"),
      title: "Documents",
      workspaceRoot: "/documents",
      repositoryIdentity: null,
    } satisfies EnvironmentProject;
    const internalProject = {
      ...candidateProject,
      id: ProjectId.make("project-task-internal"),
      title: "Task workspace",
      workspaceRoot: "/tasks/task-1",
      repositoryIdentity: null,
      visibility: "internal-task" as const,
    } satisfies EnvironmentProject;

    const elements = render({
      projects: [approvedProject, eligibleProject, nonGitProject, internalProject],
    });

    expect(
      (
        byAriaLabel(elements, "Approve Candidate repository").props as {
          readonly disabled: boolean;
        }
      ).disabled,
    ).toBe(false);
    const nonGitButton = byAriaLabel(elements, "Approve Documents");
    expect((nonGitButton.props as { readonly disabled: boolean }).disabled).toBe(true);
    expect(textContent(nonGitButton)).toBe("Not a Git repository");
    expect(
      elements.some(
        (element) =>
          (element.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Approve Task workspace",
      ),
    ).toBe(false);
  });

  it("keeps an already-approved non-Git project visible as history", () => {
    const approvedProject = projectById("project-approved");
    const candidateProject = projectById("project-candidate");
    const historicalProject = {
      ...candidateProject,
      id: ProjectId.make("project-historical"),
      title: "Historical repository",
      workspaceRoot: "/repos/historical",
      repositoryIdentity: null,
    } satisfies EnvironmentProject;
    const historicalTask = {
      ...task,
      approvedProjectIds: [...task.approvedProjectIds, historicalProject.id],
    } satisfies EnvironmentTask;

    const elements = render({
      task: historicalTask,
      projects: [approvedProject, historicalProject],
    });

    expect(textContent(elements)).toContain("Historical repository");
    expect(
      elements.some(
        (element) =>
          (element.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Approve Historical repository",
      ),
    ).toBe(false);
  });

  it("retains a failed title edit and only marks the confirmed title as saved", async () => {
    const update = deferred<void>();
    defaultProps.onUpdateTitle.mockReturnValue(update.promise);

    (
      byAriaLabel(render(), "Task title").props as {
        readonly onChange: (event: { target: { value: string } }) => void;
      }
    ).onChange({ target: { value: "Renamed task" } });
    const editedElements = render();
    const saveButton = buttonByText(editedElements, "Save");
    (saveButton.props as { readonly onClick: () => void }).onClick();
    (saveButton.props as { readonly onClick: () => void }).onClick();

    expect(defaultProps.onUpdateTitle).toHaveBeenCalledTimes(1);
    expect(defaultProps.onUpdateTitle).toHaveBeenCalledWith("Renamed task");
    expect(textContent(buttonByText(render(), "Saving…"))).toBe("Saving…");

    update.reject(new Error("Title update failed."));
    await flushPromises();

    const failedElements = render();
    expect(
      (byAriaLabel(failedElements, "Task title").props as { readonly value: string }).value,
    ).toBe("Renamed task");
    expect(
      failedElements.some(
        (element) =>
          (element.props as { readonly role?: string }).role === "alert" &&
          textContent(element) === "Title update failed.",
      ),
    ).toBe(true);
    expect(
      (buttonByText(failedElements, "Save").props as { readonly disabled: boolean }).disabled,
    ).toBe(false);
  });

  it("keeps the dialog open when thread creation fails and closes it only on success", async () => {
    const firstAttempt = deferred<void>();
    const secondAttempt = deferred<void>();
    defaultProps.onCreateThread
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(secondAttempt.promise);

    const createButton = buttonByText(render(), "New coordination thread");
    (createButton.props as { readonly onClick: () => void }).onClick();
    (createButton.props as { readonly onClick: () => void }).onClick();
    expect(defaultProps.onCreateThread).toHaveBeenCalledTimes(1);
    expect(defaultProps.onOpenChange).not.toHaveBeenCalled();

    firstAttempt.reject(new Error("Draft navigation failed."));
    await flushPromises();
    expect(defaultProps.onOpenChange).not.toHaveBeenCalled();
    expect(
      render().some(
        (element) =>
          (element.props as { readonly role?: string }).role === "alert" &&
          textContent(element) === "Draft navigation failed.",
      ),
    ).toBe(true);

    (
      buttonByText(render(), "New coordination thread").props as {
        readonly onClick: () => void;
      }
    ).onClick();
    secondAttempt.resolve();
    await flushPromises();

    expect(defaultProps.onCreateThread).toHaveBeenCalledTimes(2);
    expect(defaultProps.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps repository thread creation pending once and leaves the dialog open on failure", async () => {
    const creation = deferred<void>();
    defaultProps.onCreateRepositoryThread.mockReturnValue(creation.promise);

    const createButton = byAriaLabel(render(), "New thread in Approved repository");
    (createButton.props as { readonly onClick: () => void }).onClick();
    (createButton.props as { readonly onClick: () => void }).onClick();

    expect(defaultProps.onCreateRepositoryThread).toHaveBeenCalledExactlyOnceWith(projects[0]);
    expect(textContent(byAriaLabel(render(), "New thread in Approved repository"))).toBe(
      "Creating…",
    );

    creation.reject(new Error("Repository draft navigation failed."));
    await flushPromises();

    expect(defaultProps.onOpenChange).not.toHaveBeenCalled();
    expect(
      render().some(
        (element) =>
          (element.props as { readonly role?: string }).role === "alert" &&
          textContent(element) === "Repository draft navigation failed.",
      ),
    ).toBe(true);
  });
});
