# multi-claude

Run several Claude accounts side by side on one Mac. Each account gets its own
Claude Code command and, if you want, its own Claude Desktop window, with a
separate login and separate settings. Your normal Claude install is left alone.

```text
claude            -> your normal account (untouched)
claude-work       -> account 2, own login, own settings
Claude work.app   -> account 2 in its own Claude Desktop window
```

Independent and unofficial; not affiliated with, endorsed by or supported by Anthropic.
Claude, Claude Code and Claude Desktop are Anthropic trademarks, used to describe compatibility.
No Anthropic software is redistributed; the tool verifies and copies your installed Claude.app locally.

## Who it is for

- You have a personal and a work Claude subscription and switch between them all day.
- You want two Claude Desktop windows open at once, each signed in to a different account.
- You run agents under one account and want your own work under another.

## Status

| Part | State |
| --- | --- |
| Code (terminal) profiles | Tested end to end on a real Mac |
| Desktop and paired profiles | Experimental. Creation, launch and update blocking are fixed after 1.0.0; long-term use with two signed-in accounts is still being verified. Back up important Claude Desktop data first. |

## Requirements

- macOS
- Node.js 20 or newer
- Claude Code and/or Claude Desktop already installed

## Install

From source (the package is not on npm yet):

```sh
git clone https://github.com/lyhuuloi/multi-claude.git
cd multi-claude
npm ci
npm test
npm run install-local
```

Update later with `git pull`, then `npm ci` and `npm run install-local` again.
After an update that changes launchers, run `multi-claude repair <label>` once per Desktop profile.

## Quick start

Run these from Terminal.app, not from inside a Claude session.

### A second Claude Code account

```sh
multi-claude add work --target terminal
```

Open a new terminal, run `claude-work`, then `/login` with the second account.

### A second Claude Desktop window

There are three kinds of profile. Pick by what you want to end up with:

| You want | Use | You get |
| --- | --- | --- |
| A second account in the terminal only | `--target terminal` | the command `claude-work` |
| A second Claude Desktop window | `--target paired` | the app `Claude work` **and** the command `claude-work` |
| Desktop only | `--target desktop` | the app `Claude work`; its Code tab shares `~/.claude` with your main Claude |

For a Desktop window, use `paired`. Step by step, for a profile called `work`:

**1. Run the command** in Terminal.app:

```sh
multi-claude add work --target paired
```

**2. Answer the questions.** Press Return on every one to accept the default shown in `[brackets]`.
The first group sets up the terminal command, the second group sets up the Desktop app:

```text
Code directory [~/.local/share/multi-claude/work/code]         Return
Shell: zsh, bash or fish [zsh]                                 Return
Shell rc file: [~/.zshrc]                                      Return
Terminal command [claude-work]                                 Return
Credential policy: subscription or inherit [subscription]      Return
Import allowlisted baseline Code setup? [y/N]                  Return (y copies your skills, plugins and hooks)
Enable a private GitHub CLI directory? [y/N]                   Return

Claude source application: [/Applications/Claude.app]          Return
Desktop data directory: [~/.local/share/multi-claude/work/desktop]   Return
Dock launcher: [~/Applications/Claude Profiles/Claude work.app]      Return
Use the Claude icon? y/n [y]                                   Return
Tint: none, amber, copper, mint, sky, violet or rose [none]    Return (a color helps tell the windows apart)
Also add a shortcut in /Applications? y/n [n]                  y if you want it in Applications
Apply this profile plan? [y/N]                                 y
```

The tool then copies Claude.app (about 600 MB, a few seconds) and builds the launcher.

**3. Open the new app.** In Finder press Shift-Command-G and go to `~/Applications/Claude Profiles`
(or look in Applications if you said `y` to the shortcut). Double-click `Claude work`.
A second Claude Desktop window opens next to your main one.

**4. Sign in** with the second account in that window. Typing the email code works best;
a sign-in link from the browser can land in the other Claude window.

**5. Keep it in the Dock.** Drag `Claude work` from Finder to the Dock. Always start the profile
from this launcher. The tile that appears while it runs, Spotlight and "Keep in Dock" on that
running tile all bypass the profile.

To check it worked: `multi-claude status work`.

### Optional: show the launcher in /Applications

During `add`, answer `y` to `Also add a shortcut in /Applications?` (default is no).
For an existing profile:

```sh
multi-claude repair work --shortcut
```

The shortcut is a link to the real launcher. `rename` moves it, `remove` deletes it,
`repair work --no-shortcut` drops it. It is off by default because `/Applications`
can be changed by any administrator of the Mac; see [Security](SECURITY.md).

### Coming from ben-claude-multi

The tool was first called `ben-claude-multi`. An existing registry under
`~/.config/ben-claude-multi` and `~/.local/share/ben-claude-multi` keeps working in place.
After installing this version, run `multi-claude doctor --apply`, then
`multi-claude repair <label>` for each Desktop profile, then `npm rm -g ben-claude-multi`.

## Commands

Use `multi-claude` before each command. Run `multi-claude help` for all options.

| Command | What it does |
| --- | --- |
| `add [label] [--target desktop\|terminal\|paired]` | Create or link a profile |
| `list` | Show profiles |
| `status [label]` | Check profile files and shell entries |
| `doctor [--apply \| --recover UUID]` | Check health, repair or review recovery |
| `rename [old] [new]` | Rename a profile |
| `remove [label]` | Remove a profile registration |
| `repair [label] [--refresh-dock] [--shortcut \| --no-shortcut]` | Rebuild a Desktop launcher; add or drop its `/Applications` shortcut |
| `copy-setup [source] [target] [--replace-selected]` | Copy selected Desktop setup |
| `desktop-updates [label] [launcher\|application]` | Check or change update policy |
| `open-profile [label]` | Open or focus a Desktop profile |
| `run-profile <label> [-- ...]` | Run Claude Code with this profile |

## Where things live

| What | Where |
| --- | --- |
| Profile list | `~/.config/multi-claude/catalog.json` |
| Profile data (Code and Desktop) | `~/.local/share/multi-claude/<label>/` |
| Private copy of Claude.app per Desktop profile | `~/.config/multi-claude/bundles.noindex/` |
| Launchers | `~/Applications/Claude Profiles/Claude <label>.app` |
| Optional shortcut | `/Applications/Claude <label>.app` |
| Shell command | one marked block in your shell rc file |

## What is separated and what is not

Separated:

- Each profile has its own Claude configuration and login; sign in separately.
- A Desktop profile runs from its own copy of Claude.app with its own data folder.
- Profiles get Read deny rules for each other. Read is enforced; Grep/Glob coverage is best-effort.

Still shared:

- Git credentials, SSH keys and commit identity. `doctor` reports them.
- Keychain, some Claude caches, logs and the `claude://` link handler.
- Bash and MCP tools are not covered by the Read rules.

Never touched: your normal `~/.claude`, `~/.claude.json`, `/Applications/Claude.app`
and the main Claude Desktop data.

This is not a sandbox, and profiles are not separate macOS users.

## Updates of Claude Desktop

A Desktop profile does not update itself. Its launcher refreshes the private copy
from your main Claude.app when that one is newer and the profile is closed. So:
update the main Claude as usual, then reopen the profile from its launcher.

## Rename and remove

- Data is kept unless you confirm deletion. Moving a Code profile can require signing in again.
- Quit a profile's sessions first. Sessions started with `claude-<label>` are detected automatically;
  sessions started by hand through other wrappers may not be.

## Troubleshooting

| Symptom | Do this |
| --- | --- |
| "The profile engine is missing" | Update the tool, then `multi-claude repair <label>` |
| The launcher is not in Applications | It is in `~/Applications/Claude Profiles`; add a shortcut with `repair <label> --shortcut` |
| A sign-in link opens the wrong Claude window | Enter the email code by hand in the window you want |
| Anything else | `multi-claude doctor` |

## More

- [Full details](docs/DETAILS.md): behaviour, recovery, validation and development,
  including the agent-only test mode.
- [Security](SECURITY.md): security model and private vulnerability reporting.
- [Changelog](CHANGELOG.md): release notes.

## License

MIT © Loi Ly. Use at your own risk.

Inspired by jmdarre-v/claude-multiprofile
