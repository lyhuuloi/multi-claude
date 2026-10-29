import { approveTree } from './approved-tree.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrivateIO } from './private-io.js';
import { ProfileActions, CatalogSession } from './profile-actions.js';
import type { ProfileLocations, ReuseConsent } from './profile-actions.js';
import type { CodeServices } from './code-services.js';
import type { DesktopServices } from './desktop-services.js';
import type { ChangeRecord } from './change-records.js';
import type { Catalog, Profile, RootEvidence } from './profile-catalog.js';
import { validLabel, verifyRoot } from './profile-catalog.js';
import { Dialogue } from './terminal-dialogue.js';
import { desktopState } from './process-census.js';
import { compileLauncher } from './dock-bundles.js';
import { ApplicationVault } from './application-vault.js';
import { evidence, checkedRoot, rootReceipt, present, destination, updateLauncher } from './managed-resources.js';
import { validateReuse } from './profile-actions.js';
import { editShell } from './shell-entries.js';
import { githubLogoutGuidance, githubStorageFinding } from './github-configuration.js';
import { policyView, createPolicy, clearPolicy } from './desktop-policy.js';
import { profilePathFinding } from './profile-safety.js';
import { protectedPath } from './location-guard.js';
import type { DirectoryStamp } from './location-guard.js';
import { Problem, Exit } from './outcomes.js';
interface LabelParent {
  path: string;
  device: bigint;
  inode: bigint;
  uid: bigint;
  parents: DirectoryStamp[];
}
export class LifecycleActions {
  readonly actions: ProfileActions;
  constructor(
    readonly where: ProfileLocations, readonly io: PrivateIO, readonly code: CodeServices,
    readonly desktop: DesktopServices, readonly dialogue: Dialogue,
    readonly out: (message: string) => void, readonly env: NodeJS.ProcessEnv,
  ) {
    this.actions = new ProfileActions(where, io, code, dialogue, out, env);
  }
  async select(catalog: Catalog, label: string | undefined, desktopOnly = false): Promise<Profile | undefined> {
    if (label) {
      return catalog.profiles.find(profile => profile.label === label);
    }
    const choices = catalog.profiles.filter(profile => !desktopOnly || profile.desktop);
    const selection = await this.dialogue.choose('Select a profile', choices.map(profile => profile.label));
    return selection.length ? choices[selection[0]!] : undefined;
  }
  async idle(profile: Profile, ignore = false, copySensitive = false): Promise<void> {
    if (profile.code) {
      await this.actions.idle(profile, ignore);
    }
    if (!profile.desktop) {
      return;
    }
    let census;
    try {
      census = await this.desktop.census();
    } catch {
      census = { available: false, processes: [] };
    }
    const executable = join(this.where.control, 'bundles.noindex', profile.id, 'Claude.app/Contents/MacOS/Claude');
    const state = desktopState(profile.desktop.location, executable, census, this.io.guard.uid);
    if (state.kind !== 'idle') {
      const pids = [...state.correct, ...state.wrong].map(process => process.pid).join(', ') || 'unknown';
      if (!ignore || copySensitive) {
        throw new Problem('desktop-busy',
          `Profile ${profile.label} has ${state.kind} Desktop evidence; PIDs: ${pids}.`);
      }
      this.out(`Process override: ${profile.label} Desktop is ${state.kind}; PIDs: ${pids}.`);
    }
  }
  roots(profile: Profile, missing = false): void {
    if (profile.code) {
      checkedRoot(profile, 'code', this.io, missing);
    }
    if (profile.desktop) {
      checkedRoot(profile, 'desktop', this.io, missing);
      for (const role of ['launcher', 'copy'] as const) {
        checkedRoot(profile, role, this.io, missing);
      }
    }
  }
  async copy(session: CatalogSession, profile: Profile): Promise<string> {
    const vault = new ApplicationVault(this.where.control, this.io, this.desktop, session, profile,
      () => this.idle(profile, false, true), this.out);
    await vault.source();
    await vault.recover();
    if (await vault.existing()) {
      return vault.application;
    }
    await this.idle(profile, false, true);
    return vault.ensure();
  }
  async launcher(
    session: CatalogSession, profile: Profile, transaction: ChangeRecord, application: string,
  ): Promise<{ built: string; root: RootEvidence }> {
    const scratch = join(transaction.directory, 'launcher-' + randomUUID());
    transaction.allow(scratch);
    transaction.createStaging(scratch);
    const built = join(scratch, 'Launcher.app');
    const desktop = profile.desktop!;
    const input = join(transaction.directory, 'launcher-source-' + randomUUID());
    transaction.allow(input);
    transaction.createStaging(input);
    await compileLauncher(built, input, profile.label, profile.id, desktop.runtime!, desktop.cli!,
      session.file, this.io, this.desktop, () => transaction.sealStaging(input));
    if (desktop.useClaudeIcon !== false) {
      await this.desktop.icon?.(application, built);
      const stock = join(built, 'Contents/Resources/applet.icns');
      const image = this.io.snapshot(stock);
      if (image) {
        this.io.remove(stock, image);
      }
    }
    const root = evidence(built, 'launcher', profile, session.catalog, this.io);
    this.io.write(join(built, '.bcm-root.json'), rootReceipt(root), null);
    transaction.sealStaging(scratch);
    return { built, root };
  }
  private async refreshIcon(profile: Profile, application: string): Promise<number> {
    if (profile.desktop!.useClaudeIcon === false || !this.desktop.icon) {
      return Exit.ok;
    }
    try {
      checkedRoot(profile, 'launcher', this.io);
      await this.desktop.icon(application, profile.desktop!.launcher);
      checkedRoot(profile, 'launcher', this.io);
      return Exit.ok;
    } catch {
      this.out('The verified launcher route is installed, but its icon metadata needs another repair.');
      return Exit.findings;
    }
  }
  private retire(catalog: Catalog, profile: Profile, location: string, role: 'code' | 'desktop' | 'policy',
    reason: 'kept' | 'deleted' | 'relocated'): void {
    catalog.releasedLocations.push({
      id: randomUUID(), location, role, formerProfileId: profile.id, formerLabel: profile.label,
      retiredAt: new Date().toISOString(), reason, reusedBy: null,
    });
  }
  private labelParent(profile: Profile): LabelParent | null {
    const path = join(this.where.data, profile.label);
    if (![profile.code?.location, profile.desktop?.location].some(root => root && dirname(root) === path)) {
      return null;
    }
    try {
      const parents = this.io.guard.parents(path);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(this.io.guard.uid)) {
        return null;
      }
      return { path, device: stat.dev, inode: stat.ino, uid: stat.uid, parents };
    } catch {
      return null;
    }
  }
  private removeLabelParent(parent: LabelParent | null): void {
    if (!parent || dirname(parent.path) !== this.where.data) {
      return;
    }
    try {
      this.io.guard.recheck(parent.parents);
      const stat = lstatSync(parent.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parent.device
        || stat.ino !== parent.inode || stat.uid !== parent.uid) {
        this.out(`The changed profile parent was preserved: ${parent.path}.`);
        return;
      }
      rmdirSync(parent.path);
      this.io.flushDirectory(this.where.data);
    } catch (error) {
      if (!['ENOTEMPTY', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        this.out(`The profile parent could not be safely removed and was preserved: ${parent.path}.`);
      }
    }
  }
  async rename(oldLabel: string | undefined, newLabel: string | undefined, ignore: boolean): Promise<number> {
    return this.actions.locked(async (session, leases) => {
      let current = await this.select(session.catalog, oldLabel);
      if (!current) {
        this.out('No matching profile was selected.');
        return Exit.ok;
      }
      await leases.profile(current.id);
      const label = newLabel ?? (await this.dialogue.line('New profile label:'))?.trim();
      if (!label) {
        return Exit.ok;
      }
      if (!validLabel(label)) {
        throw new Problem('profile-label', 'The new profile label is invalid.', Exit.usage);
      }
      if (label === current.label) {
        return Exit.ok;
      }
      this.roots(current);
      const labelParent = this.labelParent(current);
      await this.idle(current, ignore);
      const profile = structuredClone(current);
      profile.label = label;
      profile.changedAt = new Date().toISOString();
      const moves: { from: string; to: string; role: 'code' | 'desktop' | 'policy' | 'launcher' }[] = [];
      if (profile.code) {
        const code = profile.code;
        if (code.defaultLocation) {
          moves.push({ from: code.location, to: join(this.where.data, label, 'code'), role: 'code' });
          code.location = moves.at(-1)!.to;
          if (code.github) {
            code.github = join(code.location, 'github');
          }
        }
        if (code.defaultCommand) {
          code.command = 'claude-' + label;
        }
        code.runtime = this.code.runtime(this.env.PATH ?? '');
        code.cli = this.code.cli;
      }
      if (profile.desktop) {
        const desktop = profile.desktop;
        if (desktop.defaultLocation) {
          const next = join(this.where.data, label, 'desktop');
          moves.push({ from: desktop.location, to: next, role: 'desktop' });
          const policy = policyView(current, this.io);
          if (policy.kind !== 'absent') {
            if (policy.kind !== 'owned') {
              throw new Problem('policy-migration', 'An unverified policy root cannot be migrated.');
            }
            moves.push({ from: desktop.location + '-3p', to: next + '-3p', role: 'policy' });
          }
          desktop.location = next;
        }
        if (desktop.defaultLauncher) {
          moves.push({ from: desktop.launcher,
            to: join(this.where.home, 'Applications/Claude Profiles', `Claude ${label}.app`), role: 'launcher' });
          desktop.launcher = moves.at(-1)!.to;
        }
        desktop.runtime = this.code.runtime(this.env.PATH ?? '');
        desktop.cli = this.code.cli;
      }
      for (const move of moves) {
        destination(move.to, move.from, this.io);
        profile.rootEvidence = profile.rootEvidence.map(root => root.role === move.role ? { ...root, location: move.to }
          : root);
      }
      if (current.desktop && profile.desktop!.location !== current.desktop.location
        && !moves.some(move => move.role === 'policy')) {
        destination(profile.desktop!.location + '-3p', null, this.io);
      }
      const plan = structuredClone(session.catalog);
      plan.profiles = plan.profiles.map(value => value.id === profile.id ? profile : value);
      this.actions.assertPlan(session, plan);
      const migrations = current.code && profile.code!.location !== current.code.location
      ? this.actions.migrations(current, profile.code!.location) : new Map();
      const rc = profile.code ? this.io.read(profile.code.rc) : null;
      const shell = profile.code ? editShell(rc?.bytes ?? Buffer.alloc(0), profile) : null;
      const consents: ReuseConsent[] = [];
      for (const move of moves.filter(move => move.role !== 'launcher')) {
        const consent = await this.actions.reuse(session.catalog, move.to);
        if (consent) {
          consents.push(consent);
        }
        this.out(`${move.role}: ${move.from} -> ${move.to}`);
      }
      this.out(`Rename ${current.label} to ${label}; UUID remains ${profile.id}.`);
      if (profile.code) {
        this.out(`Shell: ${profile.code.rc}; command: ${profile.code.command}. `
          + 'Moved Code roots may require login again.');
      }
      if (!await this.dialogue.confirm('Apply this rename?')) {
        return Exit.ok;
      }
      this.actions.assertPlan(session, plan);
      consents.forEach(consent => validateReuse(session.catalog, consent.location, consent));
      this.roots(current);
      await this.idle(current, ignore);
      for (const move of moves) {
        destination(move.to, move.from, this.io);
      }
      if (profile.code) {
        this.io.assertImage(profile.code.rc, rc?.image ?? null);
        for (const [name, file] of migrations) {
          this.io.assertImage(join(current.code!.location, name), file.image);
        }
      }
      const application = current.desktop ? await this.copy(session, current) : '';
      current = session.catalog.profiles.find(value => value.id === profile.id)!;
      profile.rootEvidence = profile.rootEvidence.filter(root => root.role !== 'copy')
      .concat(current.rootEvidence.filter(root => root.role === 'copy'));
      const transaction = this.actions.begin(session, profile.id);
      transaction.bind(current, profile);
      let committed = false;
      try {
        const approved = new Map(moves.map(move => [move.from,
          approveTree(move.from, this.io, current.rootEvidence.find(root => root.role === move.role))]));
        const staged = profile.desktop ? await this.launcher(session, profile, transaction, application) : null;
        await this.actions.checkpoint('rename-staged');
        await this.idle(current, ignore);
        this.roots(current);
        for (const move of moves) {
          destination(move.to, move.from, this.io);
        }
        if (moves.some(move => move.role === 'policy') && policyView(current, this.io).kind !== 'owned') {
          throw new Problem('policy-migration', 'Policy ownership changed during launcher staging.');
        }
        if (current.code) {
          for (const [name, file] of migrations) {
            this.io.assertImage(join(current.code.location, name), file.image);
          }
          this.io.assertImage(current.code.rc, rc?.image ?? null);
        }
        for (const move of moves) {
          const root = current.rootEvidence.find(value => value.role === move.role)!;
          verifyRoot(root, this.io);
          destination(move.to, move.from, this.io);
          transaction.createDirectory(dirname(move.to));
          transaction.allow(move.from);
          transaction.allow(move.to);
          await this.actions.checkpoint('rename-before-' + move.role);
          verifyRoot(root, this.io);
          if (move.role === 'policy' && policyView(current, this.io).kind !== 'owned') {
            throw new Problem('policy-migration', 'The owned policy family changed before migration.');
          }
          await this.idle(current, ignore);
          transaction.moveTree(move.from, move.to, false, approved.get(move.from));
          await this.actions.checkpoint('rename-moved-' + move.role);
        }
        await this.actions.checkpoint('rename-moved');
        if (profile.code) {
          for (const [name, file] of migrations) {
            const path = join(profile.code.location, name);
            this.io.assertImage(path, file.image);
            transaction.allow(path);
            transaction.write(path, file.bytes);
          }
          transaction.allow(profile.code.rc);
          this.io.assertImage(profile.code.rc, rc?.image ?? null);
          if (!rc || !shell!.equals(rc.bytes)) {
            transaction.write(profile.code.rc, shell!);
            profile.code.entryChangedAt = new Date().toISOString();
          }
        }
        await this.actions.checkpoint('rename-shell');
        if (staged) {
          const root = profile.rootEvidence.find(value => value.role === 'launcher')!;
          await this.idle(profile, ignore);
          updateLauncher(staged.built, profile.desktop!.launcher, root, transaction, this.io);
        }
        await this.actions.checkpoint('rename-launcher');
        const next = this.actions.workingCatalog(session, transaction);
        next.profiles = next.profiles.map(value => value.id === profile.id ? profile : value);
        for (const move of moves.filter(move => move.role !== 'launcher')) {
          this.retire(next, current, move.from, move.role as 'code' | 'desktop' | 'policy', 'relocated');
        }
        if (current.desktop && profile.desktop!.location !== current.desktop.location
          && !moves.some(move => move.role === 'policy')) {
          this.retire(next, current, current.desktop.location + '-3p', 'policy', 'relocated');
        }
        next.releasedLocations.forEach(record => {
          if (consents.some(consent => consent.retirementIds.includes(record.id))) {
            record.reusedBy = profile.id;
          }
        });
        const findings = await this.actions.fences(next, transaction);
        await this.actions.checkpoint('rename-fences');
        transaction.bind(current, profile);
        this.roots(profile);
        session.commit(next);
        committed = true;
        let registration = Exit.ok as number;
        if (profile.desktop && this.desktop.register) {
          registration = await this.desktop.register(profile.desktop.launcher) ? Exit.ok : Exit.findings;
        }
        const cleanup = transaction.finish();
        if (cleanup) {
          await this.actions.protectAfterFailure(session);
        }
        if (!cleanup) {
          this.removeLabelParent(labelParent);
        }
        const icon = !cleanup && profile.desktop ? await this.refreshIcon(profile, application) : Exit.ok;
        this.out(`Renamed profile ${label}. ${profile.desktop ? 'Launcher: ' + profile.desktop.launcher : ''}`);
        if (profile.code) {
          this.out(`Reload ${profile.code.rc}; relocated Code data can require reauthentication.`);
        }
        return cleanup || findings || registration || icon;
      } catch (error) {
        return this.actions.failure(error, transaction, session, committed);
      }
    });
  }
  async remove(label: string | undefined, ignore: boolean): Promise<number> {
    return this.actions.locked(async (session, leases) => {
      const profile = await this.select(session.catalog, label);
      if (!profile) {
        this.out('The registration is already absent or no profile was selected.');
        return Exit.ok;
      }
      await leases.profile(profile.id);
      for (const root of profile.rootEvidence.filter(value => value.role !== 'policy')) {
        if (!present(root.location)) {
          continue;
        }
        const before = lstatSync(root.location, { bigint: true });
        if (before.isSymbolicLink()) {
          this.io.guard.parents(root.location);
          if (!await this.dialogue.confirm(
            'Unlink only the substituted link, keep its target and registration, then stop?')) {
            return Exit.ok;
          }
          const transaction = this.actions.begin(session, profile.id);
          try {
            transaction.allow(root.location);
            transaction.unlinkLink(root.location, {
              device: String(before.dev), inode: String(before.ino), uid: Number(before.uid),
            });
            this.out('Only the confirmed link was removed. The registration and target remain.');
            return transaction.finish();
          } catch (error) {
            return this.actions.failure(error, transaction, session, false);
          }
        }
      }
      this.roots(profile, true);
      const labelParent = this.labelParent(profile);
      await this.idle(profile, ignore);
      const initiallyMissing = new Set(profile.rootEvidence.filter(root => !present(root.location))
        .map(root => root.location));
      const rc = profile.code ? this.io.read(profile.code.rc) : null;
      const shell = profile.code ? editShell(rc?.bytes ?? Buffer.alloc(0), profile, true) : null;
      if (profile.code?.github) {
        const finding = githubStorageFinding(profile.code.github, this.io);
        if (finding) {
          this.out(finding);
        }
        this.out(githubLogoutGuidance(profile.code.github));
      }
      this.out('Keychain entries are left untouched. '
        + 'Use /logout inside the selected Code profile before removal if desired.');
      const eraseCode = !!profile.code && !initiallyMissing.has(profile.code.location)
      && await this.dialogue.confirm('Delete this profile’s Code data?');
      const eraseDesktop = !!profile.desktop && !initiallyMissing.has(profile.desktop.location)
      && await this.dialogue.confirm('Delete this profile’s Desktop data?');
      if (profile.code) {
        this.out(`${eraseCode ? 'Delete' : 'Keep'} Code data: ${profile.code.location}.`);
      }
      if (profile.desktop) {
        this.out(`${eraseDesktop ? 'Delete' : 'Keep'} Desktop data: ${profile.desktop.location}.`);
      }
      if (!await this.dialogue.confirm('Remove this profile registration and generated launch resources?')) {
        return Exit.ok;
      }
      this.io.assertImage(session.file, session.image);
      this.roots(profile, true);
      for (const path of initiallyMissing) {
        if (present(path)) {
          throw new Problem('root-reappeared', 'A previously missing resource reappeared after confirmation.');
        }
      }
      await this.idle(profile, ignore, !!profile.desktop);
      if (profile.code) {
        this.io.assertImage(profile.code.rc, rc?.image ?? null);
      }
      const transaction = this.actions.begin(session, profile.id);
      transaction.bind(profile, null);
      let committed = false;
      try {
        let findings = Exit.ok as number;
        const stageRemoval = async (role: 'launcher' | 'copy' | 'code' | 'desktop') => {
          const root = checkedRoot(profile, role, this.io, true);
          if (!present(root.location)) {
            return;
          }
          const approved = approveTree(root.location, this.io, root);
          await this.actions.checkpoint('remove-before-' + role);
          verifyRoot(root, this.io);
          await this.idle(profile, ignore, role === 'copy');
          const retired = join(transaction.directory, 'removed-' + role);
          transaction.allow(root.location);
          transaction.allow(retired);
          transaction.moveTree(root.location, retired, true, approved);
        };
        if (profile.desktop) {
          await stageRemoval('launcher');
          await stageRemoval('copy');
          const receipt = join(this.where.control, 'bundles.noindex', profile.id, '.bcm-copy.json');
          if (present(receipt)) {
            transaction.allow(receipt);
            transaction.remove(receipt);
          }
          for (const path of [profile.desktop.launcher,
            join(this.where.control, 'bundles.noindex', profile.id, 'Claude.app')]) {
            if (this.desktop.unregister && !await this.desktop.unregister(path)) {
              this.out(`LaunchServices could not unregister ${path}; review stale entries manually.`);
              findings = Exit.findings;
            }
          }
        }
        if (profile.code) {
          if (present(profile.code.location)) {
            const detached = structuredClone(session.catalog);
            detached.fencePolicy = 'disabled';
            detached.profiles = [profile];
            findings = await this.actions.fences(detached, transaction) || findings;
          }
          transaction.allow(profile.code.rc);
          this.io.assertImage(profile.code.rc, rc?.image ?? null);
          if (rc && !shell!.equals(rc.bytes)) {
            transaction.write(profile.code.rc, shell!);
          }
        }
        await this.actions.checkpoint('remove-shell');
        if (eraseCode) {
          await stageRemoval('code');
        }
        if (eraseDesktop) {
          await stageRemoval('desktop');
          const policyProfile = structuredClone(profile);
          if (!clearPolicy(policyProfile, transaction, this.io)) {
            this.out(`Policy family was changed or foreign and remains at ${profile.desktop!.location}-3p.`);
            findings = Exit.findings;
          }
        }
        await this.actions.checkpoint('remove-staged');
        const next = this.actions.workingCatalog(session, transaction);
        next.profiles = next.profiles.filter(value => value.id !== profile.id);
        next.ruleClaims = next.ruleClaims.filter(value => value.profileId !== profile.id);
        if (profile.code) {
          this.retire(next, profile, profile.code.location, 'code',
            eraseCode || initiallyMissing.has(profile.code.location) ? 'deleted' : 'kept');
        }
        if (profile.desktop) {
          this.retire(next, profile, profile.desktop.location, 'desktop',
            eraseDesktop || initiallyMissing.has(profile.desktop.location) ? 'deleted' : 'kept');
          this.retire(next, profile, profile.desktop.location + '-3p', 'policy',
            present(profile.desktop.location + '-3p') ? 'kept' : 'deleted');
        }
        findings = await this.actions.fences(next, transaction) || findings;
        await this.actions.checkpoint('remove-fences');
        session.commit(next);
        committed = true;
        const cleanup = transaction.finish();
        if (cleanup) {
          await this.actions.protectAfterFailure(session);
          this.out(`Registration removed; cleanup is pending at ${transaction.directory}.`);
        }
        if (!cleanup && (eraseCode || eraseDesktop)) {
          this.removeLabelParent(labelParent);
        }
        this.out('Registration removed. Kept data and retired identities remain protected; '
          + 'credentials were not revoked.');
        return cleanup || findings;
      } catch (error) {
        return this.actions.failure(error, transaction, session, committed);
      }
    });
  }
  async repair(label: string | undefined, refreshDock: boolean): Promise<number> {
    return this.actions.locked(async (session, leases) => {
      let current = await this.select(session.catalog, label, true);
      if (!current?.desktop) {
        this.out('This profile has no Desktop launcher to repair.');
        return Exit.ok;
      }
      await leases.profile(current.id);
      return this.repairProfile(session, current, refreshDock, true);
    });
  }
  async repairProfile(session: CatalogSession, current: Profile, refreshDock = false, askDock = false):
  Promise<number> {
    checkedRoot(current, 'desktop', this.io);
    const application = await this.copy(session, current);
    current = session.catalog.profiles.find(value => value.id === current!.id)!;
    const profile = structuredClone(current);
    const desktop = profile.desktop!;
    desktop.runtime = this.code.runtime(this.env.PATH ?? '');
    desktop.cli = this.code.cli;
    let root: RootEvidence | null = null;
    if (present(desktop.launcher)) {
      try {
        root = checkedRoot(profile, 'launcher', this.io);
      } catch {
        const original = desktop.launcher;
        const parent = dirname(original);
        let alternative: string;
        do {
          alternative = join(parent, `Claude ${profile.label} repaired-${randomUUID().slice(0, 8)}.app`);
        } while (present(alternative));
        desktop.launcher = protectedPath(alternative);
        desktop.defaultLauncher = false;
        this.out(`Unrecognized bundle preserved at ${original}. New launcher: ${desktop.launcher}.`);
      }
    }
    if (!root) {
      profile.rootEvidence = profile.rootEvidence.filter(value => value.role !== 'launcher');
      destination(desktop.launcher, null, this.io);
    }
    const nextPlan = structuredClone(session.catalog);
    nextPlan.profiles = nextPlan.profiles.map(value => value.id === profile.id ? profile : value);
    this.io.assertImage(session.file, session.image);
    const unsafe = profilePathFinding(profile, nextPlan, this.where.home, this.where.control);
    if (unsafe) {
      throw new Problem('repair-scope', unsafe);
    }
    const transaction = this.actions.begin(session, profile.id);
    transaction.bind(current, profile);
    let committed = false;
    try {
      const staged = await this.launcher(session, profile, transaction, application);
      await this.actions.checkpoint('repair-staged');
      if (root) {
        updateLauncher(staged.built, desktop.launcher, root, transaction, this.io);
      } else {
        transaction.createDirectory(dirname(desktop.launcher));
        transaction.allow(staged.built);
        transaction.allow(desktop.launcher);
        transaction.moveTree(staged.built, desktop.launcher);
        staged.root.location = desktop.launcher;
        profile.rootEvidence = profile.rootEvidence.filter(value => value.role !== 'launcher').concat(staged.root);
      }
      profile.changedAt = new Date().toISOString();
      transaction.bind(current, profile);
      checkedRoot(profile, 'launcher', this.io);
      const next = this.actions.workingCatalog(session, transaction);
      next.profiles = next.profiles.map(value => value.id === profile.id ? profile : value);
      const findings = await this.actions.fences(next, transaction);
      session.commit(next);
      committed = true;
      const registered = this.desktop.register ? await this.desktop.register(desktop.launcher) : true;
      const cleanup = transaction.finish();
      if (cleanup) {
        await this.actions.protectAfterFailure(session);
      }
      const icon = !cleanup ? await this.refreshIcon(profile, application) : Exit.ok;
      if (!refreshDock && askDock) {
        try {
          refreshDock = await this.dialogue.confirm('Briefly restart the Dock to refresh this launcher icon?');
        } catch (error) {
          if (!(error instanceof Problem) || error.status !== Exit.usage) {
            throw error;
          }
        }
      }
      if (refreshDock && this.desktop.refreshDock) {
        checkedRoot(profile, 'launcher', this.io);
        await this.desktop.refreshDock(desktop.launcher);
      }
      this.out(`Launcher repaired at ${desktop.launcher}; the profile UUID and data are preserved.`);
      return cleanup || findings || icon || (registered ? Exit.ok : Exit.findings);
    } catch (error) {
      return this.actions.failure(error, transaction, session, committed);
    }
  }
  async updates(label: string | undefined, mode: string | undefined): Promise<number> {
    const report = (profile: Profile): number => {
      const view = policyView(profile, this.io);
      this.out(`${profile.label}: desired ${profile.desktop!.updateMode}; `
        + `effective ${view.effective}; ${view.kind} policy.`);
      if (view.kind === 'foreign' || view.kind === 'changed') {
        this.out(`External or changed policy controls ${view.location}; its contents were left untouched.`);
        return Exit.findings;
      }
      return profile.desktop!.updateMode === 'launcher' && view.effective !== 'blocked' ? Exit.findings : Exit.ok;
    };
    if (!mode) {
      const session = new CatalogSession(this.io, this.where.control);
      const profiles = session.catalog.profiles.filter(profile =>
        profile.desktop && (!label || profile.label === label));
      if (label && !profiles.length) {
        throw new Problem('profile-missing', 'No Desktop profile has that label.', Exit.usage);
      }
      return profiles.reduce((status, profile) => report(profile) || status, Exit.ok as number);
    }
    return this.actions.locked(async (session, leases) => {
      const current = await this.select(session.catalog, label, true);
      if (!current?.desktop) {
        throw new Problem('profile-missing', 'Select a Desktop profile.', Exit.usage);
      }
      await leases.profile(current.id);
      checkedRoot(current, 'desktop', this.io);
      const view = policyView(current, this.io);
      if (current.desktop.updateMode === mode && (mode === 'launcher' ? view.kind === 'owned'
        && view.effective === 'blocked' : view.kind === 'absent')) {
        return report(current);
      }
      if (view.kind === 'foreign' || view.kind === 'changed') {
        report(current);
        throw new Problem('policy-family', 'The policy family is not intact and owned; the preference was preserved.');
      }
      if (mode === 'application') {
        this.out('Claude updates may discard tint or relaunch without the selected data directory.');
        if (!await this.dialogue.confirm('Allow the application to manage updates?')) {
          return Exit.ok;
        }
      }
      await this.idle(current);
      const profile = structuredClone(current);
      const transaction = this.actions.begin(session, profile.id);
      transaction.bind(current, current);
      let committed = false;
      try {
        const success = mode === 'launcher'
        ? createPolicy(profile, session.catalog, transaction, this.io)
        : clearPolicy(profile, transaction, this.io);
        if (!success) {
          throw new Problem('policy-family', 'The policy change was refused; the preference was preserved.');
        }
        profile.desktop!.updateMode = mode as 'application' | 'launcher';
        profile.changedAt = new Date().toISOString();
        transaction.bind(current, profile);
        await this.actions.checkpoint('policy-written');
        const next = this.actions.workingCatalog(session, transaction);
        next.profiles = next.profiles.map(value => value.id === profile.id ? profile : value);
        const findings = await this.actions.fences(next, transaction);
        session.commit(next);
        committed = true;
        const cleanup = transaction.finish();
        if (cleanup) {
          await this.actions.protectAfterFailure(session);
        }
        this.out('Update policy changed. Reopen existing Desktop processes before relying on it.');
        return cleanup || findings || report(profile);
      } catch (error) {
        return this.actions.failure(error, transaction, session, committed);
      }
    });
  }
}
