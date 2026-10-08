'use strict';

const { spawn } = require('node:child_process');
const expectedManagedProcessStops = new WeakSet();

function hasExited(child) {
  return !child || child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined;
}

function getUnexpectedManagedProcessExitError(child, code, signal) {
  if (child && typeof child === 'object' && expectedManagedProcessStops.has(child)) return null;
  if (code && code !== 0) return `stremdbc.exe exited with code ${code}`;
  if (signal) return `stremdbc.exe exited after signal ${signal}`;
  return null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (exited) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      resolve(exited || hasExited(child));
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

function runCommand(executable, args, spawnCommand) {
  return new Promise((resolve, reject) => {
    let command;
    try {
      command = spawnCommand(executable, args, { windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      reject(err);
      return;
    }
    command.once('error', reject);
    command.once('close', (code) => resolve(code === 0));
  });
}

async function terminateManagedProcessTree(child, platform = process.platform, spawnCommand = spawn) {
  if (hasExited(child)) return;

  expectedManagedProcessStops.add(child);
  try {
    if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      try {
        const killed = await runCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], spawnCommand);
        if (killed && await waitForExit(child, 3000)) return;
      } catch {}
    } else if (platform !== 'win32') {
      try { child.kill('SIGTERM'); } catch {}
      if (await waitForExit(child, 2000)) return;
      try { child.kill('SIGKILL'); } catch {}
      if (await waitForExit(child, 1000)) return;
    }

    try { child.kill(); } catch {}
    if (!await waitForExit(child, 2000)) {
      throw new Error('The Control Panel could not confirm that its managed server process exited');
    }
  } catch (err) {
    expectedManagedProcessStops.delete(child);
    throw err;
  }
}

function createBeforeQuitHandler({ app, getManagedProcess, saveSettings, terminateProcessTree = terminateManagedProcessTree, platform = process.platform }) {
  let allowQuitAfterCleanup = false;
  let cleanupStarted = false;

  return (event) => {
    saveSettings();
    if (allowQuitAfterCleanup) return;

    const child = getManagedProcess();
    if (hasExited(child) || !Number.isInteger(child.pid) || child.pid <= 0) return;

    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    Promise.resolve()
      .then(() => terminateProcessTree(child, platform))
      .then(() => {
        allowQuitAfterCleanup = true;
        app.quit();
      })
      .catch((err) => {
        cleanupStarted = false;
        app.isQuitting = false;
        console.error('Failed to stop Control Panel managed server process:', err.message);
      });
  };
}

function handleWindowClose(_event, app) {
  if (!app || app.isQuitting) return;
  app.isQuitting = true;
  app.quit();
}

function handleWindowAllClosed(app, tray, platform) {
  if (platform === 'darwin') return;
  if (tray) tray.destroy();
  app.quit();
}

module.exports = {
  createBeforeQuitHandler,
  handleWindowAllClosed,
  handleWindowClose,
  terminateManagedProcessTree,
  getUnexpectedManagedProcessExitError
};
