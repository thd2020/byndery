# Installers and updates

2026-11-13: byndery 0.0.1 builds installers for six desktop platform and architecture pairs. Windows and Linux AppImage builds install verified updates when the app closes; other package types use the release page. On Windows 11 22H2 and later byndery can be the default terminal.

## Installers

| Platform | Architecture | Package |
|---|---|---|
| Windows | x64, ARM64 | Per-user NSIS Setup.exe |
| macOS | Intel, Apple Silicon | DMG |
| Linux | x64, ARM64 | AppImage, deb and rpm |

The installers include Electron, the byndery app, its native terminal dependency, fonts, shell integration files and third-party notices. Windows x64 also includes MSYS2 with zsh and git. Windows ARM64 uses PowerShell and Command Prompt, plus Git Bash when installed. macOS and Linux use shells provided by the operating system.

The Windows installer installs under the current user's profile and does not ask for administrator access. Byndery runs as `asInvoker`; PowerShell and Command Prompt inherit the same account permissions as byndery.

## Default terminal on Windows

On Windows 11 22H2 and later, byndery can take the place of the PowerShell and Command Prompt windows Windows opens for console programs started from Start, Explorer, Run or a shortcut. The installer's finish page has a box for it, checked by default; Settings → General → Default terminal turns it on or off at any time.

Windows decides where a new console goes from two values in `HKCU\Console\%%Startup`. `DelegationConsole` names the console server, and byndery uses the OpenConsole that comes with Windows Terminal (keeping Preview or Canary if one of those was chosen). `DelegationTerminal` names the terminal, a COM class that byndery registers for the current user in `HKCU\Software\Classes\CLSID\{F4426754-7044-4E2A-A169-EA8A4D3E9DE5}`. Its server is `resources\handoff\byndery-handoff.exe` (`src/handoff`): OpenConsole calls its `ITerminalHandoff3::EstablishPtyHandoff`, or `ITerminalHandoff2` with an older Windows Terminal, with the console's pipes. The helper passes the console to byndery over the named pipe `\\.\pipe\byndery-handoff-<user name>`, starting byndery with `--handoff` when it is not running, and byndery opens it as a tab. The helper only talks to a pipe owned by the same Windows account.

Turning it on saves the previous pair in `HKCU\Software\byndery\DefaultTerminal`; turning it off, or uninstalling, puts that pair back unless another terminal has taken over since. Updates keep the choice. The COM proxy for these calls is installed with Windows Terminal, which Windows 11 includes; Settings says so if it is missing. The Terminal choice in Windows' own Settings (For developers) only lists packaged apps, so byndery is switched from its own installer and Settings instead.

A console that closes with exit code 0 closes its tab, and a window byndery opened for a console closes with its last tab, as a console window does. A console started hidden runs without a tab.

The Windows and macOS packages are unsigned. Windows may show SmartScreen, and macOS may show Gatekeeper. macOS automatic installation needs an Apple-signed app, so byndery checks for a newer version and opens its release page instead.

## Automatic updates

Byndery checks for updates 30 seconds after launch and every six hours after that. Automatic downloads are on by default for supported installer types. Settings → Updates can turn them off or check manually.

Windows NSIS and Linux AppImage updates download in the background, verify the SHA-256 published by GitHub or the release's `.sha256` file, then install when byndery closes. The app and updater keep the current user's permissions. Linux deb and rpm packages need the system package manager to install, so byndery opens the release page instead. macOS DMGs also use the release page because the app is unsigned.

Each installer and package release includes a SHA-256 sidecar and a GitHub build attestation. The updater refuses downloads without a matching checksum.

## Releasing

Keep `package.json` `version`, the `CHANGELOG.md` heading and the tag in sync. A version change pushed to `main` starts `tag-release.yml`, which creates `v<version>` and starts `release.yml` for that tag. A pushed `v*` tag starts the same six native builds directly.

The six builds live in `package.yml`, which runs on native Windows x64 and ARM64, macOS Intel and Apple Silicon, and Linux x64 and ARM64 runners. `ci.yml` runs it on every pull request and keeps the installers as workflow artifacts for a week, so a release is never the first time they build. If a build fails on a pull request, the end of its log is posted to the pull request. In `release.yml` each job uploads its installers and SHA-256 sidecars to a draft GitHub Release and attests them; the release is published only after all six succeed.

To rebuild an existing release from `main` and replace its files, as phevere does, commit a change to `.github/release-request.json` with the tag (`{"tag": "v0.0.1", "reason": "..."}`); `tag-release.yml` starts `release.yml` for it, and a release that is still a draft is published when the builds succeed. Actions → release with the tag under `attach_tag` does the same by hand.

## Local build

On a machine for one supported platform, install Node.js 24 or later and run:

```bash
npm ci
```

Then run one command on the matching platform. It prepares the bundled assets, builds the app and packages that platform's configured targets.

```bash
npm run package:win    # Windows
npm run package:mac    # macOS
npm run package:linux  # Linux
```

On Windows, `npm run package:assets` also builds `byndery-handoff.exe` (`scripts/build-handoff.mjs`), which needs Visual Studio or its Build Tools with the C++ workload.
