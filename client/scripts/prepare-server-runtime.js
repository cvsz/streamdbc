const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const clientDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientDir, '..');
const runtimeDir = path.join(clientDir, 'server-runtime');

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

if (process.platform !== 'win32') {
  throw new Error('prepare-server-runtime.js is intended for Windows packaging');
}
const prepareFFmpeg = path.join(repoRoot, 'scripts', 'windows', 'prepare-bundled-ffmpeg.ps1');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', prepareFFmpeg], {
  cwd: repoRoot,
  stdio: 'inherit'
});

const output = path.join(runtimeDir, 'stremdbc.exe');
execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', output, './cmd/stremdbc'], {
  cwd: repoRoot,
  stdio: 'inherit'
});

fs.mkdirSync(path.join(runtimeDir, 'configs'), { recursive: true });
fs.copyFileSync(
  path.join(repoRoot, 'configs', 'samsung-f5500.yaml'),
  path.join(runtimeDir, 'configs', 'samsung-f5500.yaml')
);
copyTree(path.join(repoRoot, 'web', 'tv'), path.join(runtimeDir, 'web', 'tv'));
copyTree(path.join(repoRoot, 'scripts', 'windows'), path.join(runtimeDir, 'scripts', 'windows'));
copyTree(path.join(clientDir, 'vendor', 'ffmpeg'), path.join(runtimeDir, 'ffmpeg'));

for (const required of [
  path.join(runtimeDir, 'ffmpeg', 'ffmpeg.exe'),
  path.join(runtimeDir, 'ffmpeg', 'ffprobe.exe'),
  path.join(runtimeDir, 'scripts', 'windows', 'samsung-tv-doctor.ps1')
]) {
  if (!fs.existsSync(required)) throw new Error(`Required bundled runtime file missing: ${required}`);
}

console.log('Prepared bundled StreamDBC server runtime:', runtimeDir);
