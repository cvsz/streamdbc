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

console.log('Prepared bundled StreamDBC server runtime:', runtimeDir);
