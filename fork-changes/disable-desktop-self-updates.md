# Disable Desktop Self-Updates

Added on 2026-07-16.

## Summary

Desktop application updates are disabled by default in this fork so an upstream T3 Code release
cannot replace the fork's application bundle and remove fork-specific functionality such as the
Cursor SDK provider.

Provider maintenance and provider update checks are unchanged. Desktop self-updates can only be
enabled deliberately by launching the app with `T3CODE_ENABLE_AUTO_UPDATE=true`; the existing
`T3CODE_DISABLE_AUTO_UPDATE` setting continues to disable updates after that opt-in.

## Validation

- Desktop updater regression coverage verifies that the updater remains unconfigured, does not
  register listeners, and rejects manual checks without the explicit opt-in.
