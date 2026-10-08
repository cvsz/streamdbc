'use strict';

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

module.exports = { handleWindowClose, handleWindowAllClosed };
