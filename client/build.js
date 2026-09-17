const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIENT_DIR = __dirname;
const ASSETS_DIR = path.join(CLIENT_DIR, 'assets');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

function build() {
  console.log('=== STREMDBC Client Build ===');
  console.log(`Client dir: ${CLIENT_DIR}`);

  ensureDir(ASSETS_DIR);

  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="16" y="48" width="224" height="160" rx="16" fill="#08101d" stroke="#667eea" stroke-width="8"/>
  <polygon points="96,80 96,176 176,128" fill="#667eea"/>
  <circle cx="200" cy="72" r="12" fill="#22c55e"/>
</svg>`;

  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.svg'), iconSvg);

  const trayIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="8" y="24" width="48" height="32" rx="6" fill="#08101d" stroke="#667eea" stroke-width="3"/>
  <polygon points="24,28 24,52 40,40" fill="#667eea"/>
</svg>`;

  fs.writeFileSync(path.join(ASSETS_DIR, 'tray-icon.svg'), trayIconSvg);

  console.log('✓ Icons created');

  const dashboardSrc = path.join(CLIENT_DIR, '..', 'web', 'dashboard', 'index.html');
  const dashboardDest = path.join(CLIENT_DIR, 'assets', 'dashboard', 'index.html');
  if (fs.existsSync(dashboardSrc)) {
    copyFile(dashboardSrc, dashboardDest);
    console.log('✓ Dashboard copied');
  }

  const playerSrc = path.join(CLIENT_DIR, '..', 'web', 'player', 'index.html');
  const playerDest = path.join(CLIENT_DIR, 'assets', 'player', 'index.html');
  if (fs.existsSync(playerSrc)) {
    copyFile(playerSrc, playerDest);
    console.log('✓ Player copied');
  }

  console.log('\n=== Build Steps ===');
  console.log('1. Install dependencies:');
  console.log('   cd client && npm install');
  console.log('');
  console.log('2. Run in development:');
  console.log('   cd client && npm start');
  console.log('');
  console.log('3. Build for Windows:');
  console.log('   cd client && npm run build:win');
  console.log('');
  console.log('4. Build with electron-builder:');
  console.log('   cd client && npm run dist');
}

build();
