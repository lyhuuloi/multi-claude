import { join } from 'node:path';
import { lifecycleFixture } from './lifecycle-support.js';

const [home, action, checkpoint, ...dead] = process.argv.slice(2);
if (!home || !action || !checkpoint) {
  throw new Error('A crash fixture requires a temporary home, action and checkpoint.');
}
const f = lifecycleFixture();
const inspect = f.services.identities.inspect;
f.services.identities.inspect = async pid => dead.includes(String(pid)) ? { state: 'dead' } : inspect(pid);
Object.assign(f.env, {
  HOME: home, CFFIXED_USER_HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
});
f.services.checkpoint = stage => {
  if (stage === checkpoint) {
    process.exit(89);
  }
};
f.desktop.checkpoint = f.services.checkpoint;
const result = action === 'open'
  ? await f.invoke(['open-profile', 'studio'], null)
  : action === 'rename'
  ? await f.invoke(['rename', 'studio', 'work'], ['y'])
  : await f.invoke(['remove', 'studio'], ['y', 'y', 'y']);
process.stderr.write(result.text);
process.exit(result.code || 1);
