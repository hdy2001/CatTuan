// Start a local service independently of the terminal used for restart.sh.
// A separate process group keeps it alive after an agent command session closes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [cwd, log, command, ...args] = process.argv.slice(2);
if (!cwd || !log || !command) throw new Error('Usage: launch-service.mjs <cwd> <log> <command> [args...]');
const output = fs.openSync(log, 'a');
try {
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', output, output], env: process.env });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('spawn', () => child.unref());
} finally {
  fs.closeSync(output);
}
