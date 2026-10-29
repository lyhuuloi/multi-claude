import { approveTree } from './approved-tree.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { PrivateIO } from './private-io.js';
import { ChangeRecord } from './change-records.js';
import { CatalogSession } from './profile-actions.js';
import { canonicalLocation } from './location-guard.js';
import { verifyRoot } from './profile-catalog.js';
import type { Profile, RootEvidence } from './profile-catalog.js';
import { verifyClaude, compareVersions } from './claude-authenticity.js';
import type { DesktopServices } from './desktop-services.js';
import { Problem, Exit, isMissing } from './outcomes.js';
interface RefreshRecord {
  format: 'bcm-refresh/1';
  installationKey: string;
  profileId: string;
  operation: string;
  phase: 'staging' | 'old-moved' | 'installed' | 'committed';
  applications: string[];
}
export class ApplicationVault {
  readonly parent: string;
  readonly application: string;
  readonly journal: string;
  constructor(
    readonly control: string,
    readonly io: PrivateIO,
    readonly services: DesktopServices,
    readonly session: CatalogSession,
    readonly profile: Profile,
    private readonly idle: () => Promise<void>,
    private readonly out: (value: string) => void,
  ) {
    this.parent = join(control, 'bundles.noindex', profile.id);
    this.application = join(this.parent, 'Claude.app');
    this.journal = join(this.parent, 'refresh.json');
  }
  exists(): boolean {
    try {
      lstatSync(this.application);
      return true;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      return false;
    }
  }
  async source(): Promise<void> {
    await verifyClaude(this.profile.desktop!.source, true, this.io.guard, this.services.tool);
  }
  async existing(): Promise<boolean> {
    if (!this.exists()) {
      return false;
    }
    const evidence = this.profile.rootEvidence.find(value => value.role === 'copy');
    if (!evidence || evidence.location !== this.application) {
      throw new Problem('copy-unowned', 'The installed application is unrecognized; it has been preserved.');
    }
    verifyRoot(evidence, this.io);
    try {
      await verifyClaude(this.application, false, this.io.guard, this.services.tool, true);
      return true;
    } catch (error) {
      if (error instanceof Problem && error.kind === 'claude-signature') {
        return false;
      }
      throw error;
    }
  }
  async recover(): Promise<void> {
    const data = this.io.read(this.journal);
    if (!data) {
      return;
    }
    await this.source();
    await this.idle();
    let record: RefreshRecord;
    try {
      record = JSON.parse(data.bytes.toString('utf8')) as RefreshRecord;
      const expected = join(this.control, 'recovery', basename(record.operation));
      if (record.format !== 'bcm-refresh/1' || record.profileId !== this.profile.id
        || record.installationKey !== this.session.catalog.installationKey || record.operation !== expected
        || canonicalLocation(expected) !== expected || !Array.isArray(record.applications)
        || !['staging', 'old-moved', 'installed', 'committed'].includes(record.phase)) {
        throw new Error('Invalid refresh record');
      }
    } catch {
      throw new Problem('refresh-record', 'The interrupted refresh needs manual review.', Exit.recovery);
    }
    const allowed = (path: string) => path === this.application || path === join(this.parent, '.bcm-copy.json')
    || path === this.control || path === this.parent || path === dirname(this.parent)
    || path === record.operation || path.startsWith(record.operation + '/');
    for (const application of record.applications) {
      if (!allowed(application) || !application.endsWith('/Claude.app')) {
        throw new Problem('refresh-scope', 'The refresh contains an invalid application scope.', Exit.recovery);
      }
      try {
        lstatSync(application);
      } catch (error) {
        if (isMissing(error)) {
          continue;
        }
        throw error;
      }
      await verifyClaude(application, false, this.io.guard, this.services.tool, true);
    }
    const transaction = ChangeRecord.loadApplication(
      this.io, record.operation, this.profile.id, allowed, this.session.inventory,
    );
    this.io.remove(this.journal, data.image);
    let result: number;
    try {
      result = record.phase === 'committed' ? transaction.finish() : transaction.rollback();
    } catch {
      this.io.write(this.journal, JSON.stringify(record) + '\n', null);
      throw new Problem('refresh-pending', 'Interrupted refresh recovery needs manual review.', Exit.recovery);
    }
    if (result !== Exit.ok) {
      this.io.write(this.journal, JSON.stringify(record) + '\n', null);
      throw new Problem('refresh-pending', 'The interrupted refresh remains protected for review.', Exit.recovery);
    }
    this.out('An interrupted application refresh was recovered.');
  }
  async stage(transaction: ChangeRecord): Promise<string> {
    let candidate = '';
    for (const clone of [true, false]) {
      const stage = join(transaction.directory, `candidate-${randomUUID()}`);
      transaction.allow(stage);
      transaction.createStaging(stage);
      candidate = join(stage, 'Claude.app');
      try {
        await this.source();
        await this.idle();
        await this.services.copy(this.profile.desktop!.source, candidate, clone);
        await verifyClaude(candidate, true, this.io.guard, this.services.tool, true);
        await this.idle();
        await this.services.tint(candidate, this.profile.desktop!.tint);
        await verifyClaude(candidate, false, this.io.guard, this.services.tool, true);
        transaction.sealStaging(stage);
        break;
      } catch (error) {
        transaction.sealStaging(stage);
        if (!clone || !(error instanceof Problem) || error.kind !== 'copy-command') {
          throw error;
        }
        candidate = '';
      }
    }
    if (!candidate) {
      throw new Problem('copy-missing', 'No verified application candidate was produced.');
    }
    return candidate;
  }
  async repairTint(): Promise<void> {
    await this.source();
    if (!await this.existing()) {
      throw new Problem('tint-copy', 'Tint repair requires an owned, verified installed copy.');
    }
    await this.idle();
    const receipt = join(this.parent, '.bcm-copy.json');
    const prior = this.io.read(receipt)!;
    const transaction = ChangeRecord.begin(
      this.io, join(this.control, 'recovery'), [], this.session.inventory, this.profile.id,
    );
    transaction.bind(this.profile, this.profile);
    const root = this.profile.rootEvidence.find(value => value.role === 'copy')!;
    transaction.pinRoot(root.location, root.device, root.inode);
    const icon = join(this.application, 'Icon\r');
    transaction.allow(icon);
    try {
      await transaction.externalFile(icon, async () => {
        await this.idle();
        verifyRoot(root, this.io);
        if (this.profile.desktop!.tint === 'none') {
          if (!this.services.clearTint) {
            throw new Problem('tint-capability', 'Clearing icon metadata is unavailable.', Exit.unavailable);
          }
          await this.services.clearTint(this.application);
        } else {
          await this.services.tint(this.application, this.profile.desktop!.tint);
        }
      });
      verifyRoot(root, this.io);
      await verifyClaude(this.application, false, this.io.guard, this.services.tool, true);
      this.io.assertImage(receipt, prior.image);
      transaction.allow(receipt);
      transaction.write(receipt, JSON.stringify({
        ...JSON.parse(prior.bytes.toString('utf8')) as Record<string, unknown>, tint: this.profile.desktop!.tint,
      }) + '\n');
      if (transaction.finish() !== Exit.ok) {
        throw new Problem('tint-cleanup', 'Tint repair cleanup remains pending.', Exit.recovery);
      }
    } catch {
      this.out(`Icon metadata needs reviewed recovery at ${transaction.directory}.`);
      throw new Problem('tint-recovery',
        'The generated copy was preserved after an incomplete metadata repair.', Exit.recovery);
    }
  }
  async ensure(): Promise<string> {
    await this.source();
    await this.recover();
    const hadCopy = this.exists();
    const valid = await this.existing();
    if (valid) {
      const sourceVersion = await this.services.version(this.profile.desktop!.source);
      const installedVersion = await this.services.version(this.application);
      const order = compareVersions(sourceVersion, installedVersion);
      if (order === null) {
        this.out('Application version ordering is unknown; the verified installed copy was retained.');
        return this.application;
      }
      const receipt = this.io.read(join(this.parent, '.bcm-copy.json'));
      const tint = receipt ? (JSON.parse(receipt.bytes.toString()) as { tint?: string }).tint : undefined;
      if (order < 0 || (order === 0 && (tint === undefined || tint === this.profile.desktop!.tint))) {
        return this.application;
      }
    }
    const approved = hadCopy
      ? approveTree(this.application, this.io, this.profile.rootEvidence.find(root => root.role === 'copy')) : null;
    await this.idle();
    const transaction = ChangeRecord.begin(
      this.io, join(this.control, 'recovery'), [], this.session.inventory, this.profile.id,
    );
    let record: RefreshRecord | undefined;
    let committed = false;
    let journalImage = this.io.snapshot(this.journal);
    const publish = () => {
      journalImage = this.io.write(this.journal, JSON.stringify(record) + '\n', journalImage);
    };
    try {
      transaction.createDirectory(this.parent);
      if ((lstatSync(this.parent).mode & 0o777) !== 0o700) {
        throw new Problem('copy-parent', 'Dedicated copy storage is not private.');
      }
      for (const name of readdirSync(this.parent)) {
        if (!['Claude.app', '.bcm-copy.json', 'refresh.json'].includes(name)) {
          this.out('Unrecognized application staging remains in private storage for review.');
        }
      }
      record = {
        format: 'bcm-refresh/1', installationKey: this.session.catalog.installationKey,
        profileId: this.profile.id, operation: transaction.directory, phase: 'staging', applications: [],
      };
      publish();
      const candidate = await this.stage(transaction);
      record.applications.push(candidate);
      publish();
      await this.services.checkpoint?.('copy-staged');
      await this.idle();
      const old = join(transaction.directory, 'Claude.app');
      transaction.allow(this.application);
      if (this.exists()) {
        if (!approved) {
          throw new Problem('copy-substituted', 'An unapproved application appeared during staging; it was preserved.');
        }
        transaction.allow(old);
        transaction.moveTree(this.application, old, true, approved ?? undefined);
        record.applications.push(old);
      }
      record.phase = 'old-moved';
      publish();
      await this.services.checkpoint?.('copy-old-moved');
      await this.idle();
      transaction.allow(candidate);
      transaction.moveTree(candidate, this.application);
      record.phase = 'installed';
      record.applications.push(this.application);
      publish();
      const stat = lstatSync(this.application, { bigint: true });
      const evidence: RootEvidence = {
        location: this.application, role: 'copy', uid: Number(stat.uid),
        device: String(stat.dev), inode: String(stat.ino),
        installationKey: this.session.catalog.installationKey, profileId: this.profile.id, nonce: randomUUID(),
      };
      const receipt = join(this.parent, '.bcm-copy.json');
      transaction.allow(receipt);
      transaction.write(receipt, JSON.stringify({
        installationKey: evidence.installationKey, profileId: evidence.profileId, role: evidence.role,
        nonce: evidence.nonce, tint: this.profile.desktop!.tint,
      }) + '\n');
      await verifyClaude(this.application, false, this.io.guard, this.services.tool, true);
      await this.services.checkpoint?.('copy-installed');
      const next = structuredClone(this.session.catalog);
      const updated = next.profiles.find(value => value.id === this.profile.id)!;
      updated.rootEvidence = updated.rootEvidence.filter(value => value.role !== 'copy').concat(evidence);
      updated.changedAt = new Date().toISOString();
      next.recoveryClaims = next.recoveryClaims.filter(value => value.location !== transaction.directory);
      this.session.commit(next);
      this.profile.rootEvidence = structuredClone(updated.rootEvidence);
      committed = true;
      record.phase = 'committed';
      publish();
      if (transaction.finish() !== Exit.ok) {
        throw new Problem('copy-cleanup', 'Application refresh cleanup remains pending.', Exit.recovery);
      }
      this.io.remove(this.journal, journalImage!);
      return this.application;
    } catch (error) {
      let result = Exit.recovery as number;
      if (!committed && (valid || !hadCopy || record?.phase === 'staging')) {
        for (const application of record?.applications ?? []) {
          try {
            lstatSync(application);
            await verifyClaude(application, false, this.io.guard, this.services.tool, true);
          } catch (failure) {
            if (!isMissing(failure)) {
              throw new Problem('copy-recovery', 'Application recovery needs manual review.', Exit.recovery);
            }
          }
        }
        if (journalImage) {
          this.io.remove(this.journal, journalImage);
          journalImage = null;
        }
        result = transaction.rollback();
      }
      if (result === Exit.ok && journalImage) {
        this.io.remove(this.journal, journalImage);
      }
      if (result !== Exit.ok) {
        throw new Problem('copy-recovery',
          `Protected application recovery remains at ${transaction.directory}.`, Exit.recovery);
      }
      throw error;
    }
  }
}
