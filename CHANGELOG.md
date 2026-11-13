# Changelog

## [0.0.2] - 2026-11-13

byndery is now a Tauri app: a Rust backend and the system's own web view instead of Electron's bundled Chromium.

- Smaller: the Windows x64 installer drops Chromium and carries its Linux tools as one archive. git's 149 duplicate command files and MSYS2's translations, man pages and docs are left out.
- Your Linux tools (MSYS2) now live in your user folder, `%LOCALAPPDATA%\com.holarky.byndery\msys64`. Updates keep them, and any packages you add with pacman.
- A command that no system knows offers to install itself with pacman.
- Settings > Shell: switch each zsh plugin on or off, and set aliases, environment variables and extra PATH folders for zsh and bash.
- Settings > Tools (Windows): see and repair byndery's Linux tools, install or remove packages, and update them all. Explorer gets "Open in byndery"; Claude Code can use byndery's bash; the Linux tools can go on your PATH.
- PowerShell terminals report their commands, exit codes and folder, so command marks, the command memory and folder sync work there too.
- WSL distributions appear as profiles. Paths dropped or pasted into a terminal take that terminal's form: `C:\x`, `/c/x` or `/mnt/c/x`.
- Installing over 0.0.1 removes the Electron build and keeps your settings, command history and default-terminal choice.

## [0.0.1] - 2026-11-13

The first release brings a terminal, file tree, editor, command history and settings together in one desktop app.

- Windows: per-user installers for x64 and ARM64; PowerShell and Command Prompt run with the signed-in user's permissions.
- macOS: DMG installers for Intel and Apple Silicon.
- Linux: AppImage, deb and rpm packages for x64 and ARM64.
- Windows x64 bundles MSYS2 with zsh, git and the prompt tools; other builds use shells provided by their operating system.
- Automatic update checks and SHA-256 verification; updates install on close for Windows NSIS and Linux AppImage builds. "Install now" reopens byndery after the Windows installer finishes.
- Windows 11 22H2 and later: byndery can be the default terminal, so PowerShell, Command Prompt and other console programs started from Start, Explorer or Run open as byndery tabs. The installer's finish page offers it, Settings → General switches it, and uninstalling restores the previous choice.
