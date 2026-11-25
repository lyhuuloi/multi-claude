import { approveTree, assertApprovedTree } from './approved-tree.js';
import type { ApprovedTree } from './approved-tree.js';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { PrivateIO, sameImage } from './private-io.js';
import type { FileImage } from './private-io.js';
import { ChangeRecord } from './change-records.js';
import { CatalogSession } from './profile-actions.js';
import { canonicalLocation } from './location-guard.js';
import { sameRootIdentity, verifyRoot, uuid, volumeId } from './profile-catalog.js';
import { volumeUuidForPath } from './machine-services.js';
import type { Profile, RootEvidence } from './profile-catalog.js';
import { verifyClaude, compareVersions } from './claude-authenticity.js';
import type { DesktopServices } from './desktop-services.js';
import { Problem, Exit, isMissing } from './outcomes.js';
interface RefreshRecord {
  format: 'bcm-refresh/1';
  installationKey: string;
  profileId: string;
  operation: string;
  phase: 'staging' | 'displacing' | 'old-moved' | 'installed' | 'committed';
  applications: string[];
  displaced?: string;
  evidence?: RootEvidence;
}
type CopyClassification = { kind: 'registered' } | { kind: 'displaced' | 'refuse'; error: unknown };
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
  // Classification grants no ownership of the replacement. Only ensure() may preserve it.
  classifyCopy(): CopyClassification {
    return this.classifyCopyRoot();
  }
  private copyReceipt(evidence: RootEvidence): boolean {
    try {
      const receipt = this.io.read(join(this.parent, '.bcm-copy.json'));
      const value = receipt ? JSON.parse(receipt.bytes.toString('utf8')) as Record<string, unknown> : null;
      return value?.installationKey === evidence.installationKey && value?.profileId === evidence.profileId
        && value?.role === evidence.role && value?.nonce === evidence.nonce;
    } catch {
      return false;
    }
  }
  private classifyCopyRoot(refresh?: FileImage): CopyClassification {
    const evidence = this.profile.rootEvidence.find(value => value.role === 'copy');
    if (!evidence || evidence.location !== this.application) {
      return { kind: 'refuse', error: new Problem('copy-unowned',
        'The installed application is unrecognized; it has been preserved.') };
    }
    try {
      verifyRoot(evidence, this.io);
      return { kind: 'registered' };
    } catch (error) {
      if (error instanceof Problem && error.kind === 'root-identity') {
        try {
          this.io.guard.chain(this.application);
          const stat = lstatSync(this.application, { bigint: true });
          const parent = lstatSync(this.parent, { bigint: true });
          const journal = this.io.read(this.journal);
          if (canonicalLocation(this.application) === evidence.location && stat.isDirectory()
            && !stat.isSymbolicLink() && Number(stat.uid) === evidence.uid && evidence.uid === this.io.guard.uid
            && stat.dev === parent.dev && String(stat.ino) !== evidence.inode
            && Number(parent.uid) === this.io.guard.uid && (parent.mode & 0o777n) === 0o700n
            && this.copyReceipt(evidence)
            && (refresh ? sameImage(journal?.image ?? null, refresh) : !journal)) {
            return { kind: 'displaced', error };
          }
        } catch {
          // Retain the original refusal if any independent safety check fails.
        }
      }
      return { kind: 'refuse', error };
    }
  }
  displacedMessage(): string {
    return 'The dedicated copy was replaced outside multi-claude (for example by Claude\'s own updater '
    + 'after a direct launch). Launch the profile or run `multi-claude repair ' + this.profile.label
    + '` to restage it; the replaced bundle is preserved for review.';
  }
  async existing(): Promise<boolean> {
    if (!this.exists()) {
      return false;
    }
    const classification = this.classifyCopy();
    if (classification.kind !== 'registered') {
      throw classification.error;
    }
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
        || !['staging', 'displacing', 'old-moved', 'installed', 'committed'].includes(record.phase)) {
        throw new Error('Invalid refresh record');
      }
      if (record.displaced !== undefined) {
        const prefix = `displaced-${this.profile.id}-`;
        const name = basename(dirname(record.displaced));
        if (!name.startsWith(prefix) || !uuid(name.slice(prefix.length))
          || record.displaced !== join(this.control, 'recovery', name, 'Claude.app')) {
          throw new Error('Invalid displacement record');
        }
      }
      if (record.evidence !== undefined) {
        const evidence = record.evidence;
        if (evidence.location !== this.application || evidence.role !== 'copy'
          || evidence.installationKey !== record.installationKey || evidence.profileId !== record.profileId
          || evidence.uid !== this.io.guard.uid || !uuid(evidence.nonce)
          || !/^\d+$/.test(evidence.device) || !/^\d+$/.test(evidence.inode)
          || (evidence.volume !== undefined && !volumeId(evidence.volume))) {
          throw new Error('Invalid installed copy evidence');
        }
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
    // The catalog commit can precede publication of the committed journal phase.
    const registered = this.profile.rootEvidence.find(value => value.role === 'copy');
    const committed = record.phase === 'committed' || (record.evidence !== undefined
      && sameRootIdentity(record.evidence, registered));
    if (committed && record.evidence) {
      verifyRoot(record.evidence, this.io);
    }
    try {
      lstatSync(record.operation);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const parent = lstatSync(this.parent, { bigint: true });
      const rolledBack = record.displaced && !this.exists() && registered?.location === this.application
        && registered.uid === this.io.guard.uid
        && Number(parent.uid) === this.io.guard.uid && (parent.mode & 0o777n) === 0o700n
        && this.copyReceipt(registered);
      if ((committed && record.evidence) || rolledBack) {
        // Either finish() or rollback() can complete just before the journal is removed.
        this.session.inventory({ operationId: basename(record.operation), location: record.operation,
          profileId: this.profile.id }, false);
        this.io.remove(this.journal, data.image);
        this.out('An interrupted application refresh was recovered.');
        return;
      }
    }
    const transaction = ChangeRecord.loadApplication(
      this.io, record.operation, this.profile.id, allowed, this.session.inventory,
    );
    // Displacement archives are outside the operation. Keep their refresh binding
    // until recovery completes, including when rollback itself needs another retry.
    if (!record.displaced) {
      this.io.remove(this.journal, data.image);
    }
    let result: number;
    try {
      result = committed ? transaction.finish() : transaction.rollback();
    } catch {
      if (!record.displaced) {
        this.io.write(this.journal, JSON.stringify(record) + '\n', null);
      }
      throw new Problem('refresh-pending', 'Interrupted refresh recovery needs manual review.', Exit.recovery);
    }
    if (result !== Exit.ok) {
      if (!record.displaced) {
        this.io.write(this.journal, JSON.stringify(record) + '\n', null);
      }
      throw new Problem('refresh-pending', 'The interrupted refresh remains protected for review.', Exit.recovery);
    }
    if (record.displaced) {
      await this.services.checkpoint?.('copy-recovered');
      this.io.remove(this.journal, data.image);
    }
    this.out('An interrupted application refresh was recovered.');
  }
  private preserveDisplaced(archive: string, approval: ApprovedTree, refresh: FileImage): void {
    // Archive directories are deliberately not transaction-owned: neither rollback nor
    // successful staging cleanup may restore, adopt or delete this review material.
    const directory = dirname(archive);
    const destination = this.io.directoryExclusive(directory);
    const reservation = this.io.directoryExclusive(archive);
    const parents = this.io.guard.parents(archive);
    this.io.assertImage(this.journal, refresh);
    const classification = this.classifyCopyRoot(refresh);
    if (classification.kind !== 'displaced') {
      throw new Problem('copy-substituted', 'The displaced application changed; it was left untouched.');
    }
    assertApprovedTree(this.application, approval, this.io);
    this.io.guard.recheck(parents);
    this.io.guard.recheck(approval.parents);
    if (this.classifyCopyRoot(refresh).kind !== 'displaced') {
      throw new Problem('copy-substituted', 'The displaced application changed; it was left untouched.');
    }
    const parent = lstatSync(directory, { bigint: true });
    const leaf = lstatSync(archive, { bigint: true });
    const source = lstatSync(this.application, { bigint: true });
    const expected = approval.manifest[0]!;
    if (String(parent.dev) !== destination.device || String(parent.ino) !== destination.inode
      || Number(parent.uid) !== destination.uid || (parent.mode & 0o777n) !== 0o700n
      || !leaf.isDirectory() || String(leaf.dev) !== reservation.device || String(leaf.ino) !== reservation.inode
      || Number(leaf.uid) !== reservation.uid || readdirSync(archive).length
      || !source.isDirectory() || String(source.dev) !== expected.device || String(source.ino) !== expected.inode
      || String(source.uid) !== expected.uid || source.dev !== leaf.dev) {
      throw new Problem('copy-substituted', 'The preservation destination changed; the application was left untouched.');
    }
    renameSync(this.application, archive);
    this.io.flushDirectory(this.parent);
    this.io.flushDirectory(directory);
    this.out(`Replaced application preserved at ${archive}; it can be removed after review.`);
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
    const root = verifyRoot(this.profile.rootEvidence.find(value => value.role === 'copy')!, this.io);
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
    const displaced = hadCopy && this.classifyCopy().kind === 'displaced';
    const valid = displaced ? false : await this.existing();
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
      ? approveTree(this.application, this.io,
        displaced ? undefined : this.profile.rootEvidence.find(root => root.role === 'copy')) : null;
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
        if (displaced) {
          record.displaced = join(this.control, 'recovery', `displaced-${this.profile.id}-${randomUUID()}`, 'Claude.app');
          record.phase = 'displacing';
          publish();
          await this.services.checkpoint?.('copy-displacing');
          await this.idle();
          this.preserveDisplaced(record.displaced, approved, journalImage!);
          await this.services.checkpoint?.('copy-displaced');
        } else {
          transaction.allow(old);
          transaction.moveTree(this.application, old, true, approved);
          record.applications.push(old);
        }
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
      const stat = lstatSync(this.application, { bigint: true }), liveDevice = String(stat.dev), volume = volumeUuidForPath(this.application, liveDevice);
      const evidence: RootEvidence = {
        location: this.application, role: 'copy', uid: Number(stat.uid),
        device: liveDevice, inode: String(stat.ino), ...(volume ? { volume } : {}),
        installationKey: this.session.catalog.installationKey, profileId: this.profile.id, nonce: randomUUID(),
      };
      const receipt = join(this.parent, '.bcm-copy.json');
      transaction.allow(receipt);
      transaction.write(receipt, JSON.stringify({
        installationKey: evidence.installationKey, profileId: evidence.profileId, role: evidence.role,
        nonce: evidence.nonce, tint: this.profile.desktop!.tint,
      }) + '\n');
      await verifyClaude(this.application, false, this.io.guard, this.services.tool, true);
      record.evidence = evidence;
      publish();
      await this.services.checkpoint?.('copy-installed');
      const next = structuredClone(this.session.catalog);
      const updated = next.profiles.find(value => value.id === this.profile.id)!;
      updated.rootEvidence = updated.rootEvidence.filter(value => value.role !== 'copy').concat(evidence);
      updated.changedAt = new Date().toISOString();
      next.recoveryClaims = next.recoveryClaims.filter(value => value.location !== transaction.directory);
      this.session.commit(next);
      this.profile.rootEvidence = structuredClone(updated.rootEvidence);
      committed = true;
      await this.services.checkpoint?.('copy-committed');
      record.phase = 'committed';
      publish();
      if (transaction.finish() !== Exit.ok) {
        throw new Problem('copy-cleanup', 'Application refresh cleanup remains pending.', Exit.recovery);
      }
      await this.services.checkpoint?.('copy-cleaned');
      this.io.remove(this.journal, journalImage!);
      return this.application;
    } catch (error) {
      let result = Exit.recovery as number;
      if (!committed && (valid || !hadCopy || displaced || record?.phase === 'staging')) {
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
        if (journalImage && !record?.displaced) {
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
