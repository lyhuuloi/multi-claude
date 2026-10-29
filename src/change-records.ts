import { assertApprovedTree } from './approved-tree.js';
import type { ApprovedTree } from './approved-tree.js';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { lstatSync, rmdirSync, readdirSync, renameSync, readlinkSync, unlinkSync } from 'node:fs';
import { PrivateIO, sameImage, digest, treeManifest, cleanSealedTree } from './private-io.js';
import type { Profile } from './profile-catalog.js';
import type { FileImage, TreeEntry } from './private-io.js';
import { canonicalLocation } from './location-guard.js';
import { Problem, Exit, isMissing } from './outcomes.js';
// Finder stores custom icons in this fixed metadata filename; it is never a selectable root.
function operationLocation(path: string): string {
  return basename(path) === 'Icon\r' ? join(canonicalLocation(dirname(path)), 'Icon\r') : canonicalLocation(path);
}
interface FileChange {
  path: string;
  before: FileImage | null;
  stored: string | null;
  storedDigest: string | null;
  expected: FileImage | null;
  produced: boolean;
  uncertain: boolean;
}
interface StagingTree {
  path: string;
  state: 'planned' | 'created' | 'sealed' | 'installed';
  manifest: TreeEntry[];
}
interface TreeMove {
  from: string;
  to: string;
  expected: TreeEntry[];
  installed: boolean;
  uncertain: boolean;
  discard: boolean;
}
export interface OperationRecord {
  format: 'bcm-operation/1';
  registration?: { before: Profile | null; after: Profile | null };
  guards?: { path: string; device: string; inode: string }[];
  id: string;
  profileId: string | null;
  phase: 'open' | 'conflicted' | 'complete';
  scope: string[];
  files: FileChange[];
  trees: StagingTree[];
  moves: TreeMove[];
  directories: {
    path: string;
    device: string;
    inode: string
  }[];
  links: {
    path: string;
    device: string;
    inode: string;
    uid: number;
    digest: string;
    removed: boolean
  }[];
}
export interface RecoveryNotice {
  operationId: string;
  location: string;
  profileId: string | null;
}
export type RecoveryInventory = (notice: RecoveryNotice, retained: boolean) => void;
export class ChangeRecord {
  private recordImage: FileImage | null = null;
  private rootIdentity: {
    device: string;
    inode: string
  } | undefined;
  private readonly record: OperationRecord;
  readonly directory: string;
  private constructor(
    readonly io: PrivateIO,
    recovery: string,
    scope: readonly string[],
    private readonly inventory: RecoveryInventory,
    profileId: string | null,
    loaded?: { directory: string; record: OperationRecord; image: FileImage },
  ) {
    if (loaded) {
      this.directory = loaded.directory;
      this.record = loaded.record;
      this.recordImage = loaded.image;
      const stat = lstatSync(this.directory, { bigint: true });
      this.rootIdentity = { device: String(stat.dev), inode: String(stat.ino) };
      this.checkRoot();
      for (const move of this.record.moves.filter(value => value.installed && !value.uncertain)) {
        this.remapGuards(move.from, move.to);
      }
      return;
    }
    const id = randomUUID();
    this.directory = join(recovery, id);
    this.record = {
      format: 'bcm-operation/1',
      id,
      profileId,
      phase: 'open',
      scope: scope.map(operationLocation),
      files: [],
      trees: [],
      moves: [],
      directories: [],
      links: [],
    };
  }
  static begin(
    io: PrivateIO,
    recovery: string,
    scope: readonly string[],
    inventory: RecoveryInventory,
    profileId: string | null = null,
  ): ChangeRecord {
    const operation = new ChangeRecord(io, recovery, scope, inventory, profileId);
    if (new Set(operation.record.scope).size !== operation.record.scope.length) {
      throw new Problem('operation-scope', 'Operation targets must be distinct canonical locations.');
    }
    io.directory(operation.directory);
    const stamp = lstatSync(operation.directory, { bigint: true });
    operation.rootIdentity = { device: String(stamp.dev), inode: String(stamp.ino) };
    operation.persist();
    inventory(operation.notice(), true);
    return operation;
  }
  static loadApplication(
    io: PrivateIO, directory: string, profileId: string | null, allowed: (path: string) => boolean,
    inventory: RecoveryInventory,
  ): ChangeRecord {
    const data = io.read(join(directory, 'operation.json'));
    if (!data) {
      throw new Problem('recovery-record', 'The application operation record is missing.', Exit.recovery);
    }
    let record: OperationRecord;
    try {
      record = JSON.parse(data.bytes.toString('utf8')) as OperationRecord;
      if (record.format !== 'bcm-operation/1' || record.id !== basename(directory) || record.profileId !== profileId
        || !['open', 'conflicted', 'complete'].includes(record.phase) || !Array.isArray(record.scope)
        || !Array.isArray(record.files) || !Array.isArray(record.trees) || !Array.isArray(record.moves)
        || !Array.isArray(record.directories) || !Array.isArray(record.links) || record.links.length) {
        throw new Error('Invalid operation record');
      }
      const paths = [
        ...record.scope, ...record.files.map(value => value.path), ...record.trees.map(value => value.path),
        ...record.moves.flatMap(value => [value.from, value.to]), ...record.directories.map(value => value.path),
        ...(record.guards ?? []).map(value => value.path),
      ];
      if (paths.some(path => typeof path !== 'string' || !allowed(path) || operationLocation(path) !== path)) {
        throw new Error('Invalid restoration scope');
      }
    } catch {
      throw new Problem('recovery-scope',
        'The stored application operation cannot be safely recovered.', Exit.recovery);
    }
    return new ChangeRecord(io, dirname(directory), [], inventory, profileId, {
      directory, record, image: data.image,
    });
  }
  bind(before: Profile | null, after: Profile | null): void {
    this.record.registration = structuredClone({ before, after });
    this.persist();
  }
  preserveParents(activeRoots: readonly string[]): void {
    this.record.directories = this.record.directories.filter(directory =>
      !activeRoots.some(root => root.startsWith(directory.path + '/')));
    this.persist();
  }
  pinRoot(path: string, device: string, inode: string): void {
    this.record.guards ??= [];
    if (!this.record.guards.some(value => value.path === path)) {
      this.record.guards.push({ path, device, inode });
      this.persist();
    }
  }
  private checkGuards(path: string): void {
    for (const guard of this.record.guards ?? []) {
      if (path === guard.path || path.startsWith(guard.path + '/')) {
        this.io.guard.chain(guard.path);
        const stat = lstatSync(guard.path, { bigint: true });
        if (String(stat.dev) !== guard.device || String(stat.ino) !== guard.inode) {
          throw new Problem('guard-substituted', 'The operation root identity changed.', Exit.recovery);
        }
      }
    }
  }
  async externalFile(path: string, action: () => Promise<void>): Promise<void> {
    this.checkGuards(path);
    this.assertMoved(path);
    this.capture(path);
    const file = this.record.files.find(value => value.path === path)!;
    this.io.assertImage(path, file.expected);
    file.uncertain = true;
    this.persist();
    await action();
    this.checkGuards(path);
    file.expected = this.io.snapshot(path);
    file.produced = true;
    file.uncertain = false;
    this.refreshMoved(path);
    this.persist();
  }
  remove(path: string): void {
    this.checkGuards(path);
    this.assertMoved(path);
    this.capture(path);
    const file = this.record.files.find(value => value.path === path)!;
    this.io.assertImage(path, file.expected);
    if (!file.expected) {
      return;
    }
    file.uncertain = true;
    this.persist();
    this.io.remove(path, file.expected);
    file.expected = null;
    file.produced = true;
    file.uncertain = false;
    this.refreshMoved(path);
    this.persist();
  }
  private notice(location = this.directory): RecoveryNotice {
    return { operationId: this.record.id, location, profileId: this.record.profileId };
  }
  private checkRoot(): void {
    this.io.guard.chain(this.directory);
    const stat = lstatSync(this.directory, { bigint: true });
    if (!this.rootIdentity || String(stat.dev) !== this.rootIdentity.device
      || String(stat.ino) !== this.rootIdentity.inode || (stat.mode & 0o777n) !== 0o700n) {
      throw new Problem('recovery-root', 'The private recovery root changed.', Exit.recovery);
    }
  }
  private persist(): void {
    this.checkRoot();
    this.recordImage = this.io.write(
      join(this.directory, 'operation.json'), JSON.stringify(this.record, null, 2) + '\n',
      this.recordImage,
    );
  }
  allow(path: string): void {
    const location = operationLocation(path);
    if (!this.record.scope.includes(location)) {
      this.record.scope.push(location);
      this.persist();
    }
  }
  private checkScope(path: string): void {
    if (!this.record.scope.includes(operationLocation(path))) {
      throw new Problem('operation-scope', 'This target is outside the recorded operation scope.');
    }
  }
  inspect(path: string): FileImage | null {
    this.checkScope(path);
    return this.io.snapshot(path);
  }
  capture(path: string): void {
    this.checkScope(path);
    if (this.record.files.some(file => file.path === path)) {
      return;
    }
    const data = this.io.read(path);
    const name = data ? `prior-${randomUUID()}` : null;
    if (name && data) {
      this.io.write(join(this.directory, name), data.bytes, null);
    }
    this.record.files.push({
      path,
      before: data?.image ?? null,
      stored: name,
      storedDigest: data?.image.digest ?? null,
      expected: data?.image ?? null,
      produced: false,
      uncertain: false,
    });
    this.persist();
  }
  private assertMoved(path: string): void {
    for (const move of this.record.moves) {
      if (move.installed && path.startsWith(move.to + '/')) {
        if (JSON.stringify(treeManifest(move.to, this.io)) !== JSON.stringify(move.expected)) {
          throw new Problem('move-conflict', 'The moved tree changed outside this operation.');
        }
      }
    }
  }
  private refreshMoved(path: string, excluded = new Set<TreeMove>()): void {
    for (const move of this.record.moves) {
      if (!move.installed || excluded.has(move) || !path.startsWith(move.to + '/')) {
        continue;
      }
      const target = path.slice(move.to.length + 1);
      const current = treeManifest(move.to, this.io);
      const before = new Map(move.expected.map(entry => [entry.name, entry]));
      const after = new Map(current.map(entry => [entry.name, entry]));
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (name === target) {
          continue;
        }
        const old = before.get(name);
        const next = after.get(name);
        const ancestor = name === '' || target.startsWith(name + '/');
        const validAncestor = ancestor && old?.kind === 'directory' && next?.kind === 'directory'
        && old.device === next.device && old.inode === next.inode && old.uid === next.uid && old.mode === next.mode;
        if (!validAncestor && JSON.stringify(old) !== JSON.stringify(next)) {
          throw new Problem('move-conflict', 'A concurrent tree change cannot become operation-owned.');
        }
      }
      move.expected = current;
    }
  }
  write(path: string, bytes: Buffer | string, mode?: number, expected?: FileImage | null): void {
    this.checkGuards(path);
    this.assertMoved(path);
    if (expected !== undefined) {
      this.io.assertImage(path, expected);
    }
    this.capture(path);
    const file = this.record.files.find(value => value.path === path)!;
    this.io.assertImage(path, file.expected);
    file.uncertain = true;
    this.persist();
    try {
      if (expected !== undefined) {
        this.io.assertImage(path, expected);
      }
      file.expected = this.io.write(path, bytes, file.expected, mode ?? file.before?.mode ?? 0o600);
      file.produced = true;
      file.uncertain = false;
      this.refreshMoved(path);
      this.persist();
    } catch (error) {
      this.checkGuards(path);
      if (sameImage(this.io.snapshot(path), file.expected)) {
        file.uncertain = false;
        this.persist();
      }
      throw error;
    }
  }
  createDirectory(path: string): void {
    this.assertMoved(path);
    this.allow(path);
    try {
      this.io.guard.chain(path);
      return;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    this.createDirectory(dirname(path));
    this.persist();
    this.io.directory(path);
    const stat = lstatSync(path, { bigint: true });
    this.record.directories.push({ path, device: String(stat.dev), inode: String(stat.ino) });
    this.refreshMoved(path);
    this.persist();
  }
  createExclusiveDirectory(path: string): { device: string; inode: string; uid: number } {
    this.assertMoved(path);
    this.createDirectory(dirname(path));
    this.allow(path);
    this.persist();
    const created = this.io.directoryExclusive(path);
    this.record.directories.push({ path, device: created.device, inode: created.inode });
    this.refreshMoved(path);
    this.persist();
    return created;
  }
  private remapGuards(from: string, to: string): void {
    for (const guard of this.record.guards ?? []) {
      if (guard.path === from || guard.path.startsWith(from + '/')) {
        guard.path = to + guard.path.slice(from.length);
      }
    }
  }
  createStaging(path: string): void {
    this.checkScope(path);
    this.io.guard.parents(path);
    try {
      lstatSync(path);
      throw new Problem('stage-exists', 'Staging creation requires an absent destination.');
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    const tree: StagingTree = { path, state: 'planned', manifest: [] };
    this.record.trees.push(tree);
    this.persist();
    this.io.directoryExclusive(path);
    tree.manifest = treeManifest(path, this.io);
    tree.state = 'created';
    this.persist();
  }
  sealStaging(path: string): void {
    this.checkScope(path);
    const owned = this.record.trees.find(tree => tree.path === path);
    if (!owned || owned.state === 'planned' || owned.state === 'installed') {
      throw new Problem('stage-ownership', 'Only an operation-created staging root can be sealed.');
    }
    const now = treeManifest(path, this.io);
    const prior = owned.manifest[0];
    const root = now[0];
    if (!prior || !root || prior.device !== root.device || prior.inode !== root.inode) {
      throw new Problem('stage-ownership', 'The staging root identity changed.');
    }
    owned.manifest = now;
    owned.state = 'sealed';
    this.persist();
  }
  moveTree(from: string, to: string, discard = false, approval?: ApprovedTree): void {
    this.checkScope(from);
    this.checkScope(to);
    const parents = [...this.io.guard.parents(from), ...this.io.guard.parents(to)];
    if (approval) {
      assertApprovedTree(from, approval, this.io);
    }
    const before = treeManifest(from, this.io);
    const enclosing = this.record.trees.filter(tree => from.startsWith(tree.path + '/'));
    for (const tree of enclosing) {
      if (JSON.stringify(treeManifest(tree.path, this.io)) !== JSON.stringify(tree.manifest)) {
        throw new Problem('stage-conflict', 'The enclosing staging tree changed before installation.');
      }
    }
    const ownedStage = this.record.trees.find(tree => tree.path === from);
    if (ownedStage && (ownedStage.state !== 'sealed'
      || JSON.stringify(ownedStage.manifest) !== JSON.stringify(before))) {
      throw new Problem('stage-conflict', 'The sealed staging tree changed before installation.');
    }
    if (!approval && !ownedStage && !enclosing.length) {
      throw new Problem('move-approval', 'A tree move requires prior ownership approval.');
    }
    try {
      lstatSync(to);
      throw new Problem('move-collision', 'A tree move destination already exists.');
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    if (lstatSync(from, { bigint: true }).dev !== lstatSync(dirname(to), { bigint: true }).dev) {
      throw new Problem('move-volume', 'Profile data cannot move across volumes.');
    }
    const move: TreeMove = { from, to, expected: before, installed: false, uncertain: true, discard };
    this.record.moves.push(move);
    let destination: { device: string; inode: string; uid: number };
    try {
      for (const file of this.record.files) {
        if (file.path.startsWith(from + '/')) {
          this.allow(to + file.path.slice(from.length));
        }
      }
      this.persist();
      destination = this.createExclusiveDirectory(to);
      this.io.guard.recheck(parents);
      if (JSON.stringify(treeManifest(from, this.io)) !== JSON.stringify(before)) {
        throw new Problem('move-conflict', 'The source tree changed before its move.');
      }
      if (approval) {
        assertApprovedTree(from, approval, this.io);
      }
      const leaf = lstatSync(to, { bigint: true });
      if (!leaf.isDirectory() || String(leaf.dev) !== destination.device || String(leaf.ino) !== destination.inode
        || Number(leaf.uid) !== destination.uid || readdirSync(to).length) {
        throw new Problem('move-destination', 'The exclusive destination changed before publication.');
      }
    } catch (error) {
      // Every failure in this block precedes the rename syscall.
      move.uncertain = false;
      this.persist();
      throw error;
    }
    renameSync(from, to);
    this.io.flushDirectory(dirname(from));
    this.io.flushDirectory(dirname(to));
    move.installed = true;
    this.record.directories = this.record.directories.filter(value => value.path !== to
      || value.device !== destination.device || value.inode !== destination.inode);
    this.remapGuards(from, to);
    for (const file of this.record.files) {
      if (file.path.startsWith(from + '/')) {
        file.path = to + file.path.slice(from.length);
      }
    }
    move.expected = treeManifest(to, this.io);
    move.uncertain = false;
    for (const tree of enclosing) {
      tree.manifest = treeManifest(tree.path, this.io);
    }
    const stage = this.record.trees.find(tree => tree.path === from);
    if (stage) {
      stage.state = 'installed';
    }
    this.persist();
  }
  unlinkLink(path: string, expected: {
    device: string;
    inode: string;
    uid: number
  }): void {
    const parents = this.io.guard.parents(path);
    const before = lstatSync(path, { bigint: true });
    if (!before.isSymbolicLink() || String(before.dev) !== expected.device || String(before.ino) !== expected.inode
      || Number(before.uid) !== expected.uid || expected.uid !== this.io.guard.uid) {
      throw new Problem('link-changed', 'The confirmed link is foreign-owned or changed.');
    }
    const link = { path, ...expected, digest: digest(readlinkSync(path)), removed: false };
    this.record.links.push(link);
    this.persist();
    this.io.guard.recheck(parents);
    const current = lstatSync(path, { bigint: true });
    if (!current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
      || current.uid !== before.uid || digest(readlinkSync(path)) !== link.digest) {
      throw new Problem('link-changed', 'The confirmed link changed immediately before unlinking.');
    }
    unlinkSync(path);
    this.io.flushDirectory(dirname(path));
    link.removed = true;
    this.persist();
  }
  private validateStored(file: FileChange): Buffer | null {
    this.checkRoot();
    this.checkScope(file.path);
    if (!file.stored) {
      if (file.before !== null) {
        throw new Problem('recovery-bytes', 'Recovery bytes are missing.', Exit.recovery);
      }
      return null;
    }
    if (!/^prior-[0-9a-f-]+$/.test(file.stored)) {
      throw new Problem('recovery-scope', 'Invalid pre-image location.', Exit.recovery);
    }
    const bytes = this.io.read(join(this.directory, file.stored))?.bytes;
    if (!bytes || digest(bytes) !== file.storedDigest || file.storedDigest !== file.before?.digest) {
      throw new Problem('recovery-bytes', 'Stored recovery bytes failed verification.',
        Exit.recovery);
    }
    return bytes;
  }
  rollback(): number {
    let pending = this.record.links.length > 0;
    const changed = new Set<TreeMove>();
    for (const move of this.record.moves) {
      try {
        if (move.uncertain || (move.installed
          && JSON.stringify(treeManifest(move.to, this.io)) !== JSON.stringify(move.expected))) {
          changed.add(move);
        }
      } catch {
        changed.add(move);
      }
    }
    for (const file of [...this.record.files].reverse()) {
      try {
        if (file.uncertain) {
          pending = true;
          continue;
        }
        if (!file.produced) {
          continue;
        }
        this.checkGuards(file.path);
        const bytes = this.validateStored(file);
        if (!sameImage(this.io.snapshot(file.path), file.expected)) {
          pending = true;
          continue;
        }
        if (bytes) {
          this.io.write(file.path, bytes, file.expected, file.before!.mode);
        } else if (file.expected) {
          this.io.remove(file.path, file.expected);
        }
        file.produced = false;
        this.refreshMoved(file.path, changed);
        this.persist();
      } catch {
        pending = true;
      }
    }
    for (const move of [...this.record.moves].reverse()) {
      try {
        if (changed.has(move) || move.uncertain) {
          pending = true;
          if (move.installed) {
            this.inventory(this.notice(move.to), true);
          }
          continue;
        }
        if (!move.installed) {
          continue;
        }
        this.io.guard.parents(move.from);
        this.io.guard.parents(move.to);
        if (JSON.stringify(treeManifest(move.to, this.io)) !== JSON.stringify(move.expected)) {
          throw new Problem('move-conflict', 'Rollback preserves the changed moved tree.');
        }
        try {
          lstatSync(move.from);
          throw new Problem('move-collision', 'Rollback destination is occupied.');
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
        }
        const enclosing = this.record.trees.filter(tree => move.from.startsWith(tree.path + '/'));
        for (const tree of enclosing) {
          if (JSON.stringify(treeManifest(tree.path, this.io)) !== JSON.stringify(tree.manifest)) {
            throw new Problem('stage-conflict', 'Rollback staging was changed.');
          }
        }
        const reservation = this.io.directoryExclusive(move.from);
        if (JSON.stringify(treeManifest(move.to, this.io)) !== JSON.stringify(move.expected)) {
          throw new Problem('move-conflict', 'The restoration source changed after reserving its destination.');
        }
        const leaf = lstatSync(move.from, { bigint: true });
        if (String(leaf.dev) !== reservation.device || String(leaf.ino) !== reservation.inode
          || Number(leaf.uid) !== reservation.uid || readdirSync(move.from).length) {
          throw new Problem('move-destination', 'The exclusive restoration destination changed.');
        }
        renameSync(move.to, move.from);
        this.remapGuards(move.to, move.from);
        for (const tree of enclosing) {
          tree.manifest = treeManifest(tree.path, this.io);
        }
        move.installed = false;
        const stage = this.record.trees.find(tree => tree.path === move.from);
        if (stage) {
          stage.state = 'sealed';
          stage.manifest = treeManifest(move.from, this.io);
        }
        this.persist();
      } catch {
        pending = true;
        this.inventory(this.notice(move.to), true);
      }
    }
    if (!pending) {
      for (const directory of [...this.record.directories].reverse()) {
        try {
          this.io.guard.chain(directory.path);
          const stat = lstatSync(directory.path, { bigint: true });
          if (String(stat.dev) !== directory.device || String(stat.ino) !== directory.inode) {
            throw new Problem('directory-conflict', 'An operation-created directory was substituted.');
          }
          rmdirSync(directory.path);
        } catch (error) {
          if (!isMissing(error)) {
            pending = true;
            this.inventory(this.notice(directory.path), true);
          }
        }
      }
    }
    if (pending) {
      this.record.phase = 'conflicted';
      this.persist();
      return Exit.recovery;
    }
    return this.finish();
  }
  finish(): number {
    if (this.record.files.some(file => file.uncertain)
      || this.record.trees.some(tree => tree.state === 'planned')
      || this.record.moves.some(move => move.uncertain)) {
      return Exit.recovery;
    }
    try {
      this.checkRoot();
      const partial = this.record.phase === 'complete';
      for (const file of this.record.files) {
        const current = file.produced ? this.io.snapshot(file.path) : null;
        const disposed = partial && !current && this.record.moves.some(move => move.discard
          && (file.path === move.to || file.path.startsWith(move.to + '/')));
        if (file.produced && !disposed && !sameImage(current, file.expected)) {
          throw new Problem('operation-conflict', 'An operation result changed before completion.');
        }
      }
      for (const file of this.record.files) {
        if (file.stored && !(partial && !this.io.read(join(this.directory, file.stored)))) {
          this.validateStored(file);
        }
      }
      for (const move of this.record.moves) {
        if (move.installed && !(partial && move.discard)
          && JSON.stringify(treeManifest(move.to, this.io)) !== JSON.stringify(move.expected)) {
          throw new Problem('move-conflict', 'The installed tree changed before operation completion.');
        }
      }
      this.record.phase = 'complete';
      this.persist();
      for (const tree of this.record.trees) {
        if (tree.state !== 'installed') {
          cleanSealedTree(tree.path, tree.manifest, this.io, partial);
        }
      }
      for (const move of this.record.moves) {
        if (move.installed && move.discard) {
          cleanSealedTree(move.to, move.expected, this.io, partial);
        }
      }
      this.record.trees = [];
      this.record.phase = 'complete';
      this.persist();
      const expectedNames = new Set(['operation.json', ...this.record.files.flatMap(file => file.stored ?? [])]);
      if (readdirSync(this.directory).some(name => !expectedNames.has(name))) {
        throw new Problem('cleanup-foreign', 'Unexpected recovery material remains.');
      }
      for (const file of this.record.files) {
        if (file.stored) {
          if (partial && !this.io.read(join(this.directory, file.stored))) {
            continue;
          }
          this.validateStored(file);
          const path = join(this.directory, file.stored);
          this.io.remove(path, this.io.snapshot(path)!);
        }
      }
      this.io.remove(join(this.directory, 'operation.json'), this.recordImage!);
      this.checkRoot();
      rmdirSync(this.directory);
      this.io.flushDirectory(dirname(this.directory));
      this.inventory(this.notice(), false);
      return Exit.ok;
    } catch {
      try {
        this.inventory(this.notice(), true);
      } catch {
        return Exit.recovery;
      }
      return Exit.recovery;
    }
  }
}
