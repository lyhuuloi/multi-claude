import { join } from 'node:path';
import { lifecycleFixture } from './lifecycle-support.js';

const [home, action, checkpoint] = process.argv.slice(2);
if (!home || !action || !checkpoint) {
  throw new Error('A crash fixture requires a temporary home, action and checkpoint.');
}
const f = lifecycleFixture();
Object.assign(f.env, {
  HOME: home, CFFIXED_USER_HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
});
f.services.checkpoint = stage => {
  if (stage === checkpoint) {
    process.exit(89);
  }
};
const result = action === 'rename'
  ? await f.invoke(['rename', 'studio', 'work'], ['y'])
  : await f.invoke(['remove', 'studio'], ['y', 'y', 'y']);
process.stderr.write(result.text);
process.exit(result.code || 1);
