import type { Profile } from './profile-catalog.js';
import type { ChangeRecord } from './change-records.js';
export interface CodePlan {
  profile: Profile;
  reused: string[];
  preflight(): void;
  build(transaction: ChangeRecord): Promise<Profile>;
}
export interface DesktopPlan {
  profile: Profile;
  reused: string[];
  preflight(): Promise<void>;
  build(transaction: ChangeRecord, completed: Profile): Promise<Profile>;
}
