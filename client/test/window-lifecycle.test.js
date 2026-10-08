'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  createBeforeQuitHandler,
  handleWindowClose,
  handleWindowAllClosed,
  terminateManagedProcessTree,
  getUnexpectedManagedProcessExitError
} = require('../window-lifecycle');

test('closing the main window is not intercepted to keep the process in the tray', () => {
  let prevented = false;
  let quitCalls = 0;
  const app = { isQuitting: false, quit: () => { quitCalls += 1; } };

  handleWindowClose({ preventDefault: () => { prevented = true; } }, app);

  assert.equal(prevented, false);
  assert.equal(app.isQuitting, true);
  assert.equal(quitCalls, 1);
});

test('closing the main window does not request a second quit while shutdown is underway', () => {
  let quitCalls = 0;
  const app = { isQuitting: true, quit: () => { quitCalls += 1; } };

  handleWindowClose({ preventDefault: () => assert.fail('close should not be prevented') }, app);

  assert.equal(quitCalls, 0);
});

test('closing the last Windows window destroys the tray and quits the app', () => {
  let quitCalls = 0;
  let trayDestroyCalls = 0;
  const app = { quit: () => { quitCalls += 1; } };
  const tray = { destroy: () => { trayDestroyCalls += 1; } };

  handleWindowAllClosed(app, tray, 'win32');

  assert.equal(trayDestroyCalls, 1);
  assert.equal(quitCalls, 1);
});

test('closing the last macOS window keeps the app running', () => {
  let quitCalls = 0;
  let trayDestroyCalls = 0;
  const app = { quit: () => { quitCalls += 1; } };
  const tray = { destroy: () => { trayDestroyCalls += 1; } };

  handleWindowAllClosed(app, tray, 'darwin');

  assert.equal(trayDestroyCalls, 0);
  assert.equal(quitCalls, 0);
});

test('before-quit stops the Control Panel owned server before allowing app exit', async () => {
  const child = { pid: 42, exitCode: null, signalCode: null };
  let prevented = false;
  let saved = 0;
  let quitCalls = 0;
  let stopped = 0;
  const app = { quit: () => { quitCalls += 1; } };
  const onBeforeQuit = createBeforeQuitHandler({
    app,
    getManagedProcess: () => child,
    saveSettings: () => { saved += 1; },
    terminateProcessTree: async (process) => {
      assert.equal(process, child);
      stopped += 1;
      child.exitCode = 0;
    },
    platform: 'win32'
  });

  onBeforeQuit({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(stopped, 1);
  assert.equal(quitCalls, 1);
  assert.equal(saved, 1);

  let preventedOnFinalQuit = false;
  onBeforeQuit({ preventDefault: () => { preventedOnFinalQuit = true; } });
  assert.equal(preventedOnFinalQuit, false);
  assert.equal(saved, 2);
});

test('before-quit keeps the app open and permits retry if managed process cleanup fails', async () => {
  const child = { pid: 43, exitCode: null, signalCode: null };
  let prevented = false;
  let saved = 0;
  let quitCalls = 0;
  let attempts = 0;
  const app = { isQuitting: true, quit: () => { quitCalls += 1; } };
  const onBeforeQuit = createBeforeQuitHandler({
    app,
    getManagedProcess: () => child,
    saveSettings: () => { saved += 1; },
    terminateProcessTree: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('cleanup timed out');
      child.exitCode = 0;
    },
    platform: 'win32'
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    onBeforeQuit({ preventDefault: () => { prevented = true; } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prevented, true);
    assert.equal(quitCalls, 0);
    assert.equal(app.isQuitting, false);

    onBeforeQuit({ preventDefault: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(attempts, 2);
  assert.equal(quitCalls, 1);
  assert.equal(saved, 2);
});

test('Windows cleanup terminates the owned PID tree with taskkill /T', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  let taskkillArgs;
  let exitError;
  child.once('exit', (code, signal) => {
    exitError = getUnexpectedManagedProcessExitError(child, code, signal);
  });
  const spawnCommand = (executable, args) => {
    assert.equal(executable, 'taskkill.exe');
    taskkillArgs = args;
    const command = new EventEmitter();
    setImmediate(() => {
      child.exitCode = 1;
      child.emit('exit', 1, null);
      command.emit('close', 0);
    });
    return command;
  };

  await terminateManagedProcessTree(child, 'win32', spawnCommand);

  assert.deepEqual(taskkillArgs, ['/PID', '4242', '/T', '/F']);
  assert.equal(exitError, null, 'a forced exit during requested cleanup must not become a server error');
});

test('unexpected managed server failures keep their exit error', () => {
  const child = {};

  assert.equal(getUnexpectedManagedProcessExitError(child, 1, null), 'stremdbc.exe exited with code 1');
  assert.equal(getUnexpectedManagedProcessExitError(child, null, 'SIGTERM'), 'stremdbc.exe exited after signal SIGTERM');
  assert.equal(getUnexpectedManagedProcessExitError(child, 0, null), null);
});
