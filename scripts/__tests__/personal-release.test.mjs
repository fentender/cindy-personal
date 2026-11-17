import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { personalVersionCode, createPersonalManifests } from '../personal-release.mjs';

test('personal versions are ordered identically by Windows, Android and the update manifest', () => {
  assert.ok(personalVersionCode('1.1.0') > personalVersionCode('1.0.999'));
  assert.equal(personalVersionCode('1.0.1'), 1000001);
  for (const invalid of ['0.0.0', '1.1000.0', '1.0.1-beta', '01.0.1', '3000.0.0']) {
    assert.throws(() => personalVersionCode(invalid));
  }
});

test('both manifests pin assets to one version and contain verified desktop hashes', () => {
  const manifests = createPersonalManifests({ repository: 'example/personal', version: '1.0.2',
    installer: { name: 'setup.exe', size: 10, sha256: 'a'.repeat(64) },
    hotfix: { name: 'hotfix.zip', size: 20, sha256: 'b'.repeat(64) }, apk: 'Cindy.apk' });
  assert.equal(manifests.desktop.app.hotfix.file, 'https://github.com/example/personal/releases/download/v1.0.2/hotfix.zip');
  assert.equal(manifests.desktop.app.hotfix.sha256, 'b'.repeat(64));
  assert.equal(manifests.mobile.delivery, 'apk');
  assert.equal(manifests.mobile.buildNumber, 1000002);
  assert.equal(manifests.mobile.version, manifests.desktop.app.version);
  assert.equal(manifests.mobile.installUrl, 'https://github.com/example/personal/releases/download/v1.0.2/Cindy.apk');
});

test('Windows PowerShell restores release identity after a failed collection', { skip: process.platform !== 'win32' }, () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(existsSync(new URL('../../apps/desktop/release/artifacts/cn/2099.999.999', import.meta.url)), false);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    $env:CINDY_PERSONAL_RELEASE_REPOSITORY = 'previous/repo'
    $env:EXPO_PUBLIC_CINDY_PERSONAL_RELEASE_REPOSITORY = 'previous/mobile'
    $before = (Get-Location).Path
    try { & .\\release.ps1 -Version 2099.999.999 -Target collect -Repository example/personal } catch {}
    if ($env:CINDY_PERSONAL_RELEASE_REPOSITORY -ne 'previous/repo' -or
        $env:EXPO_PUBLIC_CINDY_PERSONAL_RELEASE_REPOSITORY -ne 'previous/mobile' -or
        (Get-Location).Path -ne $before) { throw 'Release scope leaked' }
    Write-Output 'RELEASE_SCOPE_RESTORED'
  `], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RELEASE_SCOPE_RESTORED/);
});
