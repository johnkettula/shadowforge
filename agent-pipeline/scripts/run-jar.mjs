// Starts the newest Spring Boot jar in a folder, passing on any extra arguments:
//   node run-jar.mjs <folder> [--server.port=19000 ...]
// Used by the staging and live deploys, so the same command works on Windows and Linux
// (cmd.exe doesn't expand target/vm-intent-*.jar).
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [dir, ...rest] = process.argv.slice(2);
const jars = readdirSync(dir)
  .filter((f) => f.endsWith('.jar') && !f.endsWith('-plain.jar') && !f.endsWith('.original'))
  .map((f) => path.join(dir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
if (!jars.length) {
  console.error(`no jar in ${dir}`);
  process.exit(1);
}
console.log(`starting ${jars[0]}`);
const child = spawn('java', ['-jar', jars[0], ...rest], { stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 1));
