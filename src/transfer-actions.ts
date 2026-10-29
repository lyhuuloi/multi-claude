import { approveTree } from './approved-tree.js';
import { join } from 'node:path';
import { LifecycleActions } from './lifecycle-actions.js';
import {
  extensionInventory, connectorInventory, stageExtension, extensionSettings, mergeConnectors,
} from './desktop-transfer.js';
import { checkedRoot, present } from './managed-resources.js';
import { treeManifest } from './private-io.js';
import { jsonDocument } from './setup-selection.js';
import { Problem, Exit } from './outcomes.js';
export class TransferActions {
  constructor(private readonly work: LifecycleActions) {}
  async copy(sourceLabel: string | undefined, targetLabel: string | undefined, replace: boolean): Promise<number> {
    const { work } = this;
    return work.actions.locked(async (session, leases) => {
      if (!sourceLabel) {
        const labels = [
          'baseline', ...session.catalog.profiles.filter(profile => profile.desktop).map(profile => profile.label),
        ];
        const selected = await work.dialogue.choose('Select the setup source', labels);
        if (!selected.length) {
          return Exit.ok;
        }
        sourceLabel = labels[selected[0]!]!;
      }
      const target = await work.select(session.catalog, targetLabel, true);
      const source = session.catalog.profiles.find(profile => profile.label === sourceLabel);
      if (!target?.desktop || (sourceLabel !== 'baseline' && !source?.desktop) || source?.id === target.id) {
        throw new Problem('transfer-selection',
          'Choose distinct Desktop profiles; baseline can only be a source.', Exit.usage);
      }
      const ids = [...new Set([target.id, ...(source ? [source.id] : [])])].sort();
      for (const id of ids) {
        await leases.profile(id);
      }
      checkedRoot(target, 'desktop', work.io);
      if (source) {
        checkedRoot(source, 'desktop', work.io);
      }
      const sourceRoot = source?.desktop?.location ?? join(work.where.home, 'Library/Application Support/Claude');
      const targetRoot = target.desktop.location;
      const extensions = extensionInventory(sourceRoot, work.io);
      const connectors = connectorInventory(sourceRoot, work.io);
      work.out('Extension settings and connectors may contain credentials or executable commands. '
        + 'Nothing is selected by default.');
      const chosenExtensions = await work.dialogue.choose('Select extensions', extensions, true);
      const chosenConnectors = await work.dialogue.choose('Select connectors', connectors, true);
      if (!chosenExtensions.length && !chosenConnectors.length) {
        return Exit.ok;
      }
      await work.idle(target);
      let status = Exit.ok as number;
      for (const index of chosenExtensions) {
        const id = extensions[index]!;
        const installed = join(targetRoot, 'Claude Extensions', id);
        const conflict = present(installed);
        if (conflict && !replace && !await work.dialogue.confirm(`Replace selected extension ${id}?`)) {
          work.out(`Skipped extension: ${id}.`);
          continue;
        }
        const transaction = work.actions.begin(session, target.id);
        transaction.bind(target, target);
        let committed = false;
        try {
          const approved = conflict ? approveTree(installed, work.io) : undefined;
          const before = approved?.manifest ?? null;
          if (before?.some(entry => entry.kind === 'link')) {
            throw new Problem('extension-target-link', 'The selected target extension contains links.');
          }
          const bytes = extensionSettings(sourceRoot, id, work.io);
          if (!bytes) {
            work.out(`Extension ${id} has no source settings; replacement settings will not be retained.`);
          }
          const settings = join(targetRoot, 'Claude Extensions Settings', id + '.json');
          const prior = work.io.read(settings);
          if (prior) {
            jsonDocument(prior.bytes);
          }
          const staged = stageExtension(sourceRoot, id, transaction, work.io);
          await work.actions.checkpoint('transfer-staged');
          checkedRoot(target, 'desktop', work.io);
          await work.idle(target);
          work.io.assertImage(settings, prior?.image ?? null);
          if (JSON.stringify(present(installed) ? treeManifest(installed, work.io) : null) !== JSON.stringify(before)) {
            throw new Problem('extension-target-race', 'The selected target changed after inspection.');
          }
          transaction.createDirectory(join(targetRoot, 'Claude Extensions'));
          transaction.allow(installed);
          if (conflict) {
            const old = join(transaction.directory, 'old-extension');
            transaction.allow(old);
            transaction.moveTree(installed, old, true, approved);
          }
          transaction.moveTree(staged, installed);
          await work.actions.checkpoint('transfer-extension-installed');
          checkedRoot(target, 'desktop', work.io);
          transaction.pinRoot(targetRoot, String(checkedRoot(target, 'desktop', work.io).device),
            checkedRoot(target, 'desktop', work.io).inode);
          transaction.allow(settings);
          work.io.assertImage(settings, prior?.image ?? null);
          if (bytes) {
            transaction.createDirectory(join(targetRoot, 'Claude Extensions Settings'));
            transaction.write(settings, bytes);
          } else if (prior) {
            transaction.remove(settings);
          }
          const updated = structuredClone(target);
          updated.changedAt = new Date().toISOString();
          transaction.bind(target, updated);
          const next = work.actions.workingCatalog(session, transaction);
          next.profiles = next.profiles.map(profile => profile.id === target.id ? updated : profile);
          session.commit(next);
          committed = true;
          const cleanup = transaction.finish();
          status = cleanup || status;
          work.out(`Copied extension: ${id}.`);
          Object.assign(target, updated);
        } catch (error) {
          const failure = await work.actions.failure(error, transaction, session, committed);
          status = failure === Exit.recovery ? Exit.recovery : status || Exit.findings;
          work.out(`Failed extension: ${id}.`);
        }
      }
      if (chosenConnectors.length) {
        const transaction = work.actions.begin(session, target.id);
        transaction.bind(target, target);
        let committed = false;
        try {
          checkedRoot(target, 'desktop', work.io);
          await work.idle(target);
          const selected = chosenConnectors.map(index => connectors[index]!);
          const root = checkedRoot(target, 'desktop', work.io);
          transaction.pinRoot(root.location, root.device, root.inode);
          const result = mergeConnectors(sourceRoot, targetRoot, selected, transaction, work.io);
          const updated = structuredClone(target);
          if (result.copied.length) {
            updated.changedAt = new Date().toISOString();
          }
          transaction.bind(target, updated);
          const next = work.actions.workingCatalog(session, transaction);
          next.profiles = next.profiles.map(profile => profile.id === target.id ? updated : profile);
          session.commit(next);
          committed = true;
          status = transaction.finish() || status;
          result.copied.forEach(name => work.out(`Copied connector: ${name}.`));
          result.unchanged.forEach(name => work.out(`Unchanged connector: ${name}.`));
        } catch (error) {
          const failure = await work.actions.failure(error, transaction, session, committed);
          status = failure === Exit.recovery ? Exit.recovery : status || Exit.findings;
          work.out('Failed selected connectors; existing definitions were preserved or reported as recovery.');
        }
      }
      if (status === Exit.recovery) {
        await work.actions.protectAfterFailure(session);
      }
      work.out('Restart the target Desktop instance before using copied setup.');
      return status;
    });
  }
}
