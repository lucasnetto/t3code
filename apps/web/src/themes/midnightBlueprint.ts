import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";
import midnightBlueprintSource from "./midnight-blueprint-color-theme.json";

export const MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME = "midnight-blueprint" as const;

const midnightBlueprintTheme = {
  ...midnightBlueprintSource,
  name: MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME,
  type: "dark",
} as ThemeRegistration;

registerCustomTheme(MIDNIGHT_BLUEPRINT_DIFF_THEME_NAME, async () => midnightBlueprintTheme);
