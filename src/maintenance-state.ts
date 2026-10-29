import { join, isAbsolute } from 'node:path';
import { PrivateIO } from './private-io.js';
import type { Catalog } from './profile-catalog.js';
import { uuid } from './profile-catalog.js';
import { resourceRevision } from './release.js';
export interface MaintenanceState {
  format: 'bcm-maintenance/1';
  installationKey: string;
  revision: string;
  cli: string;
  reason: 'created' | 'audited';
  operationId: string;
}
export function maintenanceBytes(catalog: Catalog, cli: string, operationId: string, audited: boolean): string {
  const state: MaintenanceState = {
    format: 'bcm-maintenance/1', installationKey: catalog.installationKey, revision: resourceRevision, cli,
    reason: audited ? 'audited' : 'created', operationId,
  };
  return JSON.stringify(state, null, 2) + '\n';
}
export function maintenanceFinding(catalog: Catalog, control: string, cli: string, io: PrivateIO): string | null {
  if (!catalog.profiles.length) {
    return null;
  }
  try {
    const file = io.read(join(control, 'maintenance.json'));
    if (file) {
      const state = JSON.parse(file.bytes.toString('utf8')) as MaintenanceState;
      const pending = catalog.recoveryClaims.some(claim => claim.operationId === state.operationId);
      if (state.format === 'bcm-maintenance/1' && state.installationKey === catalog.installationKey
        && state.revision === resourceRevision && isAbsolute(state.cli) && state.cli === cli
        && uuid(state.operationId) && ['created', 'audited'].includes(state.reason)
        && !(state.reason === 'audited' && pending)) {
        return null;
      }
    }
  } catch {
    return 'Maintenance state is unsafe or unreadable; review with doctor before applying repairs.';
  }
  return 'Generated resources need review for this installation. Run ben-claude-multi doctor --apply.';
}
