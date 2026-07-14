import type { DesktopTheme } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MIDNIGHT_BLUEPRINT_THEME = "midnight-blueprint" as const;

export const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: MIDNIGHT_BLUEPRINT_THEME, label: "Midnight Blueprint" },
] as const;

export const ThemePreferenceSchema = Schema.Literals([
  "system",
  "light",
  "dark",
  MIDNIGHT_BLUEPRINT_THEME,
]);

export type ThemePreference = typeof ThemePreferenceSchema.Type;
export type ResolvedTheme = "light" | "dark";

export const isThemePreference = Schema.is(ThemePreferenceSchema);

export function resolveThemeAppearance(theme: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme === "light" ? "light" : "dark";
}

export function resolveDesktopTheme(theme: ThemePreference): DesktopTheme {
  return theme === MIDNIGHT_BLUEPRINT_THEME ? "dark" : theme;
}
