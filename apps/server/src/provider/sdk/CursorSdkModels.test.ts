import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
import type { CursorSdkModel } from "../Services/CursorSdkClient.ts";
import {
  mapCursorSdkModel,
  mapCursorSdkModels,
  resolveCursorSdkModelSelection,
  toCursorSdkModelSelection,
} from "./CursorSdkModels.ts";

const model: CursorSdkModel = {
  id: "composer-2",
  displayName: "Composer 2",
  parameters: [
    {
      id: "thinking",
      displayName: "Thinking",
      values: [
        { value: "low", displayName: "Low" },
        { value: "high", displayName: "High" },
      ],
    },
  ],
  variants: [
    {
      displayName: "Default",
      isDefault: true,
      params: [{ id: "thinking", value: "high" }],
    },
  ],
};

describe("CursorSdkModels", () => {
  it("maps SDK parameters and their default variant into model capabilities", () => {
    const mapped = mapCursorSdkModel(model);

    expect(mapped).toMatchObject({ slug: "composer-2", name: "Composer 2", isCustom: false });
    expect(mapped?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        currentValue: "high",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ]);
  });

  it("drops invalid and duplicate catalog entries", () => {
    expect(
      mapCursorSdkModels([
        model,
        { ...model, displayName: "Duplicate" },
        { id: " ", displayName: "Invalid" },
      ]),
    ).toHaveLength(1);
  });

  it("converts T3 model selections to Cursor SDK selections", () => {
    expect(
      resolveCursorSdkModelSelection({
        instanceId: ProviderInstanceId.make("cursorSdk"),
        model: "composer-2",
        options: [
          { id: "thinking", value: "high" },
          { id: "ignored", value: true },
        ],
      }),
    ).toEqual({ id: "composer-2", params: [{ id: "thinking", value: "high" }] });
    expect(toCursorSdkModelSelection({ model: " " })).toEqual({ id: "auto" });
  });
});
