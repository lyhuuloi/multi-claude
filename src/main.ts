#!/usr/bin/env node
import { runFront } from './command-front.js';
import { PrivateIO } from './private-io.js';
process.exitCode = await runFront(process.argv.slice(2), {
  env: process.env,
  io: new PrivateIO(),
  input: process.stdin,
  output: process.stdout,
  tty: !!process.stdin.isTTY,
  platform: process.platform
});
