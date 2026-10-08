'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { handleWindowClose, handleWindowAllClosed } = require('../window-lifecycle');

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
