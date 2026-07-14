# macOS Electron Builder Icon Conversion

macOS desktop packaging now passes the selected production or nightly PNG icon directly to
Electron Builder instead of generating an ICNS file with the system `iconutil` command.

This keeps local packaging compatible with macOS versions where `iconutil` rejects otherwise valid
legacy iconsets. Electron Builder owns the platform conversion, while the existing release-channel
icon selection remains unchanged.
