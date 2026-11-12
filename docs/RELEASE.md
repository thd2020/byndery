# Installers and updates

2026-11-12: byndery 0.0.1 builds installers for six desktop platform and architecture pairs. Windows and Linux AppImage builds install verified updates when the app closes; other package types use the release page.

## Installers

| Platform | Architecture | Package |
|---|---|---|
| Windows | x64, ARM64 | Per-user NSIS Setup.exe |
| macOS | Intel, Apple Silicon | DMG |
| Linux | x64, ARM64 | AppImage, deb and rpm |

The installers include Electron, the byndery app, its native terminal dependency, fonts, shell integration files and third-party notices. Windows x64 also includes MSYS2 with zsh and git. Windows ARM64 uses PowerShell and Command Prompt, plus Git Bash when installed. macOS and Linux use shells provided by the operating system.

The Windows installer installs under the current user's profile and does not ask for administrator access. Byndery runs as `asInvoker`; PowerShell and Command Prompt inherit the same account permissions as byndery. Windows has a console handoff for registered terminals, but this release does not implement its COM handoff. Open byndery directly to use its PowerShell or Command Prompt profiles; console programs launched elsewhere still use the host selected in Windows.

The Windows and macOS packages are unsigned. Windows may show SmartScreen, and macOS may show Gatekeeper. macOS automatic installation needs an Apple-signed app, so byndery checks for a newer version and opens its release page instead.

## Automatic updates

Byndery checks for updates 30 seconds after launch and every six hours after that. Automatic downloads are on by default for supported installer types. Settings → Updates can turn them off or check manually.

Windows NSIS and Linux AppImage updates download in the background, verify the SHA-256 published by GitHub or the release's `.sha256` file, then install when byndery closes. The app and updater keep the current user's permissions. Linux deb and rpm packages need the system package manager to install, so byndery opens the release page instead. macOS DMGs also use the release page because the app is unsigned.

Each installer and package release includes a SHA-256 sidecar and a GitHub build attestation. The updater refuses downloads without a matching checksum.

## Releasing

Keep `package.json` `version`, the `CHANGELOG.md` heading and the tag in sync. A version change pushed to `main` starts `tag-release.yml`, which creates `v<version>` and starts `release.yml`. A pushed `v*` tag starts the same six native builds directly.

The release workflow builds on native Windows x64 and ARM64, macOS Intel and Apple Silicon, and Linux x64 and ARM64 runners. Each job builds its installer, writes a SHA-256 sidecar and uploads the files to a draft GitHub Release. The workflow publishes the release only after all six jobs succeed.

To rebuild all packages for a tag, run Actions → release and enter the tag under `attach_tag`. Existing assets with matching names are replaced after each build succeeds.

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

The release workflow uses native runners for all six platform and architecture pairs, writes package checksums and attestations, and publishes only after every build succeeds.
