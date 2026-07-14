# Midnight Blueprint Theme

Added Midnight Blueprint as a fourth appearance option alongside System, Light, and Dark.

The web and desktop experience now applies the theme consistently to application chrome,
semantic UI colors, browser startup surfaces, Electron's native dark appearance, terminal ANSI
colors, Markdown code blocks, file previews, and diff rendering. The original VS Code token theme
is registered with Pierre as a custom Shiki theme so syntax colors are preserved in both the main
thread and worker-backed renderers.

The preference is stored under the existing `t3code:theme` key as `midnight-blueprint`. Desktop
IPC continues to receive the supported native value `dark`, while the web layer retains the named
theme for palette selection.

The imported theme is Copyright (c) 2026 Lucas Netto and licensed under the MIT License. Its notice
is recorded in `apps/web/THIRD_PARTY_NOTICES.md`.
