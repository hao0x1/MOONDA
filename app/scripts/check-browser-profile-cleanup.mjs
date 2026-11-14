// Exercise the real harness lifecycle with mocked Chrome, filesystem and signals.
// No browser is launched and no profile or output file is created/deleted.
// node scripts/check-browser-profile-cleanup.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(done => setImmediate(done));
async function until(check) {
  for (let i = 0; i < 30; i++) { if (check()) return; await turn(); }
  throw Error('Mock lifecycle did not reach the expected state');
}

function launchFixture(script, options = {}) {
  const source = readFileSync(join(here, script), 'utf8').replace(/^import .*;\s*$/gm, '');
  const process = new EventEmitter();
  const profile = '/mock/temp-profile';
  process.argv = script === 'drive.mjs'
    ? ['node', script, '[]', '--out', '/mock/out', ...(options.persistent ? ['--profile', '/kept/profile'] : [])]
    : ['node', script, '/mock/out', ...(options.persistent ? ['/kept/profile'] : [])];
  const state = { closes: 0, releases: 0, removals: [], exits: [], warnings: [], launchOptions: null };
  process.exit = code => state.exits.push(code);
  const child = { pid: 12345, exitCode: null, signalCode: null };
  const page = {
    on() {},
    async goto() { if (script !== 'drive.mjs' || options.pageFailure) throw Error('fixture page failure'); },
    async evaluate() { return 'mock GPU'; },
  };
  const browser = {
    async pages() { return [page]; },
    process() { return child; },
    async close() {
      state.closes++;
      if (options.closeFailure) throw Error('fixture close failure');
      if (options.closeGate) await options.closeGate.promise;
      if (!options.liveAfterClose) child.exitCode = 0;
    },
  };
  const puppeteer = {
    async launch(config) {
      state.launchOptions = config;
      if (options.launchGate) await options.launchGate.promise;
      if (options.launchFailure) throw Error('fixture launch failure');
      return browser;
    },
  };
  const lease = { async afterLaunch() {}, release() { state.releases++; } };
  const globals = {
    puppeteer, process, assert, join, resolve,
    mkdirSync() {}, writeFileSync() {},
    readFileSync() { throw Error('Unexpected fixture file read'); },
    existsSync(path) { return path === profile; },
    mkdtempSync() { return profile; },
    tmpdir() { return '/mock'; },
    realpathSync(path) { return path.replace('/private/mock/', '/mock/'); },
    rmSync(path) { state.removals.push(path); },
    execFileSync(command) {
      assert.equal(command, '/bin/ps');
      if (options.psFailure) throw Error('fixture ps failure');
      return options.profileInUse ? '/Chrome --user-data-dir=/private/mock/temp-profile' : '/other-process';
    },
    async acquireBrowserLease() { return lease; },
    console: { log() {}, error() {}, warn(message) { state.warnings.push(message); } },
  };
  const run = new AsyncFunction(...Object.keys(globals), source)(...Object.values(globals)).then(() => null, error => error);
  return { state, process, run, profile };
}

let checks = 0;
for (const script of ['drive.mjs', 'check-crater-browser.mjs']) {
  for (const [name, options, expectedRemovals] of [
    ['ordinary completion/error', {}, 1],
    ['persistent profile', { persistent: true }, 0],
    ['launch failure', { launchFailure: true }, 1],
    ['launch failure with surviving Chrome', { launchFailure: true, profileInUse: true }, 0],
    ['page failure', { pageFailure: true }, 1],
    ['close failure', { closeFailure: true }, 0],
    ['close resolves before child exits', { liveAfterClose: true }, 0],
    ['process scan failure', { psFailure: true }, 0],
    ['profile still used through path alias', { profileInUse: true }, 0],
  ]) {
    const { state, process, run } = launchFixture(script, options);
    const error = await run;
    assert.equal(state.removals.length, expectedRemovals, `${script}: ${name}`);
    assert.equal(state.releases, 1, `${script}: ${name} releases once`);
    assert.equal(state.closes, options.launchFailure ? 0 : 1, `${script}: ${name} closes once`);
    assert.equal(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM'), 0);
    assert.equal(state.launchOptions.handleSIGINT, false);
    assert.equal(state.launchOptions.handleSIGTERM, false);
    assert.equal(state.launchOptions.userDataDir, options.persistent ? '/kept/profile' : '/mock/temp-profile');
    if (options.launchFailure) assert.match(error?.message ?? '', /fixture launch failure/);
    else if (options.closeFailure) assert.match(error?.message ?? '', /fixture close failure/);
    else if (script === 'drive.mjs' && !options.pageFailure) assert.equal(error, null);
    else assert.match(error?.message ?? '', /fixture page failure/);
    checks++;
  }

  const launchGate = deferred();
  const interruptedLaunch = launchFixture(script, { launchGate });
  await until(() => interruptedLaunch.state.launchOptions !== null);
  interruptedLaunch.process.emit('SIGINT');
  await turn();
  assert.equal(interruptedLaunch.state.closes, 0);
  assert.equal(interruptedLaunch.state.removals.length, 0);
  assert.equal(interruptedLaunch.state.releases, 0);
  launchGate.resolve();
  await interruptedLaunch.run;
  await until(() => interruptedLaunch.state.exits.length === 1);
  assert.equal(interruptedLaunch.state.closes, 1);
  assert.equal(interruptedLaunch.state.removals.length, 1);
  assert.equal(interruptedLaunch.state.releases, 1);
  assert.deepEqual(interruptedLaunch.state.exits, [130]);
  checks++;

  const closeGate = deferred();
  const interruptedClose = launchFixture(script, { closeGate });
  await until(() => interruptedClose.state.closes === 1);
  interruptedClose.process.emit('SIGTERM');
  await turn();
  assert.equal(interruptedClose.state.removals.length, 0);
  closeGate.resolve();
  await interruptedClose.run;
  await until(() => interruptedClose.state.exits.length === 1);
  assert.equal(interruptedClose.state.closes, 1);
  assert.equal(interruptedClose.state.removals.length, 1);
  assert.equal(interruptedClose.state.releases, 1);
  assert.deepEqual(interruptedClose.state.exits, [143]);
  checks++;
}
console.log(`${checks} browser profile lifecycle checks passed; no real browser or filesystem mutations.`);
