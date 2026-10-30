# ben-claude-multi

Run several Claude Code and Claude Desktop accounts side by side on one Mac, each with its own login and settings.

Independent and unofficial; not affiliated with, endorsed by or supported by Anthropic.
Claude, Claude Code and Claude Desktop are Anthropic trademarks, used to describe compatibility.
No Anthropic software is redistributed; the tool verifies and copies your installed Claude.app locally.

## Status

- Code (terminal) profiles: tested end to end on a real Mac (version 1.0.0).
- Desktop and paired profiles: experimental, not yet tested end to end. Back up important Claude Desktop data.

## Requirements

macOS, Node.js 20+, and Claude Code and/or Claude Desktop.

## Install

```sh
npm install -g ben-claude-multi
```

From source: clone this repository, then run `npm ci`, `npm test` and `npm run install-local`.

## Quick start

1. Run `ben-claude-multi add` and answer the questions. Choose terminal, desktop or paired.
2. Reload your shell or open a new terminal.
3. For Code, run `claude-<label>` and sign in.
4. Optional GitHub login: `GH_CONFIG_DIR="<path printed by the tool>" gh auth login --insecure-storage`.
   This stores the token as plaintext in the private profile folder.
5. For Desktop, open the launcher in `~/Applications/Claude Profiles` and pin that launcher to the Dock.

## Commands

Use `ben-claude-multi` before each command. Run `ben-claude-multi help` for all options.

| Command | What it does |
| --- | --- |
| `add [label] [--target desktop\|terminal\|paired]` | Create or link a profile |
| `list` | Show profiles |
| `status [label]` | Check profile files and shell entries |
| `doctor [--apply \| --recover UUID]` | Check health, repair or review recovery |
| `rename [old] [new]` | Rename a profile |
| `remove [label]` | Remove a profile registration |
| `repair [label] [--refresh-dock]` | Repair a Desktop launcher |
| `copy-setup [source] [target] [--replace-selected]` | Copy selected Desktop setup |
| `desktop-updates [label] [launcher\|application]` | Check or change update policy |
| `open-profile [label]` | Open or focus a Desktop profile |
| `run-profile <label> [-- ...]` | Run Claude Code with this profile |

## What is separated and what is not

- Each profile has its own Claude configuration and login; sign in separately.
- Profiles get Read deny rules for each other. Read is enforced; Grep/Glob coverage is best-effort.
  Bash and MCP are not covered.
- Git credentials, SSH keys and commit identity stay shared. `doctor` reports them.
- Some Claude caches and logs stay shared.
- Your normal `~/.claude` and `~/.claude.json` are never modified by this tool.
- This is not a sandbox, and profiles are not separate macOS users.

## Rename and remove

- Data is kept unless you confirm deletion. Moving a Code profile can require signing in again.
- Quit a profile's sessions first. Sessions started with `claude-<label>` are detected automatically;
  sessions started by hand through other wrappers may not be.

## More

- [Full details](https://github.com/lyhuuloi/ben-claude-multi/blob/main/docs/DETAILS.md):
  behaviour, recovery, validation and development, including the agent-only test mode.
- [Security](SECURITY.md): security model and private vulnerability reporting.
- [Changelog](CHANGELOG.md): release notes.

## License

MIT © Loi Ly. Use at your own risk.

Inspired by jmdarre-v/claude-multiprofile
