import assert from 'node:assert/strict';
import test from 'node:test';

import { CHANGES_MAX, parsePorcelainZ } from '../src/changes.js';

test('parsePorcelainZ reads modified, added and untracked files', () => {
  const output = ' M src/a.js\0A  src/b.js\0?? notes.txt\0';
  assert.deepEqual(parsePorcelainZ(output), {
    files: [
      { status: ' M', path: 'src/a.js' },
      { status: 'A ', path: 'src/b.js' },
      { status: '??', path: 'notes.txt' },
    ],
    truncated: false,
  });
});

test('parsePorcelainZ consumes the original path of renames and copies', () => {
  const output = 'R  new.js\0old.js\0C  copy.js\0src.js\0 D gone.js\0';
  assert.deepEqual(parsePorcelainZ(output).files, [
    { status: 'R ', path: 'new.js' },
    { status: 'C ', path: 'copy.js' },
    { status: ' D', path: 'gone.js' },
  ]);
});

test('parsePorcelainZ keeps spaces and odd characters in paths', () => {
  assert.deepEqual(parsePorcelainZ('?? dir/a file\nname.txt\0').files, [{ status: '??', path: 'dir/a file\nname.txt' }]);
});

test('parsePorcelainZ tolerates empty and bad input', () => {
  assert.deepEqual(parsePorcelainZ(''), { files: [], truncated: false });
  assert.deepEqual(parsePorcelainZ(null), { files: [], truncated: false });
});

test('parsePorcelainZ caps the list and reports truncation', () => {
  const output = Array.from({ length: CHANGES_MAX + 5 }, (_, index) => `?? f${index}`).join('\0');
  const result = parsePorcelainZ(output);
  assert.equal(result.files.length, CHANGES_MAX);
  assert.equal(result.truncated, true);

  const exact = Array.from({ length: CHANGES_MAX }, (_, index) => `?? f${index}`).join('\0');
  assert.equal(parsePorcelainZ(exact).truncated, false);
});
