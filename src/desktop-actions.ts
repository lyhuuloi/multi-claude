import { lstatSync } from 'node:fs';
import { approveTree, assertApprovedTree } from './approved-tree.js';
import { join, dirname } from 'node:path';
import { PrivateIO } from './private-io.js';
import { CatalogSession, ProfileActions, validateReuse } from './profile-actions.js';
import type { ProfileLocations } from './profile-actions.js';
import type { CodeServices } from './code-services.js';
import type { DesktopServices, Tint } from './desktop-services.js';
import type { DesktopPlan } from './surface-plans.js';
import { Dialogue } from './terminal-dialogue.js';
import { ApplicationVault } from './application-vault.js';
import { compileLauncher } from './dock-bundles.js';
import { verifyClaude } from './claude-authenticity.js';
import { validateLocations, verifyRoot } from './profile-catalog.js';
import type { Profile, RootEvidence } from './profile-catalog.js';
import { protectedPath, canonicalLocation, refuseOverlap, baselineLocations } from './location-guard.js';
import { desktopState } from './process-census.js';
import { createPolicy } from './desktop-policy.js';
import { destination, evidence, present, rootReceipt } from './managed-resources.js';
import { connectorInventory, mergeConnectors } from './desktop-transfer.js';
import { Problem, Exit } from './outcomes.js';
import { shortcutPath } from './app-shortcut.js';
export class DesktopActions {
  constructor(
    private readonly where: ProfileLocations, private readonly io: PrivateIO,
    private readonly services: DesktopServices, private readonly code: CodeServices,
    private readonly dialogue: Dialogue, private readonly out: (message: string) => void,
    private readonly env: NodeJS.ProcessEnv,
  ) {}
  private async value(prompt: string, fallback: string): Promise<string> {
    const answer = await this.dialogue.line(`${prompt} [${fallback}]`);
    if (answer === null) {
      throw new Problem('cancelled', 'Desktop preparation was cancelled.', Exit.ok);
    }
    return answer.trim() || fallback;
  }
  async prepare(session: CatalogSession, name: string, id: string): Promise<DesktopPlan | null> {
    const existing = session.catalog.profiles.find(profile => profile.id === id);
    if (existing?.desktop) {
      this.out('The Desktop surface already exists; its data is preserved.');
      return null;
    }
    const candidates = ['/Applications/Claude.app', join(this.where.home, 'Applications/Claude.app')];
    const detected = candidates.find(path => present(path));
    const sourceInput = await this.dialogue.line(`Claude source application: [${detected ?? 'blank skips Desktop'}]`);
    if (sourceInput === null || (!detected && !sourceInput.trim())) {
      this.out('Desktop skipped; no source application was selected.');
      return null;
    }
    const source = protectedPath(sourceInput.trim() || detected!);
    await verifyClaude(source, true, this.io.guard, this.services.tool);
    const defaultData = join(this.where.data, name, 'desktop');
    const defaultDock = join(this.where.home, 'Applications/Claude Profiles', `Claude ${name}.app`);
    const dataAnswer = await this.dialogue.line(`Desktop data directory: [${defaultData}]`);
    const dockAnswer = await this.dialogue.line(`Dock launcher: [${defaultDock}]`);
    if (dataAnswer === null || dockAnswer === null) {
      return null;
    }
    const location = canonicalLocation(protectedPath(dataAnswer.trim() || defaultData));
    const launcher = canonicalLocation(protectedPath(dockAnswer.trim() || defaultDock));
    const icon = (await this.value('Use the Claude icon? y/n', 'y')).toLowerCase() === 'y';
    const tint = await this.value('Tint: none, amber, copper, mint, sky, violet or rose', 'none');
    if (!['none', 'amber', 'copper', 'mint', 'sky', 'violet', 'rose'].includes(tint) || !launcher.endsWith('.app')) {
      throw new Problem('desktop-plan', 'Choose a supported tint and an .app launcher destination.', Exit.usage);
    }
    const shortcutDirectory = this.services.shortcutDirectory;
    const shortcut = shortcutDirectory
      && (await this.value(`Also add a shortcut in ${shortcutDirectory}? y/n`, 'n')).toLowerCase() === 'y'
      ? protectedPath(shortcutPath(shortcutDirectory, name)) : undefined;
    if (location.toLowerCase().endsWith('-3p')) {
      throw new Problem('desktop-suffix', 'A Desktop data root cannot end in -3p.');
    }
    refuseOverlap(location, [...baselineLocations(this.where.home), source, this.where.control]);
    refuseOverlap(launcher, [
      ...baselineLocations(this.where.home), source, location, location + '-3p', this.where.control,
    ]);
    const adopted = present(location);
    const approval = adopted ? approveTree(location, this.io) : null;
    const policyWasAbsent = !present(location + '-3p');
    let policyEnrolled = false;
    let created: { device: string; inode: string; uid: number } | undefined;
    let enrolled: RootEvidence | undefined;
    const checkAdoption = () => {
      if (policyWasAbsent && !policyEnrolled && present(location + '-3p')) {
        throw new Problem('policy-appeared', 'A planned-absent policy root appeared; it was left untouched.');
      }
      if (enrolled) {
        if (approval) {
          this.io.guard.recheck(approval.parents);
        }
        verifyRoot(enrolled, this.io);
      } else if (approval) {
        assertApprovedTree(location, approval, this.io);
      } else if (created) {
        this.io.guard.chain(location);
        const stat = lstatSync(location, { bigint: true });
        if (String(stat.dev) !== created.device || String(stat.ino) !== created.inode
          || Number(stat.uid) !== created.uid) {
          throw new Problem('desktop-creation', 'The exclusively created Desktop root changed.');
        }
      } else if (present(location)) {
        throw new Problem('desktop-appeared', 'A planned-absent Desktop root appeared; it was left untouched.');
      }
    };
    if (adopted) {
      this.io.guard.chain(location);
      if (approval!.manifest.some(entry => entry.kind === 'link')) {
        throw new Problem('adoption-link', 'An adopted Desktop directory cannot contain links.');
      }
      this.out('Adoption preserves existing files and authorizes future explicit deletion of this root.');
      if (!await this.dialogue.confirm('Adopt this existing Desktop directory?')) {
        return null;
      }
      checkAdoption();
    }
    const actions = new ProfileActions(this.where, this.io, this.code, this.dialogue, this.out, this.env);
    const reuse = await actions.reuse(session.catalog, location);
    checkAdoption();
    const policyReuse = await actions.reuse(session.catalog, location + '-3p');
    checkAdoption();
    const baseline = join(this.where.home, 'Library/Application Support/Claude');
    const connectors = connectorInventory(baseline, this.io);
    let selected: string[] = [];
    if (!adopted && connectors.length) {
      this.out('Connector definitions can contain credentials and commands; none are selected by default.');
      const indexes = await this.dialogue.choose('Select baseline connectors', connectors, true);
      selected = indexes.map(index => connectors[index]!);
    }
    const now = new Date().toISOString();
    const profile: Profile = existing ? structuredClone(existing) : {
      id, label: name, bornAt: now, changedAt: now, code: null, desktop: null,
      credentialPolicy: 'subscription', rootEvidence: [],
    };
    profile.desktop = {
      location, source, launcher, tint: tint as Tint, updateMode: 'launcher', useClaudeIcon: icon,
      defaultLocation: !dataAnswer.trim(), defaultLauncher: !dockAnswer.trim(),
      runtime: this.code.runtime(this.env.PATH ?? ''), cli: this.code.cli,
      ...(shortcut ? { shortcut } : {}),
    };
    const plan = structuredClone(session.catalog);
    plan.profiles = plan.profiles.filter(value => value.id !== id).concat(profile);
    validateLocations(plan, this.where.home, this.where.control);
    const preflight = async () => {
      validateReuse(session.catalog, location, reuse);
      validateReuse(session.catalog, location + '-3p', policyReuse);
      destination(launcher, null, this.io);
      if (adopted) {
        checkAdoption();
      } else {
        destination(location, null, this.io);
      }
      await verifyClaude(source, true, this.io.guard, this.services.tool);
      checkAdoption();
    };
    await preflight();
    this.out(`Desktop data: ${location}; launcher: ${launcher}; tint: ${tint}; updater: launcher-managed.`);
    if (shortcut) {
      this.out(`Shortcut: ${shortcut} (a link to the launcher; other administrators of this Mac can replace it).`);
    }
    this.out(`Connectors selected: ${selected.join(', ') || 'none'}. Existing foreign policy is never changed.`);
    return {
      profile, reused: [...(reuse?.retirementIds ?? []), ...(policyReuse?.retirementIds ?? [])], preflight,
      build: async (transaction, completed) => {
        checkAdoption();
        const result = structuredClone(completed);
        result.desktop = structuredClone(profile.desktop);
        const idle = async () => {
          const executable = join(this.where.control, 'bundles.noindex', id, 'Claude.app/Contents/MacOS/Claude');
          const census = await this.services.census();
          checkAdoption();
          const state = desktopState(location, executable, census, this.io.guard.uid);
          if (state.kind !== 'idle') {
            throw new Problem('desktop-started', 'Desktop process evidence blocks this preparation.');
          }
        };
        await idle();
        checkAdoption();
        created = adopted ? undefined : transaction.createExclusiveDirectory(location);
        if (adopted) {
          transaction.createDirectory(location);
        }
        checkAdoption();
        const data = evidence(location, 'desktop', result, session.catalog, this.io);
        if (created && (data.device !== created.device || data.inode !== created.inode || data.uid !== created.uid)) {
          throw new Problem('desktop-creation', 'The new Desktop root differs from its exclusive creation.');
        }
        transaction.pinRoot(location, data.device, data.inode);
        transaction.allow(join(location, '.bcm-root.json'));
        checkAdoption();
        transaction.write(join(location, '.bcm-root.json'), rootReceipt(data));
        enrolled = data;
        result.rootEvidence.push(data);
        if (selected.length) {
          mergeConnectors(baseline, location, selected, transaction, this.io);
        }
        const vault = new ApplicationVault(this.where.control, this.io, this.services, session, result, idle, this.out);
        destination(vault.application, null, this.io);
        const candidate = await vault.stage(transaction);
        checkAdoption();
        await idle();
        transaction.createDirectory(vault.parent);
        transaction.allow(vault.application);
        transaction.allow(candidate);
        transaction.moveTree(candidate, vault.application);
        const copy = evidence(vault.application, 'copy', result, session.catalog, this.io);
        const copyReceipt = join(vault.parent, '.bcm-copy.json');
        transaction.allow(copyReceipt);
        transaction.write(copyReceipt, rootReceipt(copy, result.desktop!.tint));
        result.rootEvidence.push(copy);
        const scratch = join(transaction.directory, 'dock-stage');
        transaction.allow(scratch);
        transaction.createStaging(scratch);
        const built = join(scratch, 'Launcher.app');
        const input = join(transaction.directory, 'dock-source');
        transaction.allow(input);
        transaction.createStaging(input);
        await compileLauncher(built, input, name, id, result.desktop!.runtime!, result.desktop!.cli!,
          session.file, this.io, this.services, () => transaction.sealStaging(input));
        checkAdoption();
        if (icon) {
          await this.services.icon?.(vault.application, built);
          checkAdoption();
          const stock = join(built, 'Contents/Resources/applet.icns');
          const image = this.io.snapshot(stock);
          if (image) {
            this.io.remove(stock, image);
          }
        }
        const launcherEvidence = evidence(built, 'launcher', result, session.catalog, this.io);
        this.io.write(join(built, '.bcm-root.json'), rootReceipt(launcherEvidence), null);
        transaction.sealStaging(scratch);
        await idle();
        transaction.createDirectory(dirname(launcher));
        transaction.allow(built);
        transaction.allow(launcher);
        transaction.moveTree(built, launcher);
        launcherEvidence.location = launcher;
        result.rootEvidence.push(launcherEvidence);
        if (!createPolicy(result, session.catalog, transaction, this.io)) {
          if (policyWasAbsent) {
            throw new Problem('policy-appeared', 'A planned-absent policy root appeared; it was left untouched.');
          }
          this.out('Foreign or changed policy controls updates; launcher-managed blocking is not established.');
        }
        policyEnrolled = true;
        await verifyClaude(vault.application, false, this.io.guard, this.services.tool, true);
        checkAdoption();
        return result;
      },
    };
  }
}
