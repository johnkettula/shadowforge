// Leftover embedded Postgres: started on its own by the backend, so it outlives the backend's
// process tree and keeps the staging folders open. Linux stand-in: a "postgres" that is really sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killListeners, killPostgresIn, processesUsing, processNamed, removeDir, stopProcessesUsing } from '../src/exec.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a leftover Postgres in a staging folder is stopped, and nothing else is', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ap-pg-'));
  const bin = path.join(dir, 'postgres');
  symlinkSync('/bin/sleep', bin);
  const pg = spawn(bin, ['300'], { detached: true, stdio: 'ignore' });
  const other = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  pg.unref();
  other.unref();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(processNamed(pg.pid!, 'postgres'));

  const pgdata = path.join(dir, 'staging', 'cycle-0003', 'pgdata');
  mkdirSync(pgdata, { recursive: true });
  writeFileSync(path.join(pgdata, 'postmaster.pid'), `${pg.pid}\n${pgdata}\n`);
  // A stale pid file pointing at something that isn't Postgres must not kill it.
  const stale = path.join(dir, 'staging', 'cycle-0004', 'pgdata');
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, 'postmaster.pid'), `${other.pid}\n`);

  assert.deepEqual(killPostgresIn(path.join(dir, 'staging')), [pg.pid]);
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(alive(pg.pid!), false, 'postgres stopped');
  assert.equal(alive(other.pid!), true, 'the other process was left alone');
  process.kill(other.pid!, 'SIGKILL');

  assert.equal(removeDir(path.join(dir, 'staging')), true);
  assert.equal(existsSync(path.join(dir, 'staging')), false);
});

test('killListeners stops what listens on the given ports, and nothing else', { skip: process.platform === 'win32' }, async () => {
  const listen = (port: number) =>
    spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>r.end('x')).listen(${port}, '127.0.0.1')`], { detached: true, stdio: 'ignore' });
  const port = 23000 + Math.floor(Math.random() * 2000);
  const target = listen(port);
  const bystander = listen(port + 1);
  target.unref();
  bystander.unref();
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(killListeners([port]), [target.pid]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(target.pid!), false, 'the listener on the port was stopped');
  assert.equal(alive(bystander.pid!), true, 'a process on another port was left alone');
  assert.deepEqual(killListeners([port]), [], 'nothing left to stop');
  process.kill(bystander.pid!, 'SIGKILL');
});

test('processes using a deploy folder are found and stopped, and a folder with a longer name is not', { skip: process.platform === 'win32' }, async () => {
  // Stand-ins for a backend running a jar copied into the folder, and one in a sibling whose name
  // starts the same way (state/live vs state/live2).
  const base = mkdtempSync(path.join(os.tmpdir(), 'ap-using-'));
  const dir = path.join(base, 'live');
  const sibling = path.join(base, 'live2');
  mkdirSync(path.join(dir, 'run'), { recursive: true });
  mkdirSync(path.join(sibling, 'run'), { recursive: true });
  const start = (jar: string) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', path.join(jar, 'run', 'app.jar')], { detached: true, stdio: 'ignore' });
  const backend = start(dir);
  const bystander = start(sibling);
  backend.unref();
  bystander.unref();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(processesUsing(dir), [backend.pid]);
  assert.deepEqual(await stopProcessesUsing(dir, 10_000), [], 'nothing left after waiting');
  assert.equal(alive(backend.pid!), false, 'the process using the folder was stopped');
  assert.equal(alive(bystander.pid!), true, 'the one using the other folder was left alone');
  process.kill(bystander.pid!, 'SIGKILL');
});

test('stopping waits until the processes are gone, and gives up after its time limit', async () => {
  // A process that takes three looks to go away: the stop must wait for it, not start early.
  let looks = 0;
  const slow = () => (++looks <= 3 ? [999_999_901] : []);
  assert.deepEqual(await stopProcessesUsing('/x/state/live', 20_000, slow), []);
  assert.equal(looks, 4, 'it looked until nothing was left');
  // One that never goes away: reported back once the time limit is up.
  const stuck = () => [999_999_902];
  const t0 = Date.now();
  assert.deepEqual(await stopProcessesUsing('/x/state/live', 3_000, stuck), [999_999_902]);
  assert.ok(Date.now() - t0 < 8_000, 'it gave up after about its time limit');
});

test('processesUsing never matches something as broad as a root folder', () => {
  assert.deepEqual(processesUsing('/'), []);
});
