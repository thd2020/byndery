# byndery

<img src="README.assets/byndery-icon.png" width="96" alt="The byndery icon: a forward-leaning lowercase b with a plum stem and a hollow mint bowl that stops short of the stem, the Holarky family letter">

byndery is a workspace to use alongside terminal coding agents such as Claude Code and Codex. It puts a real terminal, a file tree, and a viewer and editor for the files an agent writes (Markdown first) in one app. The parts work together the way an IDE does: a path in terminal output opens in the editor, the agent's diffs show up in the file you are reading, and a selection in the editor goes to the agent as context. The goal is the same experience on Windows, macOS, Linux, Android and iOS, from one codebase.

The name comes from a bindery, the workshop where loose sheets are sewn into one book.

## Status

The project is at the design stage and has no code yet. [`docs/landscape.md`](docs/landscape.md) records what already exists (as of 2026-11-02), where the gap is, and the technical constraints the design has to respect.

## Planned shape

This is the starting plan, taken from what the closest existing products do. It will change as the design firms up.

- A host daemon on the computer owns the shells, the agent processes and the file system. iOS cannot start local processes, so every product that reaches phones splits the work this way, and the phone apps are clients of the daemon.
- One web UI for every platform: xterm.js for the terminal, CodeMirror for editing and a Markdown renderer. It is packaged with Electron on the desktop and Capacitor on the phones, the same pattern Phevere uses.
- Coupling to the agents through their own integration points: byndery registers as Claude Code's IDE (the lock file in `~/.claude/ide/` that the VS Code extension and claudecode.nvim use), and talks to Codex through its app-server protocol.
- Sign-in, when it is needed, through the [Holarky account](https://github.com/thd2020/holarky-account).

## Licence

The code is released under the [MIT License](LICENSE). The byndery and Holarky names and logos are not covered by it; see [`TRADEMARKS.md`](TRADEMARKS.md).
