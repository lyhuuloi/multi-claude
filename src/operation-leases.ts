import { randomUUID } from 'node:crypto';
import { linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { PrivateIO, sameImage } from './private-io.js';
import type { FileImage } from './private-io.js';
import { nativeIdentities } from './machine-services.js';
import type { IdentityService } from './machine-services.js';
import { uuid } from './profile-catalog.js';
import { Problem, shellQuote } from './outcomes.js';
export interface LeaseOwner {
  pid: number;
  uid: number;
  boot: string;
  start: string;
  token: string;
  createdAt: string
}
export interface Lease {
  path: string;
  owner: LeaseOwner;
  image: FileImage;
  release(): void
}
function ownerRecord(bytes: Buffer): LeaseOwner {
  let v: Partial<LeaseOwner>;
  try {
    v = JSON.parse(bytes.toString('utf8')) as Partial<LeaseOwner>;
  } catch {
    throw new Problem('lease-record', 'A lock owner record is unreadable.');
  }
  if (!v || !Number.isSafeInteger(v.pid) || Number(v.pid) <= 0 || !Number.isSafeInteger(v.uid) || Number(v.uid) < 0
    || !v.boot || typeof v.boot !== 'string' || !v.start || typeof v.start !== 'string' || !uuid(v.token) || typeof
    v.createdAt !== 'string'
    || !Number.isFinite(Date.parse(v.createdAt))) {
    throw new Problem('lease-record',
      'A lock owner record is incomplete.');
  }
  return v as LeaseOwner;
}
export class LeaseManager {
  private registryHeld = false;
  constructor(readonly directory: string, readonly io: PrivateIO, private readonly identity: IdentityService =
    nativeIdentities()) {
  }
  private read(path: string): {
    owner: LeaseOwner;
    image: FileImage
  } | null {
    const value = this.io.read(path);
    return value ? {
      owner: ownerRecord(value.bytes),
      image: value.image
    } : null;
  }
  private async stale(owner: LeaseOwner): Promise<boolean> {
    if (owner.uid !== this.io.guard.uid) {
      return false;
    }
    const self = await this.identity.self();
    if (owner.boot !== self.boot) {
      return true;
    }
    const process = await this.identity.inspect(owner.pid);
    return process.state === 'dead' || (process.state === 'alive' && (process.boot !== owner.boot || process.start
      !== owner.start));
  }
  private blocked(path: string): Problem {
    return new Problem('lease-busy',
      `Lock blocked at ${path}. Review its owner before manual recovery: /bin/ls -l ${shellQuote(path)}`);
  }
  private publish(path: string, owner: LeaseOwner): Lease | null {
    const staging = join(this.directory, `.owner-${randomUUID()}`);
    const image = this.io.write(staging, JSON.stringify(owner) + '\n', null);
    let published = false;
    try {
      this.io.guard.parents(path);
      try {
        linkSync(staging, path);
        published = true;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    } finally {
      // The hard-link publication exposes complete, flushed bytes, never an empty file.
      if (published) {
        unlinkSync(staging);
      }
      else this.io.remove(staging, image);
      this.io.flushDirectory(this.directory);
    }
    if (!published) {
      return null;
    }
    const installed = this.read(path);
    if (!installed || installed.owner.token !== owner.token) {
      throw this.blocked(path);
    }
    return {
      path,
      owner,
      image: installed.image,
      release: () => {
        const current = this.read(path);
        if (!current || current.owner.token !== owner.token || !sameImage(current.image,
          installed.image)) {
          throw new Problem('lease-replaced',
            'Lock release refused because its owner or inode changed.');
        }
        this.io.remove(path, current.image);
      }
    };
  }
  private async enter(path: string, owner: LeaseOwner, depth = 0): Promise<Lease> {
    const direct = this.publish(path, owner);
    if (direct) {
      return direct;
    }
    let prior;
    try {
      prior = this.read(path);
    } catch {
      throw this.blocked(path);
    }
    if (!prior) {
      const retry = this.publish(path, owner);
      if (retry) {
        return retry;
      }
      throw this.blocked(path);
    }
    if (!await this.stale(prior.owner) || depth >= 8) {
      throw this.blocked(path);
    }
    const guard = await this.enter(`${path}.reclaim`, { ...owner, token: randomUUID() }, depth + 1);
    try {
      const now = this.read(path);
      if (now && sameImage(now.image, prior.image) && now.owner.token === prior.owner.token && await
        this.stale(now.owner)) {
        this.io.remove(path,
          now.image);
      }
      const claimed = this.publish(path, owner);
      if (claimed) {
        return claimed;
      }
      throw this.blocked(path);
    } finally {
      guard.release();
    }
  }
  async acquire(key: 'registry' | `profile-${string}`, waitMs = 0): Promise<Lease> {
    if (key !== 'registry' && (!key.startsWith('profile-') || !uuid(key.slice(8)))) {
      throw new Problem('lease-key',
        'Invalid profile lock identity.');
    }
    if (key !== 'registry' && !this.registryHeld) {
      throw new Problem('lease-order',
        'Acquire the registry lock before a profile lock.');
    }
    this.io.directory(this.directory);
    const own = await this.identity.self();
    const owner: LeaseOwner = {
      pid: process.pid,
      uid: this.io.guard.uid,
      ...own,
      token: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const path = join(this.directory, `${key}.json`),
    deadline = Date.now() + Math.min(Math.max(waitMs, 0), 20000);
    for (;;) {
      try {
        const lease = await this.enter(path, owner);
        if (key === 'registry') {
          this.registryHeld = true;
          const release = lease.release;
          lease.release = () => {
            try {
              release();
            } finally {
              this.registryHeld = false;
            }
          };
        }
        return lease;
      }
      catch (error) {
        if (!(error instanceof Problem) || error.kind !== 'lease-busy' || Date.now() >= deadline) {
          throw error;
        }
      }
      await pause(Math.min(25, deadline - Date.now()));
    }
  }
  async withRegistry<T>(action: (session: LeaseSession) => Promise<T>): Promise<T> {
    const registry = await this.acquire('registry');
    const session = new LeaseSession(this);
    try {
      return await action(session);
    } finally {
      try {
        session.releaseProfiles();
      } finally {
        registry.release();
      }
    }
  }
}
export class LeaseSession {
  private readonly profiles: Lease[] = [];
  constructor(private readonly manager: LeaseManager) {
  }
  async profile(id: string, waitMs = 0): Promise<void> {
    if (!uuid(id)) {
      throw new Problem('lease-order', 'A profile lock requires a UUID.');
    }
    if (this.profiles.some(p => p.path.endsWith(`profile-${id}.json`))) {
      return;
    }
    const previous = this.profiles.at(-1)?.path;
    if (previous && previous >= join(this.manager.directory, `profile-${id}.json`)) {
      throw new Problem('lease-order',
        'Acquire profile locks in UUID order after the registry lock.');
    }
    this.profiles.push(await this.manager.acquire(`profile-${id}`, waitMs));
  }
  releaseProfiles(): void {
    let failure: unknown;
    for (const lease of this.profiles.reverse()) {
      try {
        lease.release();
      } catch (error) {
        failure ??= error;
      }
    }
    this.profiles.length = 0;
    if (failure) {
      throw failure;
    }
  }
}
