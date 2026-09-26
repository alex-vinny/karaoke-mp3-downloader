// install.ps1 end to end, on Windows only, in a throwaway root (KARAOKE_TEST_ROOT):
// a first install from a local zip, then an update through the very update.cmd the
// desktop shortcut points at — including the self-update hand-over (step 0), with
// file:// URLs instead of GitHub. Nothing outside tests/.tmp is touched: no Chrome,
// no clipboard, no real desktop. Roughly 15 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWindows = process.platform === 'win32';
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));

function ps(args, env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function shortcut(lnk) {
  const r = ps(['-Command', `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); $s.TargetPath; '<args>' + $s.Arguments + '</args>'; $s.WorkingDirectory`]);
  const [target, args, workDir] = r.out.trim().split(/\r?\n/);
  return { target, args: args.replace(/^<args>|<\/args>$/g, ''), workDir };
}
function zipExtension(dest, version) {
  const src = path.join(path.dirname(dest), 'src-' + path.basename(dest, '.zip'));
  fs.cpSync(path.join(root, 'extension'), src, { recursive: true });
  if (version) {
    const m = path.join(src, 'manifest.json');
    fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`));
  }
  const r = ps(['-Command', `Compress-Archive -Path '${src}\\*' -DestinationPath '${dest}' -Force`]);
  assert.equal(r.code, 0, r.out);
}

test('install.ps1: first install, then an update through update.cmd with self-update', { skip: !isWindows && 'Windows only' }, () => {
  const tmp = path.join(root, 'tests', '.tmp', 'installer-' + process.pid);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const testRoot = path.join(tmp, 'root');
  const base = path.join(testRoot, 'KaraokeMP3');
  const env = { KARAOKE_TEST_ROOT: testRoot };
  try {
    // --- 1. first install from a local zip (the -Zip path Vinicius uses before a release)
    const zipA = path.join(tmp, 'a.zip');
    zipExtension(zipA);
    const first = ps(['-File', path.join(root, 'install.ps1'), '-Zip', zipA], env);
    assert.equal(first.code, 0, first.out);
    assert.ok(fs.existsSync(path.join(base, 'extension', 'manifest.json')), 'extension unpacked');
    assert.equal(fs.readFileSync(path.join(base, 'version.txt'), 'utf8').trim(), manifest.version);
    assert.ok(first.out.includes(path.join(base, 'extension')), 'first run prints the extension path');
    // the local copy of the installer and the .cmd the shortcut runs
    assert.equal(fs.readFileSync(path.join(base, 'install.ps1'), 'utf8'), fs.readFileSync(path.join(root, 'install.ps1'), 'utf8'), 'local copy = the script that ran');
    const cmd = fs.readFileSync(path.join(base, 'update.cmd'), 'latin1');
    assert.ok(/^[\x00-\x7F]*$/.test(cmd), 'update.cmd is plain ASCII');
    assert.ok(cmd.includes('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"'), cmd);
    assert.ok(cmd.includes('pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"'), 'falls back to pwsh');
    // desktop shortcuts: the songs folder and the update .cmd (no arguments left behind)
    const lnks = fs.readdirSync(path.join(testRoot, 'Desktop')).filter((f) => f.endsWith('.lnk'));
    assert.equal(lnks.length, 2, lnks.join(', '));
    const update = lnks.map((f) => shortcut(path.join(testRoot, 'Desktop', f))).find((s) => s.target.toLowerCase().endsWith('update.cmd'));
    assert.ok(update, 'one shortcut points at update.cmd');
    assert.equal(update.target.toLowerCase(), path.join(base, 'update.cmd').toLowerCase());
    assert.equal(update.args, '');
    assert.equal(update.workDir.toLowerCase(), base.toLowerCase());
    assert.ok(fs.existsSync(path.join(testRoot, 'Downloads')), 'songs folder created under Downloads');

    // --- 2. the update, the way the shortcut does it: update.cmd → local install.ps1 →
    //        step 0 finds a newer installer (a marked copy) and hands over to it → it
    //        installs zip B (a higher version) and lands as the new local copy
    const zipB = path.join(tmp, 'b.zip');
    zipExtension(zipB, '9.9.9');
    const marked = path.join(tmp, 'install-marked.ps1');
    fs.writeFileSync(marked, fs.readFileSync(path.join(root, 'install.ps1'), 'utf8') + (os.EOL + '# marker: newer installer' + os.EOL));
    const upd = spawnSync(path.join(base, 'update.cmd'), [], {
      shell: true, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, ...env, KARAOKE_ZIP_URL: pathToFileURL(zipB).href, KARAOKE_INSTALLER_URL: pathToFileURL(marked).href },
    });
    const out = (upd.stdout || '') + (upd.stderr || '');
    assert.equal(upd.status, 0, out);
    assert.equal(fs.readFileSync(path.join(base, 'version.txt'), 'utf8').trim(), '9.9.9', out);
    assert.match(fs.readFileSync(path.join(base, 'extension', 'manifest.json'), 'utf8'), /"version": "9\.9\.9"/);
    assert.ok(out.includes('9.9.9'), 'reports the new version: ' + out);
    assert.ok(fs.readFileSync(path.join(base, 'install.ps1'), 'utf8').includes('# marker: newer installer'), 'the newer installer became the local copy');
    assert.ok(!fs.existsSync(path.join(base, 'install.new.ps1')), 'hand-over file cleaned up');
    assert.ok(!fs.existsSync(path.join(base, 'tmp')), 'tmp folder cleaned up');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
