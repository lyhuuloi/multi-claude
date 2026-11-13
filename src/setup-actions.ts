import { randomUUID } from 'node:crypto';
import { PrivateIO } from './private-io.js';
import { ProfileActions } from './profile-actions.js';
import type { ProfileLocations } from './profile-actions.js';
import { DesktopActions } from './desktop-actions.js';
import type { CodeServices } from './code-services.js';
import type { DesktopServices } from './desktop-services.js';
import type { CodePlan, DesktopPlan } from './surface-plans.js';
import type { ChangeRecord } from './change-records.js';
import type { Profile } from './profile-catalog.js';
import { validLabel } from './profile-catalog.js';
import { Dialogue } from './terminal-dialogue.js';
import { githubGuidance } from './github-configuration.js';
import { policyView } from './desktop-policy.js';
import { maintenanceBytes } from './maintenance-state.js';
import { join, basename } from 'node:path';
import { Problem, Exit } from './outcomes.js';
import { placeShortcut } from './app-shortcut.js';
export class SetupActions {
  private readonly actions: ProfileActions;
  constructor(
    private readonly where: ProfileLocations, private readonly io: PrivateIO,
    private readonly code: CodeServices, private readonly desktop: DesktopServices,
    private readonly dialogue: Dialogue, private readonly out: (message: string) => void,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.actions = new ProfileActions(where, io, code, dialogue, out, env);
  }
  async add(label: string | undefined, target: string | undefined): Promise<number> {
    return this.actions.locked(async (session, leases) => {
      const name = label ?? (await this.dialogue.line('Profile label:'))?.trim();
      if (!name) {
        return Exit.ok;
      }
      if (!validLabel(name)) {
        throw new Problem('profile-label', 'Choose a valid lowercase profile label.', Exit.usage);
      }
      if (!target) {
        this.out('1. Paired\n2. Terminal\n3. Desktop');
        const choice = await this.dialogue.line('Target number: [1]');
        if (choice === null) {
          return Exit.ok;
        }
        target = ({ '1': 'paired', '2': 'terminal', '3': 'desktop' } as Record<string, string>)[choice.trim() || '1'];
      }
      if (!target) {
        throw new Problem('target-choice', 'Choose one of the listed targets.', Exit.usage);
      }
      const existing = session.catalog.profiles.find(profile => profile.label === name) ?? null;
      const id = existing?.id ?? randomUUID();
      await leases.profile(id);
      let codePlan: CodePlan | null = null;
      let desktopPlan: DesktopPlan | null = null;
      let incomplete = false;
      const planningFailure = (surface: string, error: unknown) => {
        if (error instanceof Problem && error.status === Exit.interrupted) {
          throw error;
        }
        if (error instanceof Problem && error.status === Exit.ok) {
          return;
        }
        if (target !== 'paired') {
          throw error;
        }
        incomplete = true;
        this.out(`${surface} preparation failed; other selected work can continue.`);
      };
      if (target !== 'desktop') {
        try {
          codePlan = await this.actions.prepareCode(session, name, id);
        } catch (error) {
          planningFailure('Code', error);
        }
      }
      if (target !== 'terminal') {
        try {
          desktopPlan = await new DesktopActions(this.where, this.io, this.desktop, this.code,
            this.dialogue, this.out, this.env).prepare(session, name, id);
        } catch (error) {
          planningFailure('Desktop', error);
        }
      }
      if (!codePlan && !desktopPlan) {
        this.out('No additional surface or GitHub work was selected. Existing resources are unchanged.');
        const partial = target === 'paired' && existing && (!existing.code || !existing.desktop);
        if (partial) {
          this.out(`Resume missing work with add ${name} --target ${existing.code ? 'desktop' : 'terminal'}.`);
        }
        return incomplete || partial ? Exit.findings : Exit.ok;
      }
      const draft = structuredClone(existing ?? codePlan?.profile ?? desktopPlan!.profile);
      if (codePlan) {
        draft.code = structuredClone(codePlan.profile.code);
      }
      if (desktopPlan) {
        draft.desktop = structuredClone(desktopPlan.profile.desktop);
      }
      const proposed = structuredClone(session.catalog);
      proposed.profiles = proposed.profiles.filter(profile => profile.id !== id).concat(draft);
      this.actions.assertPlan(session, proposed);
      this.out(`Code: ${codePlan ? 'prepare' : existing?.code ? 'already complete' : 'skipped'}; `
        + `Desktop: ${desktopPlan ? 'prepare' : existing?.desktop ? 'already complete' : 'skipped'}.`);
      if (!await this.dialogue.confirm('Apply this profile plan?')) {
        return Exit.ok;
      }
      codePlan?.preflight();
      await desktopPlan?.preflight();
      this.actions.assertPlan(session, proposed);
      let completed: Profile = existing ? structuredClone(existing) : {
        id, label: name, bornAt: draft.bornAt, changedAt: draft.changedAt, credentialPolicy: 'subscription',
        code: null, desktop: null, rootEvidence: [],
      };
      const successful: ChangeRecord[] = [];
      const pending: { transaction: ChangeRecord; surface: 'Code' | 'Desktop' }[] = [];
      let recovery = false;
      let failureStatus: number = Exit.ok;
      for (const surface of ['Code', 'Desktop'] as const) {
        const plan = surface === 'Code' ? codePlan : desktopPlan;
        if (!plan) {
          continue;
        }
        const transaction = this.actions.begin(session, id);
        transaction.bind(existing, draft);
        try {
          const result = surface === 'Code'
          ? await codePlan!.build(transaction)
          : await desktopPlan!.build(transaction, completed);
          completed = result;
          successful.push(transaction);
          this.out(`${surface} preparation completed.`);
        } catch (error) {
          failureStatus = await this.actions.failure(error, transaction, session, false);
          recovery ||= failureStatus === Exit.recovery;
          if (failureStatus === Exit.recovery) {
            pending.push({ transaction, surface });
          }
          incomplete = true;
          if (error instanceof Problem && error.status === Exit.interrupted) {
            for (const prior of [...successful].reverse()) {
              const result = await this.actions.failure(error, prior, session, false);
              recovery ||= result === Exit.recovery;
            }
            return recovery ? Exit.recovery : Exit.interrupted;
          }
          const retryTarget = surface === 'Code' ? 'terminal' : 'desktop';
          this.out(`${surface} failed; resume with add ${name} --target ${retryTarget}.`);
        }
      }
      if (!successful.length) {
        return recovery ? Exit.recovery : failureStatus;
      }
      const final = successful[0]!;
      let committed = false;
      try {
        completed.changedAt = new Date().toISOString();
        for (const transaction of successful) {
          transaction.bind(existing, completed);
        }
        const next = structuredClone(session.catalog);
        const temporary = new Set(successful.map(transaction => transaction.directory));
        next.recoveryClaims = next.recoveryClaims.filter(claim => !temporary.has(claim.location));
        next.profiles = next.profiles.filter(profile => profile.id !== id).concat(completed);
        const reused = [...(completed.code && codePlan ? codePlan.reused : []),
          ...(completed.desktop && desktopPlan ? desktopPlan.reused : [])];
        next.releasedLocations.forEach(record => {
          if (reused.includes(record.id)) {
            record.reusedBy = id;
          }
        });
        const findings = await this.actions.fences(next, final);
        await this.actions.checkpoint('add-fences');
        if (!session.catalog.profiles.length) {
          const maintenance = join(this.where.control, 'maintenance.json');
          final.allow(maintenance);
          final.write(maintenance, maintenanceBytes(next, this.code.cli, basename(final.directory), false));
        }
        session.commit(next);
        committed = true;
        for (const failed of pending) {
          const attempted = structuredClone(completed);
          if (failed.surface === 'Code') {
            attempted.code = structuredClone(codePlan!.profile.code);
          } else {
            attempted.desktop = structuredClone(desktopPlan!.profile.desktop);
          }
          failed.transaction.bind(completed, attempted);
          failed.transaction.preserveParents(completed.rootEvidence.map(root => root.location));
        }
        for (const transaction of successful) {
          const cleanup = transaction.finish();
          recovery ||= cleanup !== Exit.ok;
        }
        if (recovery) {
          await this.actions.protectAfterFailure(session);
        }
        if (completed.code) {
          this.out(`Run ${completed.code.command}; reload ${completed.code.rc}. `
            + 'Sign in in this selected Code profile.');
          if (completed.code.github) {
            githubGuidance(completed.code.github).forEach(this.out);
          }
        }
        if (completed.desktop) {
          this.out(`Launcher: ${completed.desktop.launcher}. Pin this launcher, not the running Claude tile.`);
          if (completed.desktop.shortcut) {
            this.out(placeShortcut(completed.desktop.shortcut, completed.desktop.launcher)
              ?? `Shortcut: ${completed.desktop.shortcut}`);
          }
          this.out('Prefer entering the email code directly; browser callbacks can reach a different Claude instance.');
          if (existing?.desktop && codePlan) {
            this.out('Desktop routing now selects the completed Code/GitHub roots. Reopen existing Desktop sessions.');
          }
        }
        const policy = completed.desktop ? policyView(completed, this.io) : null;
        const policyFinding = policy && completed.desktop!.updateMode === 'launcher'
        && (policy.kind !== 'owned' || policy.effective !== 'blocked');
        const missing = target === 'paired' && (!completed.code || !completed.desktop);
        if (missing) {
          this.out(`Resume missing work with add ${name} --target ${completed.code ? 'desktop' : 'terminal'}.`);
        }
        return recovery ? Exit.recovery : incomplete || missing || policyFinding ? Exit.findings : findings;
      } catch (error) {
        let status: number = Exit.ok;
        for (const transaction of [...successful].reverse()) {
          const result = await this.actions.failure(error, transaction, session, committed);
          status = result === Exit.recovery || status === Exit.recovery ? Exit.recovery : result || status;
        }
        return status;
      }
    });
  }
}
