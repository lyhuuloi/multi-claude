import { treeManifest } from './private-io.js';
import { shellEntryFinding } from './shell-entries.js';
import { launcherFinding } from './launcher-review.js';
import { productionHealthServices } from './health-services.js';
import type { HealthServices } from './health-services.js';
import { join, dirname, basename } from 'node:path';
import { lstatSync } from 'node:fs';
import { ChangeRecord } from './change-records.js';
import type { OperationRecord } from './change-records.js';
import { LifecycleActions } from './lifecycle-actions.js';
import { validateCatalog, validateLocations, uuid, verifyRoot } from './profile-catalog.js';
import type { Profile, RootEvidence } from './profile-catalog.js';
import { present, checkedRoot } from './managed-resources.js';
import { baselineLocations, overlaps } from './location-guard.js';
import { verifyClaude } from './claude-authenticity.js';
import { ApplicationVault } from './application-vault.js';
import { Problem, Exit } from './outcomes.js';
export class RecoveryActions {
  constructor(
    private readonly work: LifecycleActions,
    private readonly health: HealthServices = productionHealthServices(work.env),
  ) {}
  async recover(id: string): Promise<number> {
    const { work } = this;
    if (!uuid(id)) {
      throw new Problem('recovery-id', 'Recovery requires an operation UUID.', Exit.usage);
    }
    return work.actions.locked(async (session, leases) => {
      const directory = join(work.where.control, 'recovery', id);
      const claim = session.catalog.recoveryClaims.find(value =>
        value.location === directory && value.operationId === id);
      if (!claim) {
        throw new Problem('recovery-unrecognized', 'This operation is not inventoried for recovery.', Exit.recovery);
      }
      const data = work.io.read(join(directory, 'operation.json'));
      if (!claim || !data) {
        throw new Problem('recovery-unrecognized', 'This operation is not inventoried for recovery.', Exit.recovery);
      }
      let record: OperationRecord;
      try {
        record = JSON.parse(data.bytes.toString('utf8')) as OperationRecord;
        if (!record.registration && record.format === 'bcm-operation/1' && record.id === id
          && record.profileId === claim.profileId && Array.isArray(record.scope)) {
          const profile = session.catalog.profiles.find(value => value.id === record.profileId);
          if (!profile?.desktop) {
            throw new Problem('recovery-removed', 'No active Desktop registration owns this refresh.', Exit.recovery);
          }
          const vault = new ApplicationVault(work.where.control, work.io, work.desktop, session, profile,
            () => work.idle(profile, false, true), work.out);
          const journal = work.io.read(vault.journal);
          const refresh = journal ? JSON.parse(journal.bytes.toString('utf8')) as Record<string, unknown> : null;
          if (!refresh || refresh.operation !== directory || refresh.profileId !== profile.id
            || refresh.installationKey !== session.catalog.installationKey) {
            throw new Problem('recovery-binding', 'This operation has no matching refresh journal.', Exit.recovery);
          }
          await leases.profile(profile.id);
          work.out(`Recognized application refresh ${id}; checked scope:`);
          record.scope.forEach(path => work.out(path));
          if (!await work.dialogue.confirm('Recover this interrupted application refresh?')) {
            return Exit.ok;
          }
          work.io.assertImage(join(directory, 'operation.json'), data.image);
          work.io.assertImage(vault.journal, journal!.image);
          await vault.recover();
          const protection = await work.actions.protectAfterFailure(session);
          return protection ? Exit.recovery : Exit.ok;
        }
        if (!record.registration || record.format !== 'bcm-operation/1' || record.id !== id
          || record.profileId !== claim.profileId || !Array.isArray(record.scope) || !Array.isArray(record.files)
          || !Array.isArray(record.moves) || !Array.isArray(record.trees) || !Array.isArray(record.directories)
          || !Array.isArray(record.links) || !['open', 'conflicted', 'complete'].includes(record.phase)) {
          throw new Error('Invalid operation binding');
        }
        for (const snapshot of [record.registration!.before, record.registration!.after]) {
          if (snapshot) {
            if (snapshot.id !== record.profileId) {
              throw new Error('Mismatched profile binding');
            }
            const catalog = structuredClone(session.catalog);
            catalog.profiles = catalog.profiles.filter(profile => profile.id !== snapshot.id).concat(snapshot);
            validateCatalog(catalog);
            validateLocations(catalog, work.where.home, work.where.control);
          }
        }
      } catch {
        throw new Problem('recovery-binding', 'The stored registration scope needs manual review.', Exit.recovery);
      }
      const binding = record.registration!;
      const current = session.catalog.profiles.find(profile => profile.id === record.profileId) ?? null;
      const equal = (left: Profile | null, right: Profile | null) => JSON.stringify(left) === JSON.stringify(right);
      const before = equal(current, binding.before);
      const after = equal(current, binding.after);
      if (!before && !after) {
        throw new Problem('recovery-registration',
          'Registration changed since this operation; automatic restoration is refused.',
          Exit.recovery);
      }
      if (record.profileId) {
        await leases.profile(record.profileId);
      }
      const snapshots = [binding.before, binding.after].filter((profile): profile is Profile => !!profile);
      const roots = snapshots.flatMap(profile => [
        ...(profile.code ? [profile.code.location, profile.code.rc] : []),
        ...(profile.desktop ? [profile.desktop.location, profile.desktop.location + '-3p', profile.desktop.launcher,
          join(work.where.control, 'bundles.noindex', profile.id),
        ] : []),
      ]);
      const inOperation = (path: string) => path === directory || path.startsWith(directory + '/');
      const inResource = (path: string) => roots.some(root => path === root || path.startsWith(root + '/'));
      const siblingSettings = session.catalog.profiles.flatMap(profile => profile.code
        ? [join(profile.code.location, 'settings.json')] : []);
      const baselineSafe = (path: string) => !baselineLocations(work.where.home)
      .some(baseline => overlaps(basename(path) === 'Icon\r' ? dirname(path) : path, baseline));
      const mutationAllowed = (path: string) => typeof path === 'string' && baselineSafe(path)
      && (inOperation(path) || inResource(path) || siblingSettings.includes(path)
        || path === join(work.where.control, 'maintenance.json'));
      const currentCodeRoot = (profile: Profile): RootEvidence => {
        const root = profile.rootEvidence.find(value => value.role === 'code');
        if (!root) {
          throw new Problem('recovery-root', 'The participating Code root has no ownership evidence.', Exit.recovery);
        }
        const moved = record.moves.find(move => move.installed && move.from === root.location);
        if (!moved) {
          return checkedRoot(profile, 'code', work.io);
        }
        if (moved.uncertain || !baselineSafe(moved.to) || !(inOperation(moved.to) || inResource(moved.to))) {
          throw new Problem('recovery-root', 'The moved Code root has uncertain or invalid scope.', Exit.recovery);
        }
        const relocated = { ...root, location: moved.to };
        verifyRoot(relocated, work.io);
        if (JSON.stringify(treeManifest(moved.to, work.io)) !== JSON.stringify(moved.expected)) {
          throw new Problem('recovery-root', 'The moved Code tree differs from its recorded image.', Exit.recovery);
        }
        return relocated;
      };
      const sharedGuards = new Set<string>();
      for (const profile of session.catalog.profiles.filter(value => value.code)) {
        const settings = join(profile.code!.location, 'settings.json');
        const moved = record.moves.find(move => move.installed && move.from === profile.code!.location);
        const guard = record.guards?.find(value => value.path === profile.code!.location || value.path === moved?.to);
        if (!guard || (!record.scope.includes(settings) && !record.files.some(file => file.path === settings))) {
          continue;
        }
        const root = currentCodeRoot(profile);
        if (guard.device !== root.device || guard.inode !== root.inode) {
          throw new Problem('recovery-guard',
            'A settings guard differs from the verified current Code root.', Exit.recovery);
        }
        sharedGuards.add(root.location);
        sharedGuards.add(guard.path);
      }
      const allowed = (path: string) => typeof path === 'string' && (mutationAllowed(path)
        || sharedGuards.has(path)
        || roots.some(root => root.startsWith(path + '/'))
        || path === work.where.control || path === dirname(directory));
      if (record.files.some(file => !mutationAllowed(file.path))
        || record.moves.some(move => ![move.from, move.to].every(path =>
          baselineSafe(path) && (inOperation(path) || inResource(path))))
        || record.trees.some(tree => !inOperation(tree.path))
        || record.directories.some(value =>
          value.path === work.where.home || work.where.home.startsWith(value.path + '/'))) {
        throw new Problem('recovery-scope', 'The operation names an out-of-scope mutation target.', Exit.recovery);
      }
      const finish = (after && !before) || record.phase === 'complete';
      if (!current && binding.before && !finish) {
        throw new Problem('recovery-removed', 'Recovery cannot recreate a removed profile.', Exit.recovery);
      }
      for (const profile of snapshots) {
        await work.idle(profile, false, true);
      }
      work.out(`${finish ? 'Finish approved cleanup' : 'Restore unchanged operation results'} for operation ${id}:`);
      record.scope.forEach(path => work.out(path));
      if (!await work.dialogue.confirm('Recover only these checked unfinished results?')) {
        return Exit.ok;
      }
      work.io.assertImage(join(directory, 'operation.json'), data.image);
      for (const profile of snapshots) {
        await work.idle(profile, false, true);
      }
      // Application recovery requires the same source and nested-code evidence as an ordinary refresh.
      for (const profile of snapshots.filter(value => value.desktop)) {
        const dedicated = join(work.where.control, 'bundles.noindex', profile.id, 'Claude.app');
        const applicationPaths = new Set(record.moves
          .filter(move => move.from === dedicated || move.to === dedicated)
          .flatMap(move => [move.from, move.to]).filter(path => present(path)));
        if (record.files.some(file => file.path.startsWith(dedicated + '/')) && present(dedicated)) {
          applicationPaths.add(dedicated);
        }
        if (applicationPaths.size) {
          await verifyClaude(profile.desktop!.source, true, work.io.guard, work.desktop.tool);
          for (const path of applicationPaths) {
            if (lstatSync(path).isDirectory()) {
              await verifyClaude(path, false, work.io.guard, work.desktop.tool, true);
            }
          }
        }
      }
      const transaction = ChangeRecord.loadApplication(
        work.io, directory, record.profileId, allowed, session.inventory,
      );
      for (const profile of session.catalog.profiles) {
        if (!profile.code) {
          continue;
        }
        const moved = record.moves.find(move => move.installed && move.from === profile.code!.location);
        const location = moved?.to ?? profile.code.location;
        if (record.files.some(file => file.path.startsWith(location + '/'))) {
          const root = currentCodeRoot(profile);
          transaction.pinRoot(root.location, root.device, root.inode);
        }
      }
      let status: number;
      try {
        status = finish ? transaction.finish() : transaction.rollback();
      } catch {
        status = Exit.recovery;
      }
      if (!status) {
        const next = structuredClone(session.catalog);
        next.recoveryClaims = next.recoveryClaims.filter(value => value.operationId !== id);
        session.commit(next);
      }
      if (!status && !finish && current) {
        try {
          const paths = [...record.files.map(file => file.path), ...record.moves.flatMap(move => [move.from, move.to])];
          if (current.code && paths.includes(current.code.rc)) {
            if (shellEntryFinding(current, work.io, Number.MAX_SAFE_INTEGER)
              || current.code.runtime !== work.code.runtime(work.env.PATH ?? '')
              || current.code.cli !== work.code.cli) {
              throw new Error('Restored shell route does not match current policy');
            }
          }
          if (current.desktop && paths.some(path => path === current.desktop!.launcher
            || path.startsWith(current.desktop!.launcher + '/'))) {
            checkedRoot(current, 'launcher', work.io);
            if (await launcherFinding(current, session.file, work.io, this.health)
              || current.desktop.runtime !== work.code.runtime(work.env.PATH ?? '')
              || current.desktop.cli !== work.code.cli) {
              throw new Error('Restored launcher route does not match current policy');
            }
          }
        } catch {
          work.out('Recovery is incomplete: restored launch routing does not meet current policy. Run doctor --apply.');
          status = Exit.findings;
        }
      }
      const protection = await work.actions.protectAfterFailure(session);
      status ||= protection ? Exit.recovery : Exit.ok;
      if (status === Exit.findings) {
        work.out('Restored data needs doctor repair before its launch routes can be trusted.');
      } else if (status) {
        work.out(`Recovery remains unresolved at ${directory}; intervening edits were preserved.`);
      } else {
        work.out('Unfinished operation recovered; temporary pre-images were discarded.');
      }
      return status;
    });
  }
}
