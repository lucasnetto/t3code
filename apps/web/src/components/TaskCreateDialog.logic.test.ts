import { describe, expect, it } from "vite-plus/test";

import {
  createTaskCreateDialogFormState,
  reconcileTaskCreateEnvironmentSelection,
  resolvePreferredTaskCreateEnvironment,
  resolveTaskCreateDialogLifecycleTransition,
  taskCreateDialogFormReducer,
  type TaskCreateDialogFormState,
} from "./TaskCreateDialog.logic";

function reduce(
  state: TaskCreateDialogFormState,
  ...actions: ReadonlyArray<Parameters<typeof taskCreateDialogFormReducer>[1]>
) {
  return actions.reduce(taskCreateDialogFormReducer, state);
}

function selectedProjects(state: TaskCreateDialogFormState): ReadonlyArray<string> {
  return [...state.selectedProjectKeys];
}

describe("taskCreateDialogFormReducer", () => {
  it("falls back from an empty primary environment to the first eligible environment", () => {
    expect(
      resolvePreferredTaskCreateEnvironment({
        primaryEnvironmentId: "primary",
        environments: [
          { environmentId: "primary", hasEligibleProjects: false },
          { environmentId: "remote-a", hasEligibleProjects: true },
          { environmentId: "remote-b", hasEligibleProjects: true },
        ],
      }),
    ).toBe("remote-a");
  });

  it("prefers the primary environment when it has an eligible repository", () => {
    expect(
      resolvePreferredTaskCreateEnvironment({
        primaryEnvironmentId: "primary",
        environments: [
          { environmentId: "remote", hasEligibleProjects: true },
          { environmentId: "primary", hasEligibleProjects: true },
        ],
      }),
    ).toBe("primary");
  });

  it("returns no environment when no visible Git repositories are eligible", () => {
    expect(
      resolvePreferredTaskCreateEnvironment({
        primaryEnvironmentId: "primary",
        environments: [
          { environmentId: "primary", hasEligibleProjects: false },
          { environmentId: "remote", hasEligibleProjects: false },
        ],
      }),
    ).toBeNull();
  });

  it("selects the first eligible environment when repositories arrive asynchronously", () => {
    const initiallyEmpty = reconcileTaskCreateEnvironmentSelection({
      wasOpen: false,
      open: true,
      primaryEnvironmentId: "primary",
      environments: [
        { environmentId: "primary", hasEligibleProjects: false },
        { environmentId: "remote", hasEligibleProjects: false },
      ],
      selection: { environmentId: null, touched: false },
    });
    const afterArrival = reconcileTaskCreateEnvironmentSelection({
      wasOpen: true,
      open: true,
      primaryEnvironmentId: "primary",
      environments: [
        { environmentId: "primary", hasEligibleProjects: false },
        { environmentId: "remote", hasEligibleProjects: true },
      ],
      selection: initiallyEmpty,
    });

    expect(initiallyEmpty).toEqual({ environmentId: null, touched: false });
    expect(afterArrival).toEqual({ environmentId: "remote", touched: false });
  });

  it("preserves an explicit environment choice while the dialog remains open", () => {
    const selection = reconcileTaskCreateEnvironmentSelection({
      wasOpen: true,
      open: true,
      primaryEnvironmentId: "primary",
      environments: [
        { environmentId: "primary", hasEligibleProjects: true },
        { environmentId: "remote", hasEligibleProjects: true },
      ],
      selection: { environmentId: "remote", touched: true },
    });

    expect(selection).toEqual({ environmentId: "remote", touched: true });
  });

  it("treats project refreshes during one open cycle as reconciliation, not initialization", () => {
    const opened = resolveTaskCreateDialogLifecycleTransition({
      wasOpen: false,
      open: true,
      availableProjectKeys: [],
    });
    const refreshed = resolveTaskCreateDialogLifecycleTransition({
      wasOpen: opened.nextWasOpen,
      open: true,
      availableProjectKeys: ["primary:web"],
    });

    expect(opened.action).toEqual({ type: "opened", availableProjectKeys: [] });
    expect(refreshed.action).toEqual({
      type: "projects-changed",
      availableProjectKeys: ["primary:web"],
    });
  });

  it("starts a fresh initialization only after a committed close transition", () => {
    const closed = resolveTaskCreateDialogLifecycleTransition({
      wasOpen: true,
      open: false,
      availableProjectKeys: ["primary:web"],
    });
    const reopened = resolveTaskCreateDialogLifecycleTransition({
      wasOpen: closed.nextWasOpen,
      open: true,
      availableProjectKeys: ["secondary:docs"],
    });

    expect(closed.action).toEqual({ type: "closed" });
    expect(reopened.action).toEqual({
      type: "opened",
      availableProjectKeys: ["secondary:docs"],
    });
  });

  it("selects the first project that arrives asynchronously without clearing the title", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      { type: "opened", availableProjectKeys: [] },
      { type: "title-changed", title: "Ship payments" },
      { type: "projects-changed", availableProjectKeys: ["primary:payments", "primary:api"] },
    );

    expect(state.title).toBe("Ship payments");
    expect(selectedProjects(state)).toEqual(["primary:payments"]);
    expect(state.projectSelectionTouched).toBe(false);
  });

  it("reconciles project list churn without resetting surviving selections or title edits", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      {
        type: "opened",
        availableProjectKeys: ["primary:web", "primary:api", "primary:worker"],
      },
      { type: "title-changed", title: "Coordinate release" },
      { type: "project-toggled", projectKey: "primary:api", selected: true },
      {
        type: "projects-changed",
        availableProjectKeys: ["primary:api", "primary:worker", "primary:docs"],
      },
    );

    expect(state.title).toBe("Coordinate release");
    expect(selectedProjects(state)).toEqual(["primary:api"]);
    expect(state.projectSelectionTouched).toBe(true);
  });

  it("fully resets a closed form before a new open intent", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      { type: "opened", availableProjectKeys: ["primary:web", "primary:api"] },
      { type: "title-changed", title: "First task" },
      { type: "project-toggled", projectKey: "primary:api", selected: true },
      { type: "closed" },
      { type: "opened", availableProjectKeys: ["secondary:docs"] },
    );

    expect(state.title).toBe("");
    expect(selectedProjects(state)).toEqual(["secondary:docs"]);
    expect(state.projectSelectionTouched).toBe(false);
  });

  it("does not repopulate an intentionally empty selection when projects refresh", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      { type: "opened", availableProjectKeys: ["primary:web", "primary:api"] },
      { type: "project-toggled", projectKey: "primary:web", selected: false },
      {
        type: "projects-changed",
        availableProjectKeys: ["primary:web", "primary:api", "primary:worker"],
      },
    );

    expect(selectedProjects(state)).toEqual([]);
    expect(state.projectSelectionTouched).toBe(true);
  });

  it("retains every explicit selection that remains available", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      { type: "opened", availableProjectKeys: ["primary:web", "primary:api"] },
      { type: "project-toggled", projectKey: "primary:api", selected: true },
      {
        type: "projects-changed",
        availableProjectKeys: ["primary:worker", "primary:api", "primary:web"],
      },
    );

    expect(new Set(selectedProjects(state))).toEqual(new Set(["primary:web", "primary:api"]));
  });

  it("drops deleted or hidden selections without approving a newly visible repository", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      { type: "opened", availableProjectKeys: ["primary:web", "primary:private"] },
      { type: "project-toggled", projectKey: "primary:private", selected: true },
      { type: "project-toggled", projectKey: "primary:web", selected: false },
      {
        type: "projects-changed",
        availableProjectKeys: ["primary:newly-visible"],
      },
    );

    expect(selectedProjects(state)).toEqual([]);
    expect(state.projectSelectionTouched).toBe(true);
  });

  it("selects the first repository in an explicitly chosen environment", () => {
    const state = reduce(
      createTaskCreateDialogFormState(),
      { type: "opened", availableProjectKeys: ["primary:web"] },
      { type: "title-changed", title: "Ship payments" },
      {
        type: "environment-changed",
        availableProjectKeys: ["remote:api", "remote:worker"],
      },
    );

    expect(state.title).toBe("Ship payments");
    expect(selectedProjects(state)).toEqual(["remote:api"]);
    expect(state.projectSelectionTouched).toBe(false);
  });
});
