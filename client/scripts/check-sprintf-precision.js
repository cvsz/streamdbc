'use strict';

const assert = require('assert');
const { sprintf } = require('sprintf-js');

assert.strictEqual(require('sprintf-js/package.json').version, '1.1.4+streamdbc.1');
assert.strictEqual(sprintf('%.2f', 1.239), '1.24');
assert.strictEqual(sprintf('%.0f', 1.25), '1');
assert.strictEqual(sprintf('%.2g', 1.25), '1.3');
assert.strictEqual(sprintf('%.0g', 1.25), '1');
assert.strictEqual(sprintf('%.000000000000000000001f', 1.25), '1.3');
assert.strictEqual(sprintf('%.120s', 'a'.repeat(150)).length, 120);

const excessivePrecision = '9'.repeat(512);
for (const type of ['e', 'f', 'g']) {
  const maxPrecisionOutput = sprintf('%.100' + type, 1.25);
  assert.strictEqual(sprintf('%.101' + type, 1.25), maxPrecisionOutput);
  assert.strictEqual(sprintf('%.' + excessivePrecision + type, 1.25), maxPrecisionOutput);
}

console.log('sprintf-js precision guard passed');
