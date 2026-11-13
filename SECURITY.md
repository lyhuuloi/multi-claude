# Security policy and scope

multi-claude selects separate Claude configuration and data locations for one
macOS user. It reduces accidental profile and credential misrouting. It does not
establish an operating-system boundary between that user's programs. Root, a
compromised operating system and arbitrary code already executing as the owner are
outside the threat model. Tool-caused unsafe writes, deletion and credential
misrouting remain in scope.

## Filesystem and concurrency

Writable locations are the selected control/data parents, recorded Code roots,
Desktop data and derived `-3p` roots, optional gh children, selected shell rc files,
generated launchers, private dedicated copies, and operation/recovery records.
Read-rule maintenance writes checked profile settings. Baseline `.claude`,
`.claude.json`, Desktop data, source applications and selected import sources are
read-only. Retired locations cannot silently become new authentication identities.
Adoption and exact retired-path reuse require separate default-No consent.

Private directories and files use explicit `0700` and `0600` modes. Checked reads
and atomic replacements reject links, nonregular files, unsafe ownership and link
counts. Open descriptors are checked as well as paths. Parent trust includes
writable grants and ACLs; directly shared writable parents remain unacceptable even
when sticky. Root identity combines canonical location, owner, device, inode and a
private receipt. Alias and path-character checks precede mutations.

One registry lease spans mutation prompts and commits. UUID leases serialize CLI
and Dock copy maintenance, tint, repair and lifecycle work, acquired in sorted
order. Complete owner records are published atomically. Reclaim requires boot and
process-start evidence; PID, elapsed time or unreadable identity alone cannot
justify it. Release compares the current inode and owner token.

Transactions durably record intent, capture pre-images lazily and compare current
objects with expected images. Rollback owns only unchanged results produced by the
operation. Concurrent edits and changed installed trees survive. Recursive cleanup
requires identity and sealed-tree evidence, without following links. Successful
operations and clean rollback discard temporary pre-images; there is no persistent
successful-operation backup history. Retained recovery is private, inventoried and
read-protected. Confirmed recovery checks current registration scope and cannot
revive a removed profile or silently lower current protection.

These checks target cooperative owner processes and accidental substitution. Node
does not provide a complete openat-style filesystem transaction API; repeated
checks and locks are not a defense against malicious arbitrary same-user code.

## Applications and credentials

Source and fresh-copy applications require deep strict verification of the pinned
Anthropic signing identity, including nested code. Finder tint metadata is followed
by deep verification without strict resource checking, repeated immediately before
launch. Signed executable/plist/resources are unchanged. Claude is never re-signed,
and quarantine metadata is never removed as a trust bypass. Failed verification
cannot fall back to opening the baseline application.

The optional `/Applications` shortcut is a convenience link and not a trusted
location. `/Applications` is writable by every administrator of the Mac, so another
administrator can replace the link with a different application of the same name.
The tool therefore never treats it as a managed root, never launches through it,
and re-checks ownership and target before changing it. Leave the shortcut off on a
shared Mac and start profiles from `~/Applications/Claude Profiles`.

A hostile same-user process can swap the bundle after final verification but before
LaunchServices resolves its pathname. Final verification remains immediately before
open; identity and pathname checks narrow this window but cannot close it.

Generated AppleScript launchers wait synchronously for the same verifying Node
engine used by the public CLI. Absolute runtime paths and UUID routing avoid shell
startup state. Node injection variables are cleared. Process classification uses
exact executable/data selections; a wrong-location quit requires default-No consent
and a fresh full identity check after the dialog. Only graceful termination is
allowed. Running or uncertain copies cannot be replaced or tinted by doctor.

Subscription launches remove the documented authentication overrides entirely.
Explicit inheritance is recorded; selectors are rebuilt for every launch. Private
gh selection also removes the four token overrides. Scoped login guidance requires
`--insecure-storage`: tokens are plaintext in private `hosts.yml`. Host/account
configuration without a file-backed token can still use shared Keychain storage.
The tool does not retrieve Keychain tokens, authenticate, issue logout commands,
execute credential helpers or query networks. Diagnostics show names and remedies,
never credential values or raw process environments.

Git helpers and transport credentials, SSH keys and agents, global commit identity,
repository settings and user files remain shared. Selecting gh configuration is
insufficient to isolate them. Doctor reads checked Git files with includes disabled;
it never invokes configured helpers, SSH or authentication commands.

## Permission and evidence limits

Session detection reads environments through `ps -E`. Sessions started through
`claude-<label>` (identified by their run-profile arguments) or the Dock launcher,
and Claude Code processes whose environments macOS exposes, are detected. A session
started by hand through an unrecognized wrapper whose environment macOS hides
cannot be attributed. Quit such sessions before rename or remove.

The sibling read guard covers Code/Desktop roots, derived policy roots, existing
retired folders, control state and recovery, with node/subtree and alternate macOS
spellings. It owns only inserted rules. Unsafe settings and skipped writes remain
findings. Read is enforced through Claude Code permission denials; Grep/Glob coverage
is best-effort. Managed policy can take precedence. Bash, MCP access, arbitrary
programs, baseline data, ordinary gh state and shared Claude caches/logs/preferences
are outside the guard.

Live or uncertain sessions need restarting after rule changes, and can later write
older settings back. Doctor checks disk state after repair and on later runs; it
never treats a file or receipt as proof of effective isolation, a valid login or
current-session enforcement. Native and attended evidence is reported separately
from deterministic tests. Shared URL handlers and direct-copy launches can bypass
Desktop selection. Foreign policy libraries are never silently changed.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open this repository's Security tab and
choose "Report a vulnerability" before disclosing sensitive details. Send the release
version and a minimal synthetic reproduction.
Do not send tokens, private account identifiers, raw environments, full settings or
recovery pre-images. The maintainer has not committed to a response or disclosure
timetable; agree on handling directly before sharing confidential material.
