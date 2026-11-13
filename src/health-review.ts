import { accessSync, constants, lstatSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LifecycleActions } from './lifecycle-actions.js';
import { CatalogSession } from './profile-actions.js';
import { readCatalog, verifyRoot } from './profile-catalog.js';
import type { Catalog, Profile } from './profile-catalog.js';
import { profilePathFinding } from './profile-safety.js';
import { checkedRoot, present } from './managed-resources.js';
import { auditFences } from './read-fences.js';
import { githubStorageFinding, assertGithubDirectory } from './github-configuration.js';
import { overrideNames, authenticationOverrides, githubOverrides } from './execution-policy.js';
import { codeLiveness, desktopState } from './process-census.js';
import type { Census, DesktopCensus } from './process-census.js';
import { shellEntryFinding, editShell } from './shell-entries.js';
import { dockURLs, launcherFinding } from './launcher-review.js';
import { policyView, createPolicy } from './desktop-policy.js';
import { ApplicationVault } from './application-vault.js';
import { compareVersions } from './claude-authenticity.js';
import { connectorInventory } from './desktop-transfer.js';
import { referenceRepairs, foreignReferenceFiles } from './reference-review.js';
import { inspectGitSharing, gitSharingMessages } from './git-sharing.js';
import { maintenanceFinding, maintenanceBytes } from './maintenance-state.js';
import { releaseVersion } from './release.js';
import type { HealthServices } from './health-services.js';
import { locationKey } from './location-guard.js';
import { Problem, Exit, shellQuote } from './outcomes.js';
import { shortcutState } from './app-shortcut.js';
export interface HealthIssue {
  label: string;
  area: string;
  message: string;
  required: boolean;
}
export interface HealthReport {
  catalog: Catalog;
  issues: HealthIssue[];
}
export class HealthReview {
  constructor(readonly work: LifecycleActions, readonly services: HealthServices) {}
  private issue(issues: HealthIssue[], label: string, area: string, message: string, required = true): void {
    issues.push({ label, area, message, required });
    this.work.out(`${label}: ${area}: ${message}`);
  }
  private async check(
    issues: HealthIssue[], label: string, area: string, action: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.issue(issues, label, area, error instanceof Problem ? error.message :
        'Inspection is unavailable or unsafe.');
    }
  }
  private runtime(profile: Profile): string | null {
    const expected = this.work.code.runtime(this.work.env.PATH ?? '');
    for (const surface of [profile.code, profile.desktop]) {
      if (!surface) {
        continue;
      }
      if (!surface.runtime || !surface.cli || surface.runtime !== expected || surface.cli !== this.work.code.cli) {
        return 'Captured Node or CLI paths moved or are unrecorded; run doctor --apply.';
      }
      accessSync(surface.runtime, constants.X_OK);
      accessSync(surface.cli, constants.R_OK);
      if (!lstatSync(surface.cli).isFile()) {
        return 'The captured CLI entry is not a regular file.';
      }
    }
    return null;
  }
  async inventory(): Promise<HealthReport> {
    const { work } = this;
    const file = join(work.where.control, 'catalog.json');
    work.out(`multi-claude ${releaseVersion}; installation: ${work.code.cli}`);
    work.out(`Catalog: ${file}`);
    const loaded = readCatalog(file, work.io);
    const catalog = loaded.catalog;
    const issues: HealthIssue[] = [];
    work.out(`Catalog schema: ${catalog.formatTag}; ${loaded.kind}; `
      + `${catalog.profiles.length} registered profiles; serial ${catalog.serial}.`);
    const maintenance = maintenanceFinding(catalog, work.where.control, work.code.cli, work.io);
    if (maintenance) {
      this.issue(issues, 'installation', 'maintenance', maintenance, false);
    }
    const candidates = work.code.executables('claude', work.env.PATH ?? '');
    work.out(`Shared Claude Code executable: ${candidates[0] ?? 'not found'}.`);
    if (candidates.length > 1) {
      work.out(`Shadowed alternatives: ${candidates.slice(1).join(', ')}.`);
    }
    if (candidates.length) {
      try {
        const version = await this.services.codeVersion(candidates[0]!);
        work.out(`Shared Claude Code package version: ${version && /^\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(version)
          ? version : 'unavailable without executing the program'}.`);
      } catch {
        work.out('Shared Claude Code version: unavailable.');
      }
    } else if (catalog.profiles.some(profile => profile.code)) {
      this.issue(issues, 'installation', 'Code executable', 'No shared executable was discovered.', false);
    }
    let census: Census;
    let desktopCensus: DesktopCensus;
    try {
      census = await work.code.census(catalog.profiles);
    } catch {
      census = { available: false, processes: [] };
    }
    try {
      desktopCensus = catalog.profiles.some(profile => profile.desktop)
      ? await work.desktop.census() : { available: true, processes: [] };
    } catch {
      desktopCensus = { available: false, processes: [] };
    }
    const sessionStart = await work.code.sessionStart().catch(() => null);
    const launchd = catalog.profiles.some(profile => profile.desktop)
    ? await work.desktop.launchdOverrides?.().catch(() => ['unavailable']) ?? [] : [];
    let baselineConnectors: string[] = [];
    await this.check(issues, 'baseline', 'connectors', () => {
      baselineConnectors = connectorInventory(join(work.where.home, 'Library/Application Support/Claude'), work.io);
    });
    const accounts = new Map<string, string[]>();
    const account = (root: string, label: string) => {
      const bytes = work.io.read(join(root, 'config.json'));
      if (!bytes) {
        return;
      }
      const value: unknown = JSON.parse(bytes.bytes.toString('utf8'));
      if (value && typeof value === 'object' && 'lastKnownAccountUuid' in value
        && typeof value.lastKnownAccountUuid === 'string' && value.lastKnownAccountUuid) {
        const labels = accounts.get(value.lastKnownAccountUuid) ?? [];
        labels.push(label);
        accounts.set(value.lastKnownAccountUuid, labels);
      }
    };
    await this.check(issues, 'baseline', 'account comparison', () =>
      account(join(work.where.home, 'Library/Application Support/Claude'), 'baseline'));
    for (const profile of catalog.profiles) {
      work.out(`${profile.label}: ${profile.code ? 'Code' : ''}${profile.code && profile.desktop ? ' + ' : ''}`
        + `${profile.desktop ? 'Desktop' : ''}; credential policy ${profile.credentialPolicy}.`);
      let unsafe: string | null = null;
      await this.check(issues, profile.label, 'locations', () => {
        unsafe = profilePathFinding(profile, catalog, work.where.home, work.where.control);
        if (unsafe) {
          throw new Problem('profile-overlap', unsafe);
        }
      });
      if (unsafe) {
        continue;
      }
      await this.check(issues, profile.label, 'runtime', () => {
        const finding = this.runtime(profile);
        if (finding) {
          throw new Problem('runtime', finding);
        }
      });
      const roles = [
        ...(profile.code ? ['code'] as const : []),
        ...(profile.desktop ? ['desktop', 'launcher', 'copy'] as const : []),
      ];
      for (const role of roles) {
        await this.check(issues, profile.label, role + ' identity', () => {
          checkedRoot(profile, role, work.io);
          work.out(`${profile.label}: ${role} identity, parent trust and receipt match.`);
        });
      }
      overrideNames(profile, work.env).forEach(name =>
        this.issue(issues, profile.label, 'inherited override',
          `${name}; unset it if this selection is unintended.`, false));
      for (const name of (profile.desktop ? launchd : []).filter(name => /^[A-Z][A-Z0-9_]*$/.test(name))) {
        this.issue(issues, profile.label, 'launchd override',
          `${name}; remedy: /bin/launchctl unsetenv ${name}. Values were not displayed.`, false);
      }
      if (profile.desktop && launchd.includes('unavailable')) {
        this.issue(issues, profile.label, 'launchd',
          'Override names are unavailable; selection effects are unknown.', false);
      }
      if (profile.code) {
        const live = codeLiveness(profile, census, work.io.guard.uid, process.pid);
        work.out(`${profile.label}: Code sessions ${live.state}; disk rules do not establish current `
          + `session enforcement.`);
        await this.check(issues, profile.label, 'shell', () => {
          const finding = shellEntryFinding(profile, work.io, sessionStart);
          if (finding) {
            this.issue(issues, profile.label, 'shell', finding,
              !finding.startsWith('Session age') && !finding.startsWith('Reload'));
          }
        });
        await this.check(issues, profile.label, 'settings authentication', () => {
          const file = work.io.read(join(profile.code!.location, 'settings.json'));
          const value = file ? JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown> : {};
          for (const name of ['apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'otelHeadersHelper']) {
            if (Object.hasOwn(value, name)) {
              this.issue(issues, profile.label, 'settings authentication',
                `${name} is configured; its command and credentials were not inspected or executed.`, false);
            }
          }
          if (value.env && typeof value.env === 'object' && !Array.isArray(value.env)) {
            for (const name of [...authenticationOverrides, ...githubOverrides,
              'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL']) {
              if (Object.hasOwn(value.env, name)) {
                this.issue(issues, profile.label, 'settings authentication',
                  `${name} is set in settings; inherited-environment removal does not attest its `
                  + `account selection.`, false);
              }
            }
          }
        });
        if (profile.code.github) {
          await this.check(issues, profile.label, 'GitHub binding', () => {
            if (profile.code!.github !== join(profile.code!.location, 'github')) {
              throw new Problem('github-binding', 'GitHub selection is outside its designated Code child.');
            }
            const github = githubStorageFinding(profile.code!.github!, work.io);
            if (github) {
              this.issue(issues, profile.label, 'GitHub storage', github +
                ' Use scoped gh auth login --insecure-storage.', false);
            } else {
              work.out(`${profile.label}: file-backed GitHub token fields observed; validity was not tested.`);
            }
          });
        }
        await this.check(issues, profile.label, 'setup references', () => {
          const changes = referenceRepairs(profile, catalog, work.where.home, work.io, message =>
            this.issue(issues, profile.label, 'setup references', message, false));
          const foreign = foreignReferenceFiles(profile, catalog, work.where.home, work.io);
          if (foreign.length) {
            this.issue(issues, profile.label, 'setup references',
              `Eligible references point into baseline or sibling setup in ${foreign.join(', ')}.`, changes.size > 0);
          }
          this.transcriptInventory(profile, issues);
        });
      }
      if (profile.desktop) {
        const vault = new ApplicationVault(work.where.control, work.io, work.desktop,
          new CatalogSession(work.io, work.where.control), profile, () => work.idle(profile, false, true), work.out);
        let sourceValid = false;
        let copyValid = false;
        await this.check(issues, profile.label, 'source signature', async () => {
          await vault.source();
          sourceValid = true;
          work.out(`${profile.label}: source passed deep strict pinned verification.`);
        });
        await this.check(issues, profile.label, 'copy signature', async () => {
          if (!await vault.existing()) {
            throw new Problem('copy-missing',
              'The dedicated copy is absent or invalid; no fallback launch is permitted.');
          }
          copyValid = true;
          work.out(`${profile.label}: dedicated copy passed deep pinned verification.`);
        });
        if (sourceValid && copyValid) {
          await this.check(issues, profile.label, 'copy versions', async () => {
            const source = await work.desktop.version(profile.desktop!.source);
            const copy = await work.desktop.version(vault.application);
            const relation = compareVersions(source, copy);
            work.out(`${profile.label}: source/copy version relation: ${relation === null ? 'unknown'
              : relation > 0 ? 'source newer' : relation < 0 ? 'copy newer; never downgrade' : 'equal'}.`);
            if (relation === 1 && profile.desktop!.updateMode === 'launcher') {
              this.issue(issues, profile.label, 'copy versions', 'A verified newer source is available.');
            }
          });
          await this.check(issues, profile.label, 'tint', () => {
            const receipt = work.io.read(join(vault.parent, '.bcm-copy.json'))!;
            const value = JSON.parse(receipt.bytes.toString('utf8')) as { tint?: string };
            const icon = present(join(vault.application, 'Icon\r'));
            if (value.tint !== profile.desktop!.tint || (profile.desktop!.tint !== 'none' && !icon)) {
              this.issue(issues, profile.label, 'tint', 'Requested tint metadata is missing or unrecorded.');
            }
            work.out(`${profile.label}: tint preference ${profile.desktop!.tint}; rendered Dock color `
              + `needs native observation.`);
          });
        }
        const state = desktopState(profile.desktop.location, join(vault.application, 'Contents/MacOS/Claude'),
          desktopCensus, work.io.guard.uid);
        work.out(`${profile.label}: Desktop process selection ${state.kind}.`);
        if (state.kind === 'wrong' || state.kind === 'unknown') {
          this.issue(issues, profile.label, 'Desktop processes',
            'Selection is wrong or uncertain. Use open-profile for default-No confirmation; '
            + 'doctor will not quit it.', false);
        }
        await this.check(issues, profile.label, 'launcher', async () => {
          checkedRoot(profile, 'launcher', work.io);
          const finding = await launcherFinding(profile, file, work.io, this.services);
          if (finding) {
            throw new Problem('launcher-route', finding);
          }
          work.out(`${profile.label}: launcher identifier, fixed UUID route and synchronous wait match.`);
        });
        const shortcut = profile.desktop.shortcut;
        if (shortcut) {
          const launcher = profile.desktop.launcher;
          await this.check(issues, profile.label, 'shortcut', () => {
            const state = shortcutState(shortcut, launcher);
            if (state !== 'present') {
              throw new Problem('shortcut', state === 'missing'
                ? `The shortcut ${shortcut} is missing. Run repair ${profile.label}.`
                : `${shortcut} is not this profile's link. Remove it yourself or run repair ${profile.label} --no-shortcut.`);
            }
            work.out(`${profile.label}: shortcut links to the launcher.`);
          });
        }
        await this.check(issues, profile.label, 'policy', () => {
          const view = policyView(profile, work.io);
          work.out(`${profile.label}: desired updates ${profile.desktop!.updateMode}; on-disk policy `
            + `${view.effective}, ${view.kind}.`);
          if (view.kind === 'foreign' || view.kind === 'changed') {
            this.issue(issues, profile.label, 'policy',
              'Foreign or changed policy controls behavior and will not be edited.');
          } else if (profile.desktop!.updateMode === 'launcher' && view.effective !== 'blocked') {
            this.issue(issues, profile.label, 'policy', 'Launcher-managed update blocking is not established.');
          }
        });
        if (present(vault.journal)) {
          this.issue(issues, profile.label, 'refresh recovery',
            'An interrupted application refresh needs reviewed recovery.');
        }
        await this.check(issues, profile.label, 'account comparison', () => account(profile.desktop!.location,
          profile.label));
        await this.check(issues, profile.label, 'connectors', () => {
          const names = connectorInventory(profile.desktop!.location, work.io);
          const missing = baselineConnectors.filter(name => !names.includes(name));
          if (missing.length) {
            work.out(`${profile.label}: baseline connector names not selected: ${missing.join(', ')}. `
              + `Information only.`);
          }
        });
      }
    }
    for (const labels of accounts.values()) {
      if (labels.length > 1) {
        this.issue(issues, labels.join(', '), 'account comparison',
          'An account identifier matches across these selections; intentional sharing is '
          + 'possible. Confirm the intended account.',
          false);
      }
    }
    auditFences(catalog, work.where.control, work.io).forEach(finding =>
      this.issue(issues, finding.label, 'read rules', finding.message));
    await this.dockInventory(catalog, issues);
    this.recoveryInventory(catalog, issues);
    for (const retired of catalog.releasedLocations) {
      work.out(`Retired ${retired.role}: ${retired.location}; `
        + `${present(retired.location) ? 'present and protected' : 'absent; identity history retained'}.`);
    }
    const git = await inspectGitSharing(work.where.home, work.env.XDG_CONFIG_HOME ?? join(work.where.home, '.config'),
      work.env, work.io, this.services.tool);
    gitSharingMessages(git).forEach(work.out);
    if (git.unknown) {
      this.issue(issues, 'installation', 'Git sharing', 'Some global Git evidence is unavailable.', false);
    }
    work.out(`Global read rules: ${catalog.fencePolicy}. Read uses permission denials; Grep/Glob `
      + `coverage is best-effort.`);
    work.out('Managed settings can take precedence. Disk contents do not prove effective '
      + 'permissions in existing sessions.');
    work.out('Restart running or uncertain Code sessions after rule additions or removals; later '
      + 'session writes can cause drift.');
    work.out('Bash, MCP filesystem access, baseline .claude/.claude.json, ordinary gh state and '
      + 'shared storage remain outside the guard.');
    work.out('Shared storage includes Library/Logs/Claude, Caches/com.anthropic.claudefordesktop, '
      + 'Preferences, HTTPStorages and claude-cli-nodejs caches.');
    work.out('Pin generated launchers. Direct copies, Spotlight, Login Items and URL/document '
      + 'handlers can bypass profile selection.');
    return { catalog, issues };
  }
  private transcriptInventory(profile: Profile, issues: HealthIssue[]): void {
    for (const directory of [profile.code!.location, join(profile.code!.location, 'projects')]) {
      if (!present(directory)) {
        continue;
      }
      this.work.io.guard.chain(directory);
      const copiedHistory = /(?:baseline|copied|imported).*(?:transcript|session|history).*\.jsonl?$/i;
      const suspect = readdirSync(directory).some(name => copiedHistory.test(name));
      if (suspect) {
        this.issue(issues, profile.label, 'setup history',
          'Suspicious copied transcript/history filenames need review; no content was printed or deleted.', false);
      }
    }
  }
  private recoveryInventory(catalog: Catalog, issues: HealthIssue[]): void {
    const { work } = this;
    const recovery = join(work.where.control, 'recovery');
    const claimed = new Set(catalog.recoveryClaims.map(claim => claim.operationId));
    for (const id of claimed) {
      try {
        const file = work.io.read(join(recovery, id, 'operation.json'));
        const record = file ? JSON.parse(file.bytes.toString('utf8')) as { trees?: { path?: string }[] } : null;
        if (Array.isArray(record?.trees) && record.trees.some(tree => tree.path?.endsWith('/code-stage'))) {
          work.out(`Incomplete Code setup ${id}: retry needs fresh consent and the approved baseline; `
            + `no import was resumed.`);
        }
      } catch {
        this.issue(issues, 'installation', 'recovery record',
          'A retained operation record is unreadable; manual review is required.');
      }
    }
    for (const claim of catalog.recoveryClaims) {
      this.issue(issues, claim.profileId ?? 'installation', 'Pending recovery',
        `${claim.operationId}: ${claim.location}. Review with doctor --recover ${shellQuote(claim.operationId)}.`);
    }
    if (present(recovery)) {
      try {
        work.io.guard.chain(recovery);
        for (const name of readdirSync(recovery)) {
          if (!claimed.has(name)) {
            this.issue(issues, 'installation', 'unrecognized recovery',
              'Uninventoried material exists in the private recovery parent; preserve it for manual review.');
          }
        }
      } catch {
        this.issue(issues, 'installation', 'recovery', 'The recovery parent cannot be safely inventoried.');
      }
    }
    for (const profile of catalog.profiles.filter(value => value.desktop)) {
      const parent = join(work.where.control, 'bundles.noindex', profile.id);
      if (!present(parent)) {
        continue;
      }
      try {
        work.io.guard.chain(parent);
        if (readdirSync(parent).some(name => !['Claude.app', '.bcm-copy.json', 'refresh.json'].includes(name))) {
          this.issue(issues, profile.label, 'application staging',
            'Unrecognized earlier staging was preserved for review.');
        }
      } catch {
        this.issue(issues, profile.label, 'application staging', 'Copy storage cannot be safely inventoried.');
      }
    }
  }
  private async dockInventory(catalog: Catalog, issues: HealthIssue[]): Promise<void> {
    const { work } = this;
    const path = join(work.where.home, 'Library/Preferences/com.apple.dock.plist');
    if (!present(path)) {
      work.out('Dock pin inventory is absent; direct-copy pinning was not tested.');
      return;
    }
    await this.check(issues, 'installation', 'Dock pins', async () => {
      const urls = await dockURLs(path, work.io, this.services);
      const selected = new Set<string>();
      for (const url of urls) {
        if (url.startsWith('file:')) {
          try {
            selected.add(locationKey(fileURLToPath(url).replace(/\/$/, '')));
          } catch {
            this.issue(issues, 'installation', 'Dock pins',
              'A Dock URL is unsupported; pin selection is uncertain.', false);
          }
        }
      }
      for (const profile of catalog.profiles.filter(value => value.desktop)) {
        const copy = join(work.where.control, 'bundles.noindex', profile.id, 'Claude.app');
        if (selected.has(locationKey(copy))) {
          this.issue(issues, profile.label, 'Dock pins',
            'A dedicated copy is pinned directly; pin its generated launcher instead.', false);
        }
      }
    });
  }
  private async repairCode(session: CatalogSession, current: Profile): Promise<number> {
    const { work } = this;
    work.actions.root(current, true);
    const profile = structuredClone(current);
    const code = profile.code!;
    code.runtime = work.code.runtime(work.env.PATH ?? '');
    code.cli = work.code.cli;
    const rc = work.io.read(code.rc);
    const shell = editShell(rc?.bytes ?? Buffer.alloc(0), profile);
    const references = referenceRepairs(profile, session.catalog, work.where.home, work.io, work.out);
    const transaction = work.actions.begin(session, profile.id);
    transaction.bind(current, profile);
    const root = checkedRoot(current, 'code', work.io);
    transaction.pinRoot(root.location, root.device, root.inode);
    let committed = false;
    try {
      let changed = current.code!.runtime !== code.runtime || current.code!.cli !== code.cli;
      if (code.github) {
        const existed = assertGithubDirectory(code.github, work.io, true);
        if (existed) {
          transaction.createDirectory(code.github);
        } else {
          transaction.createExclusiveDirectory(code.github);
        }
        assertGithubDirectory(code.github, work.io);
        changed ||= !existed;
      }
      if (!rc || !shell.equals(rc.bytes)) {
        transaction.createDirectory(join(code.rc, '..'));
        transaction.allow(code.rc);
        work.io.assertImage(code.rc, rc?.image ?? null);
        transaction.write(code.rc, shell);
        code.entryChangedAt = new Date().toISOString();
        changed = true;
        work.out(`${profile.label}: reload ${code.rc}; the managed shell entry changed.`);
      }
      for (const [path, repair] of references) {
        verifyRoot(root, work.io);
        work.io.assertImage(path, repair.image);
        transaction.allow(path);
        transaction.write(path, repair.bytes);
        changed = true;
      }
      if (changed) {
        profile.changedAt = new Date().toISOString();
      }
      transaction.bind(current, profile);
      await work.actions.checkpoint('doctor-code-written');
      const next = work.actions.workingCatalog(session, transaction);
      next.profiles = next.profiles.map(value => value.id === profile.id ? profile : value);
      session.commit(next);
      committed = true;
      const cleanup = transaction.finish();
      if (cleanup) {
        await work.actions.protectAfterFailure(session);
      }
      return cleanup;
    } catch (error) {
      return work.actions.failure(error, transaction, session, committed);
    }
  }
  private async repairDesktop(session: CatalogSession, current: Profile, before: HealthReport): Promise<number> {
    const { work } = this;
    checkedRoot(current, 'desktop', work.io);
    const vault = new ApplicationVault(work.where.control, work.io, work.desktop, session, current,
      () => work.idle(current, false, true), work.out);
    await vault.source();
    await vault.recover();
    const valid = await vault.existing();
    const copy = valid ? await work.desktop.version(vault.application) : null;
    const source = await work.desktop.version(current.desktop!.source);
    if (!valid || (current.desktop!.updateMode === 'launcher' && compareVersions(source, copy) === 1)) {
      await work.idle(current, false, true);
      await vault.ensure();
    }
    let profile = session.catalog.profiles.find(value => value.id === current.id)!;
    const receipt = work.io.read(join(vault.parent, '.bcm-copy.json'));
    const tint = receipt ? (JSON.parse(receipt.bytes.toString('utf8')) as { tint?: string }).tint : undefined;
    const missingIcon = profile.desktop!.tint !== 'none' && !present(join(vault.application, 'Icon\r'));
    if (tint !== profile.desktop!.tint || missingIcon) {
      await vault.repairTint();
    }
    const routeAreas = ['launcher', 'launcher identity', 'runtime'];
    if (before.issues.some(issue => issue.label === profile.label && routeAreas.includes(issue.area))) {
      const status = await work.repairProfile(session, profile, false, false);
      if (status) {
        return status;
      }
    }
    profile = structuredClone(session.catalog.profiles.find(value => value.id === current.id)!);
    const policy = policyView(profile, work.io);
    if (profile.desktop!.updateMode === 'launcher' && policy.kind === 'absent') {
      await work.idle(profile);
      const transaction = work.actions.begin(session, profile.id);
      transaction.bind(profile, profile);
      const original = structuredClone(profile);
      let committed = false;
      try {
        if (!createPolicy(profile, session.catalog, transaction, work.io)) {
          throw new Problem('doctor-policy', 'Owned update-policy creation did not complete.');
        }
        profile.changedAt = new Date().toISOString();
        transaction.bind(original, profile);
        const next = work.actions.workingCatalog(session, transaction);
        next.profiles = next.profiles.map(value => value.id === profile.id ? profile : value);
        session.commit(next);
        committed = true;
        const cleanup = transaction.finish();
        if (cleanup) {
          await work.actions.protectAfterFailure(session);
        }
        return cleanup;
      } catch (error) {
        return work.actions.failure(error, transaction, session, committed);
      }
    }
    if (policy.kind === 'foreign' || policy.kind === 'changed') {
      work.out(`${profile.label}: skipped external or changed policy family; its files and preference remain.`);
      return Exit.findings;
    }
    return Exit.ok;
  }
  async apply(): Promise<number> {
    const { work } = this;
    work.out(`multi-claude ${releaseVersion}; installation: ${work.code.cli}`);
    const initial = readCatalog(join(work.where.control, 'catalog.json'), work.io).catalog;
    if (!initial.profiles.length) {
      const report = await this.inventory();
      work.out('No registered generated resources need repair.');
      return report.issues.length ? Exit.findings : Exit.ok;
    }
    return work.actions.locked(async (session, leases) => {
      const before = await this.inventory();
      const safe = new Set<string>();
      let status = Exit.ok as number;
      work.out('Repair plan: refresh safe shell routes and references, verified Desktop resources, '
        + 'absent owned policies and read rules.');
      work.out('Account state, connectors, extensions, foreign policy, unknown data roots and '
        + 'exclusion intent are not repair targets.');
      for (const profile of [...session.catalog.profiles].sort((a, b) => a.id.localeCompare(b.id))) {
        try {
          const finding = profilePathFinding(profile, session.catalog, work.where.home, work.where.control);
          if (finding) {
            throw new Problem('doctor-scope', finding);
          }
          await leases.profile(profile.id);
          safe.add(profile.id);
        } catch {
          work.out(`${profile.label}: skipped unsafe paths or blocked profile lock; other safe profiles `
            + `will be inspected.`);
          status = Exit.findings;
        }
      }
      for (const id of [...safe].sort()) {
        await work.actions.checkpoint('doctor-before-profile');
        let profile = session.catalog.profiles.find(value => value.id === id)!;
        if (profile.code) {
          try {
            const result = await this.repairCode(session, profile);
            if (result === Exit.interrupted) {
              return result;
            }
            status = result === Exit.recovery ? Exit.recovery : status || result;
          } catch (error) {
            work.out(`${profile.label}: skipped Code repair: `
              + `${error instanceof Problem ? error.message : 'unsafe or unavailable evidence'}`);
            status ||= Exit.findings;
          }
        }
        profile = session.catalog.profiles.find(value => value.id === id)!;
        if (profile.desktop) {
          try {
            const result = await this.repairDesktop(session, profile, before);
            if (result === Exit.interrupted) {
              return result;
            }
            status = result === Exit.recovery ? Exit.recovery : status || result;
          } catch (error) {
            work.out(`${profile.label}: skipped Desktop repair: `
              + `${error instanceof Problem ? error.message : 'unsafe or unavailable evidence'}`);
            status = error instanceof Problem && error.status === Exit.recovery ? Exit.recovery : status ||
            Exit.findings;
          }
        }
      }
      await work.actions.checkpoint('doctor-before-rules');
      const transaction = work.actions.begin(session, null);
      transaction.bind(null, null);
      let committed = false;
      try {
        const next = work.actions.workingCatalog(session, transaction);
        const fences = await work.actions.fences(next, transaction, safe);
        status ||= fences;
        session.commit(next);
        committed = true;
        const cleanup = transaction.finish();
        if (cleanup) {
          status = Exit.recovery;
          await work.actions.protectAfterFailure(session);
        }
      } catch (error) {
        const result = await work.actions.failure(error, transaction, session, committed);
        status = result === Exit.recovery ? Exit.recovery : status || result;
      }
      await work.actions.checkpoint('doctor-before-post-audit');
      work.out('Post-repair audit: checking actual files and registrations again.');
      const after = await this.inventory();
      const required = after.issues.filter(issue => issue.required);
      if (!status && !required.length && !after.catalog.recoveryClaims.length) {
        const stamp = work.actions.begin(session, null);
        stamp.bind(null, null);
        let saved = false;
        try {
          const path = join(work.where.control, 'maintenance.json');
          stamp.allow(path);
          stamp.write(path, maintenanceBytes(session.catalog, work.code.cli, stamp.directory.split('/').at(-1)!, true));
          const next = work.actions.workingCatalog(session, stamp);
          session.commit(next);
          saved = true;
          status = stamp.finish();
        } catch (error) {
          status = await work.actions.failure(error, stamp, session, saved);
        }
      }
      if (required.length || status) {
        work.out('Required repair or cleanup remains unresolved. Maintenance was not recorded as fully applied.');
      } else {
        work.out('Generated-resource audit completed. This is not an authentication or effective-isolation guarantee.');
      }
      const remaining = after.issues.filter(issue => issue.area !== 'maintenance');
      return status || (remaining.length ? Exit.findings : Exit.ok);
    }, false);
  }
}
