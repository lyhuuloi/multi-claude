import { approveTree, assertApprovedTree } from './approved-tree.js';
import type { ApprovedTree } from './approved-tree.js';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import { PrivateIO } from './private-io.js';
import type { FileImage } from './private-io.js';
import {
  readCatalog,
  writeCatalog,
  validateCatalog,
  validateLocations,
  validCommand,
  verifyRoot,
} from './profile-catalog.js';
import type { Catalog, Profile, RootEvidence } from './profile-catalog.js';
import {
  canonicalLocation,
  protectedPath,
  overlaps,
  baselineLocations,
  refuseOverlap,
  locationKey
} from './location-guard.js';
import { ChangeRecord } from './change-records.js';
import type { RecoveryNotice } from './change-records.js';
import { LeaseManager } from './operation-leases.js';
import type { LeaseSession } from './operation-leases.js';
import { Dialogue } from './terminal-dialogue.js';
import { editShell } from './shell-entries.js';
import { collectSetup, eligibleSetup, jsonDocument } from './setup-selection.js';
import { migrateDocument } from './reference-mapping.js';
import { synchronizeFences } from './read-fences.js';
import { executionEnvironment, overrideNames } from './execution-policy.js';
import { assertGithubDirectory, githubStorageFinding, } from './github-configuration.js';
import { codeLiveness } from './process-census.js';
import type { Census } from './process-census.js';
import type { CodeServices, StartedCode } from './code-services.js';
import type { CodePlan } from './surface-plans.js';
import { Exit, Problem, isMissing } from './outcomes.js';
export interface ProfileLocations {
  home: string;
  control: string;
  data: string;
}
export class CatalogSession {
  catalog: Catalog;
  image: FileImage | null;
  readonly file: string;
  constructor(readonly io: PrivateIO, control: string) {
    this.file = join(control, 'catalog.json');
    const loaded = readCatalog(this.file, io);
    this.catalog = loaded.catalog;
    this.image = loaded.image;
  }
  commit(next: Catalog): void {
    next.serial = this.catalog.serial + 1;
    this.image = writeCatalog(this.file, next, this.image, this.io);
    this.catalog = structuredClone(next);
  }
  inventory = (notice: RecoveryNotice, retained: boolean): void => {
    const exists = this.catalog.recoveryClaims.some(claim =>
      claim.operationId === notice.operationId && claim.location === notice.location);
    if (!retained && !exists) {
      return;
    }
    const next = structuredClone(this.catalog);
    next.recoveryClaims = next.recoveryClaims.filter(claim =>
      !(claim.operationId === notice.operationId && claim.location === notice.location));
    if (retained) {
      next.recoveryClaims.push(notice);
    }
    this.commit(next);
  };
}
export interface ReuseConsent {
  location: string;
  serial: number;
  retirementIds: string[];
}
export function validateReuse(catalog: Catalog, location: string, consent: ReuseConsent | null): void {
  const canonical = canonicalLocation(location);
  const retired = catalog.releasedLocations.filter(value => overlaps(value.location, canonical));
  if (!retired.length) {
    return;
  }
  if (retired.some(record => locationKey(record.location) !== locationKey(canonical))) {
    throw new Problem('retired-overlap',
      'Use the exact retired root or a disjoint location, not an ancestor or child.');
  }
  if (!consent || consent.serial !== catalog.serial || consent.location !== canonical
    || JSON.stringify(consent.retirementIds) !== JSON.stringify(retired.map(value => value.id).sort())) {
    throw new Problem('retired-consent', 'Retired path reuse needs current, exact-location confirmation.');
  }
}
export class ProfileActions {
  private interrupted = false;
  constructor(
    private readonly where: ProfileLocations,
    private readonly io: PrivateIO,
    private readonly services: CodeServices,
    private readonly dialogue: Dialogue,
    private readonly out: (message: string) => void,
    private readonly env: NodeJS.ProcessEnv,
  ) {
  }
  private manager(checkAllLocations = true): LeaseManager {
    const prior = readCatalog(join(this.where.control, 'catalog.json'), this.io).catalog;
    if (checkAllLocations) {
      validateLocations(prior, this.where.home, this.where.control);
    }
    return new LeaseManager(join(this.where.control, 'leases'), this.io, this.services.identities);
  }
  async checkpoint(stage: string): Promise<void> {
    await yieldToLoop();
    await this.services.checkpoint?.(stage);
    if (this.interrupted) {
      throw new Problem('interrupted', 'The profile operation was interrupted.', Exit.interrupted);
    }
  }
  async locked(
    action: (session: CatalogSession, leases: LeaseSession) => Promise<number>, checkAllLocations = true,
  ): Promise<number> {
    const interrupt = () => {
      this.interrupted = true;
    };
    process.on('SIGINT', interrupt);
    try {
      return await this.manager(checkAllLocations).withRegistry(async leases => {
        const session = new CatalogSession(this.io, this.where.control);
        if (checkAllLocations) {
          validateLocations(session.catalog, this.where.home, this.where.control);
        }
        return action(session, leases);
      });
    } finally {
      process.off('SIGINT', interrupt);
    }
  }
  private async value(prompt: string, fallback?: string): Promise<string> {
    const value = await this.dialogue.line(prompt + (fallback === undefined ? '' : ` [${fallback}]`));
    if (value === null) {
      throw new Problem('cancelled', 'No profile changes were approved.', Exit.ok);
    }
    const result = value.trim() || fallback;
    if (!result) {
      throw new Problem('input-required', 'This value is required.', Exit.usage);
    }
    return result;
  }
  root(profile: Profile, allowMissingGithub = false): RootEvidence {
    const evidence = profile.rootEvidence.find(value => value.role === 'code');
    if (!profile.code || !evidence || evidence.location !== profile.code.location) {
      throw new Problem('root-evidence', 'The Code root has no matching ownership evidence.');
    }
    verifyRoot(evidence, this.io);
    if (profile.code.github) {
      if (assertGithubDirectory(profile.code.github, this.io, allowMissingGithub)) {
        this.io.read(join(profile.code.github, 'hosts.yml'));
      }
    }
    return evidence;
  }
  private async census(profiles: readonly Profile[]): Promise<Census> {
    try {
      return await this.services.census(profiles);
    } catch {
      return { available: false, processes: [] };
    }
  }
  async idle(profile: Profile, ignore: boolean): Promise<void> {
    const state = codeLiveness(profile, await this.census([profile]), this.io.guard.uid,
      process.pid);
    if (state.state !== 'idle') {
      if (!ignore) {
        throw new Problem('code-busy',
          `Profile ${profile.label} has ${state.state} sessions; lifecycle changes refused.`);
      }
      this.out(`Process override: ${profile.label} is ${state.state}; PIDs: ${state.pids.join(', ') || 'unknown'}.`);
    }
  }
  async reuse(catalog: Catalog, location: string): Promise<ReuseConsent | null> {
    const retired = catalog.releasedLocations.filter(value => overlaps(value.location,
      location));
    if (!retired.length) {
      return null;
    }
    if (retired.some(record => locationKey(record.location) !== locationKey(location))) {
      throw new Problem('retired-overlap', 'Choose the exact retired root or a location outside its ancestry.');
    }
    const names = [...new Set(retired.map(value => value.formerLabel))].join(', ');
    this.out(`Retired location ${location} belonged to ${names}; old login or policy state may survive deletion.`);
    if (!await this.dialogue.confirm('Allow this exact retired location to be reused?')) {
      throw new Problem('cancelled', 'Retired location reuse was refused.', Exit.ok);
    }
    return {
      location: canonicalLocation(location),
      serial: catalog.serial,
      retirementIds: retired.map(value => value.id).sort(),
    };
  }
  begin(session: CatalogSession, profileId: string | null): ChangeRecord {
    return ChangeRecord.begin(this.io, join(this.where.control, 'recovery'), [], session.inventory,
      profileId);
  }
  workingCatalog(session: CatalogSession, transaction: ChangeRecord): Catalog {
    const next = structuredClone(session.catalog);
    // The control subtree already protects temporary operation material until cleanup finishes.
    next.recoveryClaims = next.recoveryClaims.filter(claim => claim.location !== transaction.directory);
    return next;
  }
  async fences(catalog: Catalog, transaction: ChangeRecord, safe?: ReadonlySet<string>): Promise<number> {
    const census = await this.census(catalog.profiles);
    const findings = synchronizeFences(catalog, this.where.control, this.io, (path, bytes, expected, root) => {
      verifyRoot(root, this.io);
      transaction.pinRoot(root.location, root.device, root.inode);
      transaction.allow(path);
      transaction.write(path, bytes, undefined, expected);
    }, profile => {
      const sessions = codeLiveness(profile, census, this.io.guard.uid, process.pid);
      const pids = sessions.pids.join(', ') || (sessions.state === 'idle' ? 'none' : 'unknown');
      this.out(`${profile.label}: observed sessions ${sessions.state}; PIDs: ${pids}.`);
      this.out(`${profile.label}: disk read rules changed. `
        + 'Restart running or uncertain Code sessions before relying on them.');
      this.out('An on-disk rule audit does not establish enforcement in an already running session.');
    }, profile => !safe || safe.has(profile.id));
    for (const finding of findings) {
      this.out(`${finding.label}: ${finding.message}`);
    }
    return findings.length ? Exit.findings : Exit.ok;
  }
  async protectAfterFailure(session: CatalogSession): Promise<number> {
    let transaction: ChangeRecord | undefined;
    try {
      transaction = this.begin(session, null);
      transaction.bind(null, null);
      const next = this.workingCatalog(session, transaction);
      const findings = await this.fences(next, transaction);
      session.commit(next);
      const cleanup = transaction.finish();
      if (cleanup !== Exit.ok) {
        this.out(`Additional protection recovery is pending at ${transaction.directory}.`);
      }
      return cleanup || findings;
    } catch {
      if (transaction) {
        try {
          transaction.rollback();
        } catch {
          this.out(`Protection recovery remains at ${transaction.directory}.`);
        }
      }
      this.out('Some recovery read protections need review; run doctor before relying on them.');
      return Exit.recovery;
    }
  }
  async failure(
    error: unknown, transaction: ChangeRecord, session: CatalogSession, committed: boolean,
  ): Promise<number> {
    let result: number;
    try {
      result = committed ? Exit.recovery : transaction.rollback();
    } catch {
      result = Exit.recovery;
    }
    if (result === Exit.recovery) {
      this.out(`Protected recovery remains at ${transaction.directory}.`);
      await this.protectAfterFailure(session);
      return Exit.recovery;
    }
    if (error instanceof Problem) {
      this.out(error.message);
      return error.status;
    }
    this.out('The operation failed and its unchanged results were rolled back.');
    return Exit.failure;
  }
  assertPlan(session: CatalogSession, planned: Catalog): void {
    this.io.assertImage(session.file, session.image);
    const labels = planned.profiles.map(profile => profile.label);
    const commands = planned.profiles.flatMap(profile => profile.code ? [profile.code.command] : []);
    if (new Set(labels).size !== labels.length || new Set(commands).size !== commands.length) {
      throw new Problem('profile-conflict', 'A profile label or terminal command is already registered.');
    }
    validateCatalog(planned);
    validateLocations(planned, this.where.home, this.where.control);
    for (const profile of planned.profiles) {
      if (profile.code) {
        refuseOverlap(profile.code.rc, [
          ...baselineLocations(this.where.home), this.where.control,
          ...planned.recoveryClaims.map(claim => claim.location),
          ...planned.profiles.flatMap(value => [
            ...(value.code ? [value.code.location] : []),
            ...(value.desktop ? [value.desktop.location, value.desktop.location + '-3p',
              value.desktop.launcher, value.desktop.source] : []),
          ]),
        ]);
      }
    }
  }
  private evidence(location: string, profile: Profile, catalog: Catalog, nonce = randomUUID()): RootEvidence {
    this.io.guard.chain(location);
    const stat = lstatSync(location, { bigint: true });
    if (Number(stat.uid) !== this.io.guard.uid) {
      throw new Problem('root-owner', 'The Code root belongs to another owner.');
    }
    return {
      location: canonicalLocation(location),
      role: 'code',
      uid: Number(stat.uid),
      device: String(stat.dev),
      inode: String(stat.ino),
      installationKey: catalog.installationKey,
      profileId: profile.id,
      nonce,
    };
  }
  async prepareCode(session: CatalogSession, selectedLabel: string, profileId?: string): Promise<CodePlan | null> {
    const existing = session.catalog.profiles.find(profile => profile.label === selectedLabel);
    const nextProfile: Profile = existing ? structuredClone(existing) : {
      id: profileId ?? randomUUID(),
      label: selectedLabel,
      bornAt: new Date().toISOString(),
      changedAt: new Date().toISOString(),
      code: null,
      desktop: null,
      credentialPolicy: 'subscription',
      rootEvidence: [],
    };
    let adopted = false;
    let githubPlannedAbsent = false;
    let adoption: ApprovedTree | undefined;
    let seed = false;
    let reuse: ReuseConsent | null = null;
    if (!existing?.code) {
      const generatedRoot = join(this.where.data, selectedLabel, 'code');
      const rootInput = await this.dialogue.line(`Code directory [${generatedRoot}]`);
      if (rootInput === null) {
        return null;
      }
      const proposed = protectedPath(rootInput.trim() || generatedRoot);
      let ancestor = proposed;
      for (;;) {
        try {
          this.io.guard.chain(ancestor);
          break;
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
          ancestor = dirname(ancestor);
        }
      }
      const location = canonicalLocation(proposed);
      const shellName = this.env.SHELL?.split('/').at(-1);
      const defaultShell = ['zsh', 'bash', 'fish'].includes(shellName ?? '') ? shellName! : 'zsh';
      const shell = await this.value('Shell: zsh, bash or fish', defaultShell);
      if (shell !== 'zsh' && shell !== 'bash' && shell !== 'fish') {
        throw new Problem('shell-kind', 'Choose zsh, bash or fish.', Exit.usage);
      }
      const conventionalRc = shell === 'zsh' ? '.zshrc' : shell === 'bash' ? '.bash_profile' :
      '.config/fish/config.fish';
      const rc = protectedPath(await this.value('Shell rc file:', join(this.where.home,
        conventionalRc)));
      const commandInput = await this.dialogue.line(`Terminal command [claude-${selectedLabel}]`);
      if (commandInput === null) {
        return null;
      }
      const command = commandInput.trim() || `claude-${selectedLabel}`;
      if (!validCommand(command)) {
        throw new Problem('shell-command', 'The terminal command name is invalid or reserved.',
          Exit.usage);
      }
      nextProfile.code = {
        location,
        shell,
        rc,
        command,
        github: null,
        defaultLocation: !rootInput.trim(),
        defaultCommand: !commandInput.trim(),
        entryChangedAt: new Date().toISOString(),
        runtime: this.services.runtime(this.env.PATH ?? ''),
        cli: this.services.cli,
      };
      const policy = await this.value('Credential policy: subscription or inherit', 'subscription');
      if (policy !== 'subscription' && policy !== 'inherit') {
        throw new Problem('credential-policy', 'Choose subscription or inherit.', Exit.usage);
      }
      nextProfile.credentialPolicy = policy;
      try {
        this.io.guard.chain(location);
        adopted = true;
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
      if (adopted) {
        this.out('Adoption registers this existing directory for future deletion. Setup will not be seeded.');
        adoption = approveTree(location, this.io);
        if (!await this.dialogue.confirm('Adopt this existing Code directory?')) {
          return null;
        }
        assertApprovedTree(location, adoption, this.io);
        if (adoption.manifest.some(entry => entry.kind === 'link')) {
          throw new Problem('adoption-link', 'An adopted Code tree cannot contain links.');
        }
      } else if (eligibleSetup(this.where.home, this.io)) {
        this.out('Setup can run hooks and contain third-party credentials; filtering cannot prove their absence.');
        seed = await this.dialogue.confirm('Import allowlisted baseline Code setup?');
      }
      reuse = await this.reuse(session.catalog, location);
    } else {
      this.root(existing);
    }
    const code = nextProfile.code!;
    let github = false;
    if (!code.github && this.services.executables('gh', this.env.PATH ?? '').length) {
      github = await this.dialogue.confirm('Enable a private GitHub CLI directory?');
    }
    if (existing?.code && !github) {
      this.out('The Code surface already exists; no additional work was selected.');
      return null;
    }
    if (github) {
      code.github = join(code.location, 'github');
      githubPlannedAbsent = !assertGithubDirectory(code.github, this.io, true);
    }
    const plan = structuredClone(session.catalog);
    plan.profiles = plan.profiles.filter(profile => profile.id !== nextProfile.id).concat(nextProfile);
    this.assertPlan(session, plan);
    const rcData = this.io.read(code.rc);
    const rcBytes = editShell(rcData?.bytes ?? Buffer.alloc(0), nextProfile);
    this.out(`Code: ${code.location}; shell: ${code.shell}; rc: ${code.rc}; command: ${code.command}.`);
    this.out(`Import: ${seed ? 'allowlisted setup' : 'none'}; GitHub: ${code.github ?? 'not selected'}.`);
    return {
      profile: nextProfile,
      reused: reuse?.retirementIds ?? [],
      preflight: () => {
        this.assertPlan(session, plan);
        if (adoption) {
          assertApprovedTree(code.location, adoption, this.io);
        }
        validateReuse(session.catalog, code.location, reuse);
        this.io.assertImage(code.rc, rcData?.image ?? null);
      },
      build: async transaction => {
        await this.checkpoint('add-confirmed');
        const selectedSetup = seed ? collectSetup(this.where.home, code.location, this.io) : null;
        if (!existing?.code) {
          if (adopted) {
            assertApprovedTree(code.location, adoption!, this.io);
            const evidence = this.evidence(code.location, nextProfile, session.catalog);
            const receipt = join(code.location, '.bcm-root.json');
            transaction.allow(receipt);
            assertApprovedTree(code.location, adoption!, this.io);
            transaction.write(receipt, JSON.stringify({
              installationKey: evidence.installationKey,
              profileId: evidence.profileId,
              role: evidence.role,
              nonce: evidence.nonce,
            }) + '\n');
            nextProfile.rootEvidence.push(evidence);
          } else {
            transaction.createDirectory(dirname(code.location));
            const staging = join(transaction.directory, 'code-stage');
            transaction.allow(staging);
            transaction.allow(code.location);
            transaction.createStaging(staging);
            if (selectedSetup) {
              for (const directory of selectedSetup.directories) {
                this.io.directory(join(staging, directory));
              }
              for (const [name, bytes] of selectedSetup.files) {
                this.io.directory(dirname(join(staging, name)));
                this.io.write(join(staging, name), bytes, null);
              }
              for (const name of selectedSetup.removed) {
                this.out(`Removed setup field: ${name}`);
              }
              for (const warning of selectedSetup.warnings) {
                this.out(warning);
              }
            }
            const evidence = this.evidence(staging, nextProfile, session.catalog);
            this.io.write(join(staging, '.bcm-root.json'), JSON.stringify({
              installationKey: evidence.installationKey,
              profileId: evidence.profileId,
              role: evidence.role,
              nonce: evidence.nonce,
            }) + '\n', null);
            transaction.sealStaging(staging);
            await this.checkpoint('add-staged');
            transaction.moveTree(staging, code.location);
            evidence.location = code.location;
            nextProfile.rootEvidence.push(evidence);
          }
        }
        if (github) {
          if (githubPlannedAbsent) {
            transaction.createExclusiveDirectory(code.github!);
          } else {
            transaction.createDirectory(code.github!);
          }
          assertGithubDirectory(code.github!, this.io);
        }
        transaction.createDirectory(dirname(code.rc));
        transaction.allow(code.rc);
        this.io.assertImage(code.rc, rcData?.image ?? null);
        if (!rcData || !rcBytes.equals(rcData.bytes)) {
          transaction.write(code.rc, rcBytes);
          code.entryChangedAt = new Date().toISOString();
        }
        await this.checkpoint('add-shell');
        return nextProfile;
      },
    };
  }
  migrations(profile: Profile, destination: string): Map<string,
  {
    bytes: Buffer;
    image: FileImage
  }> {
    const result = new Map<string,
    {
      bytes: Buffer;
      image: FileImage
    }>();
    for (const name of ['settings.json', '.claude.json', 'plugins/installed_plugins.json',
      'plugins/known_marketplaces.json']) {
      const data = this.io.read(join(profile.code!.location, name));
      if (!data) {
        continue;
      }
      const value = migrateDocument(name, jsonDocument(data.bytes), {
        source: profile.code!.location,
        destination,
        home: this.where.home,
        required: true,
        warn: this.out,
      });
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      if (!bytes.equals(data.bytes)) {
        result.set(name, { bytes, image: data.image });
      }
    }
    return result;
  }
  async run(selector: string, byId: boolean, args: string[]): Promise<number> {
    let launched: StartedCode | undefined;
    await this.manager().withRegistry(async () => {
      const session = new CatalogSession(this.io, this.where.control);
      const profile = session.catalog.profiles.find(value => byId ? value.id === selector : value.label === selector);
      if (!profile?.code) {
        throw new Problem('profile-missing', 'The selected Code profile is not registered.');
      }
      validateLocations(session.catalog, this.where.home, this.where.control);
      this.root(profile);
      const executable = this.services.executables('claude', this.env.PATH ?? '')[0];
      if (!executable) {
        throw new Problem('claude-missing', 'No shared Claude Code executable is available.',
          Exit.unavailable);
      }
      for (const name of overrideNames(profile, this.env)) {
        this.out(`Inherited override detected: ${name}. Review this variable if profile selection is unexpected.`);
      }
      if (profile.code.github) {
        const finding = githubStorageFinding(profile.code.github, this.io);
        if (finding) {
          this.out(finding);
          this.out('Use scoped gh auth login --insecure-storage before relying on private token selection.');
        }
      }
      launched = this.services.start(executable, args, executionEnvironment(profile, this.env));
      await launched.started;
    });
    return launched!.completion;
  }
}
