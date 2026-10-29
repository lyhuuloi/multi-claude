import { requireIsolation } from './isolation.js';
import { LeaseManager } from '../src/operation-leases.js';
import { PrivateIO } from '../src/private-io.js';
requireIsolation();
const manager = new LeaseManager(process.argv[2]!, new PrivateIO(), {
  self: async () => ({ boot: 'fixture-boot', start: 'fixture-start' }),
  inspect: async () => ({ state: 'alive', boot: 'fixture-boot', start: 'fixture-start' }),
});
try {
  if (process.argv[3] === 'cycle') {
    process.stdout.write('cycling\n');
    for (let i = 0; i < 4; i++) {
      const lease = await manager.acquire('registry');
      await new Promise(resolve => setTimeout(resolve, 25));
      lease.release();
    }
  } else {
    const lease = await manager.acquire('registry');
    process.stdout.write('held\n');
    setTimeout(() => {
      lease.release();
    }, 3000);
  }
}
catch {
  process.stdout.write('blocked\n');
  process.exitCode = 73;
}
