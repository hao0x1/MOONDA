// Share one headless Chrome across the team's GPU checks. Take the lease just before launch,
// check it once Chrome starts, and release it only after browser.close() in a finally block.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BROWSER_LEASE_PATH = '/private/tmp/moonda-headless-browser.lock';
const CHROME_MAIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const readOwner = () => { try { return JSON.parse(readFileSync(join(BROWSER_LEASE_PATH, 'owner.json'), 'utf8')); } catch { return null; } };
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Only actual Chrome main commands count: a shell command or agent prompt mentioning Chrome does not. */
export function headlessChromeMains() {
  return execFileSync('/bin/ps', ['-axo', 'pid,ppid,command'], { encoding: 'utf8', maxBuffer: 8 << 20 }).split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const command = match[3];
    if (!(command === CHROME_MAIN || command.startsWith(`${CHROME_MAIN} `)) || !/--headless(?:=|\s|$)/.test(command)) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]) }];
  });
}

/**
 * Wait outside the browser for at most 90 s. A dead Node owner can leave a lock after an OOM;
 * reclaim that directory, but keep waiting if its Chrome is still alive. No browser is killed here.
 */
export async function acquireBrowserLease({ script = basename(process.argv[1] ?? 'browser check'), noteDir, timeoutMs = 90000 } = {}) {
  const token = randomUUID(), started = Date.now(), notes = [];
  let held = false, lastNotice = 0;
  const note = (event, extra = {}) => {
    notes.push({ at: new Date().toISOString(), event, ...extra });
    if (noteDir) {
      mkdirSync(noteDir, { recursive: true });
      writeFileSync(join(noteDir, 'browser-lease.json'), JSON.stringify({ lockPath: BROWSER_LEASE_PATH, pid: process.pid, script, notes }, null, 2));
    }
  };
  const release = () => {
    if (!held) return;
    const owner = readOwner();
    if (owner?.token === token && owner.pid === process.pid) rmSync(BROWSER_LEASE_PATH, { recursive: true });
    held = false; note('released');
  };
  const reclaimDeadOwner = () => {
    const owner = readOwner();
    if (!owner || alive(owner.pid)) return false;
    // A small lock inside the old lock prevents two waiters from moving each other's new lease.
    const reap = join(BROWSER_LEASE_PATH, 'reaping');
    try { mkdirSync(reap); } catch { return false; }
    let moved = false;
    try {
      const current = readOwner();
      if (!current || current.token !== owner.token || current.pid !== owner.pid || alive(current.pid)) return false;
      const stale = `${BROWSER_LEASE_PATH}.stale.${token}`;
      renameSync(BROWSER_LEASE_PATH, stale); moved = true;
      rmSync(stale, { recursive: true }); note('reclaimed dead Node owner', { previousPid: owner.pid, previousScript: owner.script });
      return true;
    } finally {
      if (!moved) { try { rmSync(reap, { recursive: true }); } catch { /* the owner may have released it */ } }
    }
  };
  const waitForTurn = async reason => {
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for the single headless browser lease: ${reason}`);
    if (!lastNotice || Date.now() - lastNotice >= 15000) {
      lastNotice = Date.now(); console.error(`[browser lease] Waiting outside Chrome: ${reason}`); note('waiting', { reason });
    }
    await sleep(Math.min(1000, Math.max(1, timeoutMs - (Date.now() - started))));
  };
  note('requested');
  while (!held) {
    reclaimDeadOwner();
    const running = headlessChromeMains();
    if (running.length) { await waitForTurn(`headless Chrome PID ${running.map(p => p.pid).join(', ')}`); continue; }
    try { mkdirSync(BROWSER_LEASE_PATH); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readOwner();
      await waitForTurn(owner ? `${owner.script ?? 'another check'} owns the lock (Node PID ${owner.pid})` : 'another check is acquiring the lock');
      continue;
    }
    held = true;
    try {
      writeFileSync(join(BROWSER_LEASE_PATH, 'owner.json'), JSON.stringify({ pid: process.pid, token, script, acquiredAt: new Date().toISOString(), noteDir }, null, 2));
      const raced = headlessChromeMains();
      if (raced.length) { release(); await waitForTurn(`headless Chrome PID ${raced.map(p => p.pid).join(', ')} started before launch`); continue; }
    } catch (error) { release(); throw error; }
  }
  note('acquired');
  const afterLaunch = async browser => {
    const ownPid = browser.process()?.pid;
    const running = headlessChromeMains();
    if (running.length > 1 || running.some(p => p.pid !== ownPid)) {
      try { await browser.close(); } finally { release(); }
      note('closed own browser after launch race', { ownPid, running });
      throw new Error(`Another headless browser raced this launch (PIDs ${running.map(p => p.pid).join(', ')}). This check closed its own Chrome; retry when the other run finishes.`);
    }
    note('Chrome started alone', { chromePid: ownPid });
  };
  return { path: BROWSER_LEASE_PATH, release, afterLaunch };
}
