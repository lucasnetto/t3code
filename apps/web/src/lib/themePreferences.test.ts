import { describe, expect, it } from "vite-plus/test";
import {
  isThemePreference,
  MIDNIGHT_BLUEPRINT_THEME,
  resolveDesktopTheme,
  resolveThemeAppearance,
} from "./themePreferences";

describe("theme preferences", () => {
  it("recognizes Midnight Blueprint as a supported dark theme", () => {
    expect(isThemePreference(MIDNIGHT_BLUEPRINT_THEME)).toBe(true);
    expect(resolveThemeAppearance(MIDNIGHT_BLUEPRINT_THEME, false)).toBe("dark");
  });

  it("maps custom themes to an Electron-native appearance", () => {
    expect(resolveDesktopTheme(MIDNIGHT_BLUEPRINT_THEME)).toBe("dark");
    expect(resolveDesktopTheme("system")).toBe("system");
  });

  it("resolves the system preference without changing explicit themes", () => {
    expect(resolveThemeAppearance("system", true)).toBe("dark");
    expect(resolveThemeAppearance("system", false)).toBe("light");
    expect(resolveThemeAppearance("dark", false)).toBe("dark");
  });
});
