# Third-party software in byndery

byndery's own code is under the [MIT License](LICENSE). The app also ships the programs and libraries below, each under its own licence. The shell environment runs as separate programs that byndery starts; nothing in it is linked into byndery's code.

## Shell tools

Windows x64 builds ship MSYS2 with zsh and git. macOS and Linux builds use the shell supplied by the operating system; Windows ARM64 builds use PowerShell and Command Prompt, plus Git Bash when installed. Powerlevel10k and its prompt tools are bundled with Windows x64, macOS and Linux builds.

| Component | Licence | Source |
|---|---|---|
| MSYS2, about 130 packages including the msys2-runtime, bash, coreutils, zsh, git, OpenSSH and pacman (Windows x64) | Per package; most are GPL-2.0 or GPL-3.0, zsh is under the Zsh licence | Each package and version is listed with its licence in `vendor/msys2-packages.txt` inside the app. Sources: <https://repo.msys2.org/msys/sources/> |
| Powerlevel10k | MIT | <https://github.com/romkatv/powerlevel10k> |
| gitstatusd | GPL-3.0 | <https://github.com/romkatv/gitstatus> |

The licence texts of the MSYS2 packages are in `usr/share/licenses/` inside the Windows x64 bundle. If a source link above stops working, ask [thd2020](https://github.com/thd2020) and you will be sent the corresponding source for the version you received, for three years after that release.

## Libraries and fonts

| Component | Licence |
|---|---|
| Electron and Chromium | MIT, with Chromium's notices in `LICENSES.chromium.html` |
| xterm.js and its addons | MIT |
| node-pty | MIT |
| CodeMirror 6 and Lezer | MIT |
| Source Serif 4 | SIL Open Font License 1.1 |
| MesloLGS NF, Copyright 2009, 2010, 2013 André Berg, with Nerd Fonts glyphs, from <https://github.com/romkatv/powerlevel10k-media> | Apache License 2.0 |
| Cascadia Mono, when installed by Windows | SIL Open Font License 1.1 (not bundled) |

The names MSYS2, zsh, Powerlevel10k and the others belong to their projects. byndery uses them only to say what it includes.
