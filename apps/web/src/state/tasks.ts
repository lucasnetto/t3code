import { createEnvironmentTaskAtoms } from "@t3tools/client-runtime/state/tasks";

import { environmentCatalog } from "../connection/catalog";
import { environmentSnapshotAtom } from "./shell";

export const environmentTasks = createEnvironmentTaskAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
