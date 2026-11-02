# What already exists (2026-11-02)

This memo records a market scan made before byndery had any code. Where a fact could not be confirmed it says so. Re-check the products before relying on any row; most of them ship weekly.

## The agent apps themselves

The idea started from the belief that agent apps had dropped the IDE parts. That is now only half true. The Claude Code desktop app gained an integrated terminal, a file pane (editable in local sessions, view-only for cloud, SSH and WSL sessions), a diff view with line comments and a browser pane in its April 2026 redesign ([docs](https://code.claude.com/docs/en/desktop.md)). It still shows `.md` files as raw text; the request to render them, [anthropics/claude-code#49353](https://github.com/anthropics/claude-code/issues/49353), was closed by a bot for inactivity. The Codex app has a terminal and a file tree, and users report the tree as unreliable ([openai/codex#20552](https://github.com/openai/codex/issues/20552), [forum thread](https://community.openai.com/t/feature-request-bring-back-the-file-explorer-button-in-codex/1380166)).

What is still missing is rendered Markdown, a real editor, terminal output linked to that editor, and all of it on a phone.

## Closest products

"Mobile" means a client that drives a session running on another machine. None of these runs a local shell on iOS.

| Product | Platforms | Terminal | File tree | Markdown | Licence |
|---|---|---|---|---|---|
| Paseo | Windows, macOS, Linux, Android, iOS, web | Yes | Not stated | Not stated | AGPL-3.0 (listings conflict) |
| Nimbalyst | Desktop, iOS companion | Yes | Yes | WYSIWYG, with agent edits as diffs | MIT (one source) |
| Warp | Windows, macOS, Linux | Yes | Yes | Not verified | Client open source since April 2026 |
| Wave Terminal | Windows, macOS, Linux | Yes | Directory blocks | Yes | Apache-2.0 |
| Zed | Windows, macOS, Linux | Yes | Yes | Yes | GPL-3.0 (not checked) |
| cmux | macOS | Yes | No | Through mdmux | AGPL-3.0 |
| Conductor | macOS on Apple silicon | Yes | Yes | Not verified | Proprietary, free |
| Happy Coder | iOS, Android, web | No, chat only | No | Chat only | MIT |
| VibeTunnel | macOS host, browser, iOS | Yes, in the browser | No | No | MIT or AGPL (sources conflict) |

Paseo is the nearest in reach: it already runs everywhere byndery wants to run. Nimbalyst is the nearest in spirit, with agent edits shown inside a Markdown editor. Warp's CEO has said Warp does not want to be an editor.

Not checked in this pass: Cursor 2.x, Kiro, Termius, a-Shell and code-server on phones.

## What people ask for

Running `claude` in Zed's terminal "cannot see your selection, open editors, or diagnostics" and "cannot show accept/reject diffs inside the editor" ([Zed discussion #58338](https://github.com/zed-industries/zed/discussions/58338)). Several small tools exist only to preview Markdown an agent wrote, such as claude-mdview and Markview ([dev.to](https://dev.to/heylittlepan/how-to-preview-markdown-files-from-claude-code-and-codex-2b2h)). On Hacker News, one answer to "why is editor integration needed" was that "the editor treats edits from Claude Code as a first class citizen" ([HN](https://news.ycombinator.com/item?id=45117475)).

## Constraints that shape the design

iOS apps cannot start processes, so a terminal on an iPhone is always a client of a shell somewhere else. Paseo, Happy, VibeTunnel and Anthropic's Remote Control all put a daemon on the computer and connect phones to it over WebSocket. Android could run a local shell later, the way Termux does.

For the UI, xterm.js is the terminal widget almost everyone uses (VS Code, Wave, VibeTunnel). Flutter has a working cross-platform terminal in ServerBox, but its original terminal package is unmaintained and its editor ecosystem is thinner. No shipped mobile terminal was found on Tauri mobile, GPUI, Slint or Compose Multiplatform.

## How a third-party app couples to the agents

Claude Code connects to any editor that runs a WebSocket MCP server on 127.0.0.1 and writes `~/.claude/ide/<port>.lock` with an auth token. The editor then receives tool calls such as `openDiff`, which waits for the user to accept or reject, and sends `selection_changed` notifications. Anthropic has not documented this protocol; [claudecode.nvim](https://github.com/coder/claudecode.nvim) implements it by copying the VS Code extension, and any Claude Code update can break it.

ACP (Agent Client Protocol), started by Zed and joined by JetBrains, reaches Claude Code only through the `claude-agent-acp` adapter built on the Agent SDK.

Codex exposes its app-server, JSON-RPC over stdio, which OpenAI's own VS Code, JetBrains and Xcode integrations use. OpenAI says it was not designed as a stable API ([OpenAI](https://openai.com/index/unlocking-the-codex-harness/)).
