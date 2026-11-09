# byndery

<img src="README.assets/byndery-icon.png" width="96" alt="The byndery icon: a forward-leaning lowercase b with a plum stem and a hollow mint bowl that stops short of the stem, the Holarky family letter">

byndery is a workspace to use alongside terminal coding agents such as Claude Code and Codex. It puts a real terminal, a file tree and an editor in one window, and links them: a path in terminal output opens in the editor, the tree and the shell can share one folder, a file an agent rewrites reloads in the editor with the change highlighted, and a selection in the editor goes to the agent as context. The editor handles whatever the agent touches, code, configuration or notes alike.

The name comes from a bindery, the workshop where loose sheets are sewn into one book.

![Screenshot of byndery with the file tree and its path bar, a zsh terminal with the rainbow Powerlevel10k prompt, and a TypeScript file in the editor](docs/design.assets/overview-light.png)

## Recent changes

- **2026-11-09.** Settings is now a full window, organised the way Windows Terminal and Konsole organise theirs: profiles for every shell byndery finds, each inheriting from Profile defaults, a reset arrow on every changed value, editable key bindings, and `settings.json` that can be edited by hand. The Commands page sets the order in which zsh, PowerShell and cmd are asked, the prefixes, and names that always go to one system, and shows where a typed line would run.
- **2026-11-09.** The prompt is Powerlevel10k's full rainbow style, drawn with MesloLGS NF, which `npm install` now fetches.
- **2026-11-09.** The file tree can show any folder, through a path bar above it, and its sync button ties it to the terminal both ways.
- **2026-11-09.** New keys: Ctrl+T and Ctrl+W open and close terminals, or files in the editor; Ctrl+K searches the command memory, and Ctrl+R is the shell's own search again; F1 opens the command list. Ctrl+Up and Ctrl+Down now outline the command they select. A terminal selection no longer disappears when another program copies it.
- **2026-11-09.** Command memory: byndery keeps every command with its output, folder, exit code and time, and Ctrl+K searches all of it. Secrets are redacted before anything is stored, and Settings can switch it off or clear it.
- **2026-11-09.** First working build: terminal, file tree and editor in one window. On Windows the terminal is zsh with Powerlevel10k, suggestions and syntax highlighting on a bundled MSYS2, and the same prompt also runs PowerShell cmdlets, cmd built-ins and paths written as `C:\` or `/c/`. The design and the reasons for it are in [`docs/design.md`](docs/design.md).

## Running it

byndery runs from source for now; there is no installer yet. You need Node.js 22 or later and, on Windows, Git for Windows (its `tar` unpacks the bundled shell).

```bash
npm install
```

```bash
node scripts/vendor-shell.mjs
```

```bash
npm run dev
```

`npm install` also fetches MesloLGS NF, the Nerd Font the prompt is drawn for, into `src/renderer/src/assets/fonts`. The second command builds the shell environment in `vendor/`: MSYS2 with zsh and git, Powerlevel10k, gitstatusd and the usual zsh plugins, about 390 MB. In mainland China add `--mirror tuna` to download from the Tsinghua mirror. Without it, byndery falls back to Git Bash, then PowerShell.

`npm run dev` opens the folder you start it in. Pass another folder as an argument, or use Ctrl+O.

## Keys

| Keys | Does |
|---|---|
| Ctrl+P | Go to a file; `>` for commands, `:` for a line, or paste an absolute path |
| F1 or Ctrl+Shift+P | Commands |
| Ctrl+T | New terminal in the current folder; in the editor, a new file |
| Ctrl+W | Close the terminal or the editor tab that has focus |
| Ctrl+K | Search every earlier command and its output; Enter runs it, Tab puts it on the prompt |
| Ctrl+Up, Ctrl+Down in the terminal | Select the previous or next command with its output |
| Ctrl+click on a path in the terminal | Open it in the editor at that line |
| Ctrl+L in the editor | Send the file and selected lines to the terminal as `@path#L3-9` |
| Ctrl+E in the editor | Switch Markdown between rendered and source |
| Ctrl+` | Move between the terminal and the editor |
| Ctrl+B | Show or hide the file tree |
| Alt+Up, Alt+Left, Alt+Right in the tree | Parent folder, back, forward |
| Ctrl+Shift+L in the tree | Type a folder path, as `C:\x`, `/c/x` or `~/x` |
| Ctrl+S | Save |
| Ctrl+, | Settings |

The tree can show any folder: click a part of the path above it, double-click a folder to go into it, or click the empty part of the path to type one. The sync button beside the path ties the tree and the active terminal together, as Dolphin does with its terminal panel: a folder clicked in the tree becomes the terminal's folder, and a `cd` in the terminal moves the tree. The tree only sends `cd` when the shell is at an idle prompt, and the shell keeps it out of its history.

Ctrl+C copies when terminal text is selected and interrupts otherwise; the selection stays until you type or press Escape. Ctrl+V pastes. Ctrl+R is the shell's own reverse search.

On Windows the prompt also takes PowerShell and cmd commands: `Get-Process | Where-Object CPU -gt 100` runs in PowerShell, `copy`, `del` and `mklink` run in cmd, and `C:\Users\me` works as a path. Start a line with `pwsh:`, `cmd:` or `zsh:` to choose the system yourself. In Settings (Ctrl+,), the Commands page sets which systems take part, their order when a name exists in more than one, the prefixes, and names that always go to one system. Typing `byndery-route <line>` in the terminal shows where a line would run and which rule decided it.

Settings are kept in `settings.json`, which holds only what you changed. Terminal settings live in profiles, one for each shell byndery finds (zsh, Git Bash, PowerShell, Command Prompt) plus any you add, and every profile inherits from Profile defaults. "Open settings.json" in Settings opens the file in the editor, and a saved edit applies at once.

## Tests

```bash
npm test
```

```bash
npm run build && npm run e2e
```

`npm run e2e` starts the real app on a scratch repository and drives it: shell integration, links, the tree, the editor, the command router, the command memory and both path forms.

## Licence

The code is released under the [MIT License](LICENSE). The byndery and Holarky names and logos are not covered by it; see [`TRADEMARKS.md`](TRADEMARKS.md). The bundled shell environment and libraries keep their own licences; see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
