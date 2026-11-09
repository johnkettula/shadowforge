// Read-only: lists the processes using the live deploy's folder (the backend and its embedded
// Postgres), using the same lookup the pipeline uses before it starts a new live deploy.
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { processesUsing } from '../src/exec.js';

const dir = path.join(os.homedir(), 'agent-pipeline-home', 'state', 'live');
const pids = processesUsing(dir);
console.log(`processes using ${dir}: ${pids.length}`);
for (const pid of pids) {
  const ps = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { $_.Name + ' | parent ' + $_.ParentProcessId + ' | started ' + $_.CreationDate.ToString('yyyy-MM-dd HH:mm') + ' | ' + $_.CommandLine }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  console.log(`  ${pid}  ${(r.stdout ?? '').trim() || '(gone)'}`);
}
