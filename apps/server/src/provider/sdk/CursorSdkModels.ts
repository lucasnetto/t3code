import type {
  ModelSelection,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import type { CursorSdkModel, CursorSdkModelSelection } from "../Services/CursorSdkClient.ts";

export function mapCursorSdkModel(model: CursorSdkModel): ServerProviderModel | undefined {
  const slug = model.id.trim();
  const name = model.displayName.trim();
  if (!slug || !name) return undefined;

  const defaultVariant = model.variants?.find((variant) => variant.isDefault);
  const defaultParams = new Map(
    (defaultVariant?.params ?? []).map((parameter) => [parameter.id, parameter.value]),
  );
  const descriptors = (model.parameters ?? []).flatMap((parameter) => {
    const id = parameter.id.trim();
    const options = parameter.values.flatMap((entry) => {
      const value = entry.value.trim();
      if (!value) return [];
      return [
        {
          value,
          label: entry.displayName?.trim() || value,
          ...(defaultParams.get(id) === value ? { isDefault: true } : {}),
        },
      ];
    });
    if (!id || options.length === 0) return [];
    return [
      buildSelectOptionDescriptor({
        id,
        label: parameter.displayName?.trim() || id,
        options,
      }),
    ];
  });

  return {
    slug,
    name,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: descriptors }),
  };
}

export function mapCursorSdkModels(
  models: ReadonlyArray<CursorSdkModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const mapped = mapCursorSdkModel(model);
    if (!mapped || seen.has(mapped.slug)) return [];
    seen.add(mapped.slug);
    return [mapped];
  });
}

export function toCursorSdkModelSelection(input: {
  readonly model: string | null | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): CursorSdkModelSelection {
  const id = input.model?.trim() || "auto";
  const params = (input.options ?? []).flatMap((option) => {
    if (typeof option.value !== "string") return [];
    const parameterId = option.id.trim();
    const value = option.value.trim();
    return parameterId && value ? [{ id: parameterId, value }] : [];
  });
  return params.length > 0 ? { id, params } : { id };
}

export function resolveCursorSdkModelSelection(
  selection: ModelSelection | null | undefined,
): CursorSdkModelSelection {
  return toCursorSdkModelSelection({
    model: selection?.model,
    options: selection?.options,
  });
}
