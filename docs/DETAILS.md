Full behaviour, recovery, validation and development details for ben-claude-multi.

# ben-claude-multi

Manage additional Claude Desktop and Claude Code profiles for one macOS user. Each
profile selects its own configuration and application data locations. Profiles can
share a working repository. They are not separate macOS users or sandboxed processes.

This is an independent, unofficial project. It is not affiliated with, endorsed by
or supported by Anthropic. "Claude", "Claude Code" and "Claude Desktop" are
trademarks of Anthropic, used only to describe compatibility. The tool does not ship
or redistribute any Anthropic software; it verifies and copies your own installed
Claude.app locally. Use at your own risk, under the MIT License.

## Status

Version 1.0.0. Code (terminal) profiles have been validated end to end on a real Mac:
add, launch route, environment selection, rename, remove, live-session refusal and
retired-path reuse.

Desktop and paired profiles have been validated natively only at the component
level: signature verification, private copy, tint and launcher compilation. Their
full interactive flows—Dock launch, side-by-side accounts, wrong-location
confirmation, update policy, setup transfer and repair—are covered by deterministic
tests but have **not yet been exercised end to end on real hardware**. Treat Desktop
and paired profiles as experimental, and keep backups of important Claude Desktop data.

Three attended checks remain outstanding: effective Read/Grep/Glob enforcement,
live-session reload and Dock behaviour.

Requires macOS, Node.js 20 or newer, and the Claude surface you want to use. Desktop
operations require the system signing, AppleScript and application tooling. There
are no runtime npm dependencies or network requests made by this CLI. Claude, gh,
hooks, plugins and connectors can make their own network requests when you run them.

## Installation

Use a reviewed checkout and its lockfiles. For development, run `npm ci`, then
`npm run build`. The executable is `dist/src/main.js`; for example:

```sh
node dist/src/main.js help
```

The build verifies the development lock graph and records the lock digest and
compiled module digests in `dist/build.json`. The published archive contains only
compiled runtime modules, that build record, the package manifest, the reviewed
`npm-shrinkwrap.json`, and the four documentation/license files. Test code and
build scripts are excluded. The shrinkwrap contains development-only dependencies;
production installation needs no dependency resolution.

Before installing, run `npm test` and inspect `npm pack --dry-run`. A disposable
production-install check can be run entirely offline after building:

```sh
trial=$(mktemp -d "${TMPDIR:-/tmp}/bcm-install.XXXXXX")
npm pack --offline --ignore-scripts --pack-destination "$trial"
npm install -g --offline --omit=dev --ignore-scripts --no-audit --no-fund \
  --prefix "$trial/prefix" "$trial/ben-claude-multi-1.0.0.tgz"
"$trial/prefix/bin/ben-claude-multi" version
"$trial/prefix/bin/ben-claude-multi" help
```

After reviewing the result, remove this disposable directory. `npm run install-local`
builds, packs to a fresh temporary directory, installs that exact file into your
configured global npm prefix offline with development dependencies omitted, and
removes the archive. A packing failure stops installation. Check your npm prefix
before running it. There is no registry updater or background service.

## Locations and commands

`C` is `$XDG_CONFIG_HOME/ben-claude-multi`, normally
`~/.config/ben-claude-multi`. `D` is `$XDG_DATA_HOME/ben-claude-multi`, normally
`~/.local/share/ben-claude-multi`. XDG parents must be absolute and safe.

| Resource | Default |
| --- | --- |
| Code configuration | `D/<label>/code` |
| Desktop data | `D/<label>/desktop` |
| Desktop policy and third-party state | Desktop data path with `-3p` appended |
| Private Claude copy | `C/bundles.noindex/<profile UUID>/Claude.app` |
| Generated launcher | `~/Applications/Claude Profiles/Claude <label>.app` |
| Terminal command | `claude-<label>` in the recorded shell rc file |
| Optional gh configuration | `github` child of the Code directory |
| Incomplete operation records | `C/recovery/<operation UUID>` |

Run `help` for arguments and `version` for the installed release. With no arguments,
a terminal shows a numbered menu; a noninteractive invocation prints usage.

| Command | Purpose |
| --- | --- |
| `add [label] --target terminal\|desktop\|paired` | Plan and create missing surfaces |
| `list` / `status [label]` | Read-only registration and resource checks |
| `run-profile <label> -- <arguments>` | Run shared Claude Code with this selection |
| `open-profile [label]` | Verify and open or focus the dedicated Desktop copy |
| `rename [old] [new]` / `remove [label]` | Change a registration with confirmation |
| `repair [label] [--refresh-dock]` | Repair the generated Desktop launcher |
| `desktop-updates [label] [launcher\|application]` | Inspect or select update policy |
| `copy-setup [source] [target] [--replace-selected]` | Copy explicitly selected setup |
| `doctor [--apply]` | Inventory health or apply safe generated-resource repairs |
| `doctor --recover <operation UUID>` | Review and confirm unfinished recovery |

Before rename/remove, quit manually wrapped sessions whose environments `ps -E` hides; see [limits](../SECURITY.md).

## A first profile

Run `ben-claude-multi add studio --target paired`. Choose the source Claude.app,
data locations, launcher, optional tint, shell and terminal command. Decline setup
import for a clean start. GitHub configuration is optional. The final plan lists
completed, requested and skipped surfaces, all destinations and shell changes.
Approval defaults to No. EOF also refuses. Cancelling before mutation leaves the
profile and shell unchanged.

Approve the plan, then reload the recorded rc file or open a new terminal. Run
`claude-studio` and sign in inside that Code profile. Open Desktop using the reported
launcher or `ben-claude-multi open-profile studio`, and sign in to the intended
account there. Creation itself does not launch Claude or authenticate for you.

If Desktop is unavailable, skip it and keep Code. If one surface fails, its work
rolls back before only the completed surface is registered. The result identifies
what completed and how to resume. Repeat `add studio --target paired` to link the
missing surface without replacing chats or the UUID. Existing sessions must reopen
to receive new Code/GitHub selections. Repeating completed work is a no-op.

The unmanaged baseline remains a read-only source. Code setup import is opt-in and
uses a positive allowlist: selected settings, instructions, hook/agent/command and
skill directories, plugin definitions and MCP setup. It excludes conversations,
sessions, account identity and authentication state, and strips specified credential
helpers and secret-looking settings environment keys. Hooks, plugins and MCP setup
can still execute code or contain third-party credentials. Inspect them before
selecting import. Selected extension content and settings transfer together;
connectors merge additively without replacing existing names. Doctor never imports
either automatically.

## Credentials and shared access

Code's selected directory can influence macOS authentication storage. Moving it can
require signing in again; reusing an old path can recover an earlier sign-in even
if the folder was deleted. Retired identity-bearing paths require separate,
exact-location approval. The tool does not read, move, reconstruct or delete
Keychain entries. Use Claude's `/login` and `/logout` yourself inside the intended
profile. Removal keeps Code and Desktop data by default and reports retained paths.

The default subscription credential policy removes `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_CUSTOM_HEADERS` from child
environments. Only explicit inheritance keeps those overrides. Configuration
selectors are always cleared and rebuilt from registered selections. Settings
helpers can still affect authentication; doctor reports their names without
executing them or printing secrets.

For optional private GitHub CLI configuration, use the exact quoted directory
reported by setup, for example:

```sh
GH_CONFIG_DIR="$HOME/.local/share/ben-claude-multi/studio/code/github" \
  gh auth login --insecure-storage
GH_CONFIG_DIR="$HOME/.local/share/ben-claude-multi/studio/code/github" gh auth logout
```

`--insecure-storage` is necessary here to select file-backed tokens. They are
plaintext in that private directory's `hosts.yml`. A different directory alone
cannot establish separation: an account entry with no file-backed token may still
use host-keyed Keychain storage. Unsupported hosts syntax is reported as unknown.
The tool never asks gh to print a token and removes `GH_TOKEN`, `GITHUB_TOKEN`,
`GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` for this selection.

Git credential helpers, Git transport configuration, SSH keys, SSH agents, global
commit identity and repository configuration remain shared. `GH_CONFIG_DIR` does
not isolate them. Doctor reads checked global Git configuration without following
includes or invoking helpers or SSH; unreadable and indirect configuration remains
uncertain. Review Git and SSH setup independently. No diagnostic prints their
secret values or changes your global Git/SSH configuration.

## Desktop launch and updates

Pin the generated launcher in the Dock. Do not pin the running dedicated Claude
tile. Direct-copy launches, Spotlight, Login Items and document/URL handlers can
bypass profile selection. Browser `claude://` callbacks can reach another instance
because copies retain Claude's signed identity. Prefer entering an email code in
the intended window; close other instances before browser-completed authentication.

Copies require deep strict verification of the pinned Anthropic identity before
installation. Optional tint changes Finder icon metadata, not signed resources.
Deep verification runs again after tint and immediately before every launch.
A receipt is never sufficient proof of application authenticity.

Compiled AppleScript launchers synchronously wait for the shared UUID-based Node
engine. Shell entries also use UUID routes. Both capture absolute CLI and stable
Node paths, clear Node injection variables, and avoid shell startup files. Doctor
reports moved runtime paths and can repair safe generated entries after reinstall.

A verified correct running instance is focused. Another or missing data selection
requires a default-No native dialog. After approval the engine rechecks PID, start
identity, owner, executable, bundle and data selection before graceful termination.
Ambiguity stops the request; there is no force escalation. Doctor never quits apps.

The default `launcher` update mode establishes `configLibrary` with
`disableAutoUpdates: true` only when its derived root is absent. Idle launches can
refresh from a verified newer source; unknown version ordering never triggers a
speculative replacement, and a valid newer copy is never downgraded. The
`application` mode allows Claude's own updater, with possible tint loss and relaunch
without the intended data selection. Existing processes need reopening for policy
changes. Foreign or changed policy libraries are preserved and reported, so the
requested preference alone does not prove blocking is effective.

`repair studio` regenerates an owned launcher in place when safe. An unknown bundle
stays untouched while a new launcher is installed at an unused location. Dock
restart needs its own approval or `--refresh-dock`; no global LaunchServices reset
or quarantine removal is performed.

## Read rules and shared storage

Generated Code rules protect sibling Code and Desktop roots, `-3p` policy roots,
control state, existing retired data and retained recovery. Directory nodes and
subtrees include applicable `/System/Volumes/Data` spellings. Claims record only
rules the tool inserted; pre-existing identical user rules remain yours.

Read is enforced through Claude Code permission denials. Grep/Glob coverage is
best-effort. This is a configuration-level guard, not an operating-system boundary.
Bash commands, MCP filesystem access, arbitrary owner programs and higher-precedence
managed policy are outside its guarantee. Native effective behavior for particular
Claude versions needs attended validation. Rule strings on disk do not prove a
running session adopted them. Restart live or uncertain sibling sessions after rule
changes; later session writes can overwrite settings, which doctor detects.

Baseline `~/.claude`, `~/.claude.json`, ordinary gh configuration, working repositories
and user files remain outside the sibling guard. Shared Claude state can include
`~/Library/Logs/Claude`, `~/Library/Caches/com.anthropic.claudefordesktop`,
`~/Library/Preferences`, `~/Library/HTTPStorages`, and `claude-cli-nodejs` caches.
Separate selected roots do not separate all logs, caches, callbacks or login state.

## Health and recovery

`doctor` is read-only. It inventories identity and parent safety, executable
selection, shell entries, launch routes, signatures, copies, versions, tint evidence,
process selections, policies, read rules, account equality and recovery. Disk
observations and unknown native behavior are reported separately. Account equality
uses labels only; matching accounts can be intentional.

`doctor --apply` plans safe repairs under the shared registry and UUID locks, then
repeats affected checks. It can rebuild generated resources, repair read rules,
rebase eligible setup references, restore tint or establish absent owned policy.
It cannot adopt unknown data roots, import conversations, transfer connectors,
migrate tokens or sign users out. Busy or unsafe profiles remain visible findings
while independent safe work proceeds. A release maintenance notice persists until
required repairs, cleanup and the post-repair audit succeed. No update query occurs.

Incomplete or conflicted operations retain private records and needed pre-images
under reported recovery locations, covered by sibling read rules. Inspect doctor’s
scope, preserve the locations, and run `doctor --recover <operation UUID>` only for
that unfinished operation. Confirmation defaults to No. Recovery checks current
registration and expected images, and refuses to overwrite concurrent edits or
resurrect removed profiles. Changed or unrecognized material needs manual review;
never blindly remove a recovery, staging or profile directory recursively.
Successful operations and clean rollback discard pre-images: there is no successful
operation backup or undo history. Keep your own independently reviewed backups.

## Validation

`npm test` builds and runs compiled tests with temporary HOME, XDG and temporary
paths, a real-home refusal and a macOS sandbox-exec write/network boundary. A failed
boundary probe fails the run. Only an already sandboxed process with the recognized
nested-seatbelt refusal can use `BCM_TEST_OUTER_SANDBOX=1`; it prints a prominent
missing-inner-boundary warning and explicitly skips inner-boundary assertions.
This is a development-only mode that relies on the outer sandbox. The ordinary
seatbelt policy allows writes only under the temporary root and to literal `/dev/null`;
the repository is read-only during tests.
Production entry points have no test-controlled verifier, process or tool bypass.

`npm run test:native` separately checks source signing, fresh-copy signing, tint
followed by deep verification, and launcher compilation/decompilation in temporary
storage. The four process-census checks run separately without the inner seatbelt:
macOS refuses to execute setuid `ps` inside that boundary. Temporary HOME/XDG/TMPDIR
and the real-home guard still apply. Temporary `claude` and `2.1.999` symlinks to
Node run idle synthetic children to verify name-independent active Code detection. The suite terminates only
that test-owned child. It never opens or quits applications,
signals discovered processes, or reads Keychain. Missing
apps or unavailable capabilities are reported as unavailable, not passed. Attended
Dock waiting/focus/icon behavior, effective Read/Grep/Glob behavior and live-session
permission reload remain separate checks requiring a person and disposable data.

Inspired by jmdarre-v/claude-multiprofile
