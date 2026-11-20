// The build must work wherever the project folder lives, including a path with spaces (B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from './helpers.mjs';

test('builds from a folder whose name contains spaces', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell build ')), 'my project (copy)');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['build.mjs', 'notices.mjs', 'package.json']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  execFileSync(process.execPath, [path.join(dir, 'build.mjs')], { stdio: 'pipe' });
  const built = fs.readFileSync(path.join(dir, 'dist', 'Inkwell.html'), 'utf8');
  assert.ok(built.length > 3_000_000);
  assert.match(built, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-/);
  assert.ok(fs.existsSync(path.join(dir, 'THIRD_PARTY_NOTICES.md')));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});
