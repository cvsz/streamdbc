const fs = require('fs');
const path = require('path');

const source = require.resolve('hls.js/dist/hls.min.js');
const targetDir = path.join(__dirname, '..', 'assets');
const target = path.join(targetDir, 'hls.min.js');
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log('Vendored hls.js to ' + target);
