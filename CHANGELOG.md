# Changelog

## [0.0.1] - 2026-11-13

The first release brings a terminal, file tree, editor, command history and settings together in one desktop app.

- Windows: per-user installers for x64 and ARM64; PowerShell and Command Prompt run with the signed-in user's permissions.
- macOS: DMG installers for Intel and Apple Silicon.
- Linux: AppImage, deb and rpm packages for x64 and ARM64.
- Windows x64 bundles MSYS2 with zsh, git and the prompt tools; other builds use shells provided by their operating system.
- Automatic update checks and SHA-256 verification; updates install on close for Windows NSIS and Linux AppImage builds. "Install now" reopens byndery after the Windows installer finishes.
- Windows 11 22H2 and later: byndery can be the default terminal, so PowerShell, Command Prompt and other console programs started from Start, Explorer or Run open as byndery tabs. The installer's finish page offers it, Settings → General switches it, and uninstalling restores the previous choice.
