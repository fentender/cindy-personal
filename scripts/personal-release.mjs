import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { personalReleaseSource, personalReleaseAssetUrl } from '../packages/maker-shared/src/personalRelease.ts';

export function personalVersionCode(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Version must be x.y.z');
  const [major, minor, patch] = version.split('.').map(Number);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (minor > 999 || patch > 999 || code < 1 || code > 2_100_000_000) throw new Error('Version exceeds Android versionCode range');
  return code;
}

export function createPersonalManifests({ repository, version, installer, hotfix, apk }) {
  const buildNumber = personalVersionCode(version);
  const source = personalReleaseSource(repository);
  if (!source) throw new Error('Personal repository is required');
  const url = (name) => personalReleaseAssetUrl(source,
    `https://github.com/${source.repository}/releases/download/v${version}/${encodeURIComponent(name)}`);
  const asset = ({ name, size, sha256 }) => ({ file: url(name), size, sha256 });
  return {
    desktop: { app: { version, installer: asset(installer), hotfix: asset(hotfix) } },
    mobile: { delivery: 'apk', version, buildNumber, runtimeVersion: '', installUrl: url(apk) },
  };
}

async function assetInfo(directory, name) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
  return { name, size: (await stat(join(directory, name))).size, sha256: hash.digest('hex') };
}

// 两端安装包全部存在时才生成可发布清单，半次构建不会变成可用更新。
async function collect(version, repository) {
  personalVersionCode(version);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const output = join(root, 'release/personal', version);
  const desktop = join(root, 'apps/desktop/release/artifacts/cn', version, 'win32-x64');
  const files = await readdir(desktop);
  function single(suffix) {
    const matches = files.filter(name => name.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} in ${desktop}`);
    return matches[0];
  }
  await mkdir(output, { recursive: true });
  const installerName = `Cindy-Personal-${version}-Windows-x64.exe`;
  const hotfixName = `Cindy-Personal-${version}-Windows-x64.zip`;
  const apkName = `Cindy-Personal-${version}-Android.apk`;
  await copyFile(join(desktop, single('-Setup.exe')), join(output, installerName));
  await copyFile(join(desktop, single('-hotfix.zip')), join(output, hotfixName));
  await copyFile(join(output, 'app-release.apk'), join(output, apkName));
  const installer = await assetInfo(output, installerName);
  const hotfix = await assetInfo(output, hotfixName);
  const apk = await assetInfo(output, apkName);
  const manifests = createPersonalManifests({ repository, version, installer, hotfix, apk: apkName });
  await writeFile(join(output, 'manifest-win32-x64.json'), JSON.stringify(manifests.desktop, null, 2) + '\n');
  await writeFile(join(output, 'mobile-android.json'), JSON.stringify(manifests.mobile, null, 2) + '\n');
  await writeFile(join(output, 'SHA256SUMS'), [installer, hotfix, apk].map(x => `${x.sha256}  ${x.name}`).join('\n') + '\n');
  console.log(`PERSONAL_RELEASE_READY=${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, version, repository] = process.argv.slice(2);
  if (action === 'version-code') console.log(personalVersionCode(version));
  else if (action === 'collect') await collect(version, repository);
  else throw new Error('Expected version-code <version> or collect <version> <owner/repo>');
}
