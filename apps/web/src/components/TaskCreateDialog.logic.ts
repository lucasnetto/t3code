export interface TaskCreateDialogFormState {
  readonly title: string;
  readonly selectedProjectKeys: ReadonlySet<string>;
  readonly projectSelectionTouched: boolean;
}

export interface TaskCreateDialogEnvironmentOption {
  readonly environmentId: string;
  readonly hasEligibleProjects: boolean;
}

export interface TaskCreateDialogEnvironmentSelection {
  readonly environmentId: string | null;
  readonly touched: boolean;
}

export type TaskCreateDialogFormAction =
  | {
      readonly type: "opened";
      readonly availableProjectKeys: ReadonlyArray<string>;
    }
  | {
      readonly type: "projects-changed";
      readonly availableProjectKeys: ReadonlyArray<string>;
    }
  | {
      readonly type: "title-changed";
      readonly title: string;
    }
  | {
      readonly type: "project-toggled";
      readonly projectKey: string;
      readonly selected: boolean;
    }
  | {
      readonly type: "environment-changed";
      readonly availableProjectKeys: ReadonlyArray<string>;
    }
  | {
      readonly type: "closed";
    };

export interface TaskCreateDialogLifecycleTransition {
  readonly nextWasOpen: boolean;
  readonly action: TaskCreateDialogFormAction | null;
}

export function resolveTaskCreateDialogLifecycleTransition(input: {
  readonly wasOpen: boolean;
  readonly open: boolean;
  readonly availableProjectKeys: ReadonlyArray<string>;
}): TaskCreateDialogLifecycleTransition {
  if (!input.open) {
    return {
      nextWasOpen: false,
      action: input.wasOpen ? { type: "closed" } : null,
    };
  }
  return {
    nextWasOpen: true,
    action: input.wasOpen
      ? { type: "projects-changed", availableProjectKeys: input.availableProjectKeys }
      : { type: "opened", availableProjectKeys: input.availableProjectKeys },
  };
}

export function createTaskCreateDialogFormState(): TaskCreateDialogFormState {
  return {
    title: "",
    selectedProjectKeys: new Set(),
    projectSelectionTouched: false,
  };
}

export function resolvePreferredTaskCreateEnvironment(input: {
  readonly primaryEnvironmentId: string | null;
  readonly environments: ReadonlyArray<TaskCreateDialogEnvironmentOption>;
}): string | null {
  const primary =
    input.primaryEnvironmentId === null
      ? null
      : input.environments.find(
          (environment) =>
            environment.environmentId === input.primaryEnvironmentId &&
            environment.hasEligibleProjects,
        );
  if (primary) {
    return primary.environmentId;
  }
  return (
    input.environments.find((environment) => environment.hasEligibleProjects)?.environmentId ?? null
  );
}

export function reconcileTaskCreateEnvironmentSelection(input: {
  readonly wasOpen: boolean;
  readonly open: boolean;
  readonly primaryEnvironmentId: string | null;
  readonly environments: ReadonlyArray<TaskCreateDialogEnvironmentOption>;
  readonly selection: TaskCreateDialogEnvironmentSelection;
}): TaskCreateDialogEnvironmentSelection {
  if (!input.open) {
    return { environmentId: null, touched: false };
  }

  const environmentStillAvailable = input.environments.some(
    (environment) => environment.environmentId === input.selection.environmentId,
  );
  if (input.wasOpen && input.selection.touched && environmentStillAvailable) {
    return input.selection;
  }

  const preferredEnvironmentId = resolvePreferredTaskCreateEnvironment(input);
  if (
    input.wasOpen &&
    !input.selection.touched &&
    input.selection.environmentId === preferredEnvironmentId
  ) {
    return input.selection;
  }
  return {
    environmentId: preferredEnvironmentId,
    touched: false,
  };
}

function initializeForOpen(availableProjectKeys: ReadonlyArray<string>): TaskCreateDialogFormState {
  return {
    title: "",
    selectedProjectKeys: new Set(availableProjectKeys.slice(0, 1)),
    projectSelectionTouched: false,
  };
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function reconcileAvailableProjects(
  state: TaskCreateDialogFormState,
  availableProjectKeys: ReadonlyArray<string>,
): TaskCreateDialogFormState {
  const available = new Set(availableProjectKeys);
  const selectedProjectKeys = new Set(
    [...state.selectedProjectKeys].filter((projectKey) => available.has(projectKey)),
  );

  // Projects can arrive after the dialog opens. Supply the normal first-project
  // default until the user makes an explicit repository choice, but never
  // replace an intentional empty or otherwise edited selection.
  if (!state.projectSelectionTouched && selectedProjectKeys.size === 0 && availableProjectKeys[0]) {
    selectedProjectKeys.add(availableProjectKeys[0]);
  }

  return setsEqual(selectedProjectKeys, state.selectedProjectKeys)
    ? state
    : { ...state, selectedProjectKeys };
}

export function taskCreateDialogFormReducer(
  state: TaskCreateDialogFormState,
  action: TaskCreateDialogFormAction,
): TaskCreateDialogFormState {
  switch (action.type) {
    case "opened":
      return initializeForOpen(action.availableProjectKeys);
    case "projects-changed":
      return reconcileAvailableProjects(state, action.availableProjectKeys);
    case "title-changed":
      return state.title === action.title ? state : { ...state, title: action.title };
    case "project-toggled": {
      const selectedProjectKeys = new Set(state.selectedProjectKeys);
      if (action.selected) {
        selectedProjectKeys.add(action.projectKey);
      } else {
        selectedProjectKeys.delete(action.projectKey);
      }
      return {
        ...state,
        selectedProjectKeys,
        projectSelectionTouched: true,
      };
    }
    case "environment-changed":
      return {
        ...state,
        selectedProjectKeys: new Set(action.availableProjectKeys.slice(0, 1)),
        projectSelectionTouched: false,
      };
    case "closed":
      return createTaskCreateDialogFormState();
  }
}
