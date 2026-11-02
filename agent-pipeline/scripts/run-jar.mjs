// Starts the newest Spring Boot jar in a folder, passing on any extra arguments:
//   node run-jar.mjs <folder> [--server.port=19000 ...]
// Used by the staging and live deploys, so the same command works on Windows and Linux
// (cmd.exe doesn't expand target/vm-intent-*.jar).
//
// It runs a COPY of the jar, kept in the deploy's own folder (RUN_JAR_DIR, or next to
// VMINTENT_FILES_DIR). Windows locks a jar while Java runs it, and a locked target/*.jar made the
// next "mvn package" fail ("Unable to rename ... .jar.original"). With a copy, the build can always
// replace the original.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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

let jar = jars[0];
const runDir =
  process.env.RUN_JAR_DIR ?? (process.env.VMINTENT_FILES_DIR ? path.join(path.dirname(process.env.VMINTENT_FILES_DIR), 'run') : undefined);
if (runDir) {
  mkdirSync(runDir, { recursive: true });
  // Old copies from earlier runs; one still in use is locked and simply stays.
  for (const f of readdirSync(runDir).filter((n) => n.endsWith('.jar'))) {
    try {
      rmSync(path.join(runDir, f), { force: true });
    } catch {
      /* in use */
    }
  }
  const copy = path.join(runDir, `app-${Date.now()}.jar`);
  copyFileSync(jar, copy);
  jar = copy;
}

console.log(`starting ${jar}${jar === jars[0] ? '' : ` (a copy of ${jars[0]})`}`);
const child = spawn('java', ['-jar', jar, ...rest], { stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => process.exit(code ?? 1));
