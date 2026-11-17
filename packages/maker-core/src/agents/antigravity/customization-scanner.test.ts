import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scanners from '../shared/customization-worker-api.js';

// 生产入口：独立扫描进程使用的导出；真实文件系统验证原生目录与 manifest 发现契约。
let root: string;
let home: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-agy-skills-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function write(relative: string, content: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function skill(relative: string) {
  return path.dirname(write(`${relative}/SKILL.md`, '---\nname: sample\ndescription: Example skill\n---\nInstructions'));
}
async function scan(workingDirs: string[] = []) {
  expect(scanners.scanAntigravityCustomizations).toBeTypeOf('function');
  return scanners.scanAntigravityCustomizations({ workingDirs, kinds: ['skill'] });
}
describe('Antigravity customization discovery', () => {
  it('discovers native personal roots without claiming Pi-only skills are loaded', async () => {
    const expected = ['config', 'antigravity-cli', ''].map(dir => skill(`home/.gemini/${dir}/skills/native-${dir || 'shared'}`));
    skill('home/.agents/skills/pi-only');
    const result = await scan();
    expect(result.errors).toEqual([]);
    expect(result.items.map(item => item.absolutePath).sort()).toEqual(expected.sort());
    expect(result.items.every(item => item.engine === 'antigravity' && item.runtimeStatus === 'discovered')).toBe(true);
  });

  it('stops at the nearest repository and scans standard skills only one level deep', async () => {
    const expected = [skill('repo/.agents/skills/root'), skill('repo/app/.agents/skills/local')];
    fs.mkdirSync(path.join(root, 'repo/.git'));
    skill('.agents/skills/outside');
    skill('repo/.agents/skills/namespace/nested');
    const cwd = path.join(root, 'repo/app');
    const result = await scan([cwd]);
    expect(result.errors).toEqual([]);
    expect(result.items.map(item => item.absolutePath).sort()).toEqual(expected.sort());
    expect(result.items.every(item => item.workingDir === cwd)).toBe(true);
  });

  it('does not climb outside a directory without a repository', async () => {
    skill('.agents/skills/parent');
    const expected = skill('plain/.agents/skills/local');
    expect((await scan([path.join(root, 'plain')])).items.map(item => item.absolutePath)).toEqual([expected]);
  });

  it('honors explicit nested manifest entries, inherited filters and native exclusions', async () => {
    const expected = skill('repo/.agents/skills/database/migrate');
    const inherited = skill('shared/skills/team');
    skill('shared/skills/skip');
    skill('repo/.agents/skills/hidden');
    const cli = skill('home/.gemini/antigravity-cli/skills/hidden');
    fs.mkdirSync(path.join(root, 'repo/.git'));
    write('shared/.agents/skills.json', JSON.stringify({ entries: [{ path: 'skills' }] }));
    write('repo/.agents/skills.json', JSON.stringify({
      entries: [{ path: '.agents/skills', include_only: ['database/migrate'] }],
      inherits: [{ path: path.join(root, 'shared/.agents/skills.json'), include_only: ['team'] }],
      exclude: ['hidden'],
    }));
    const result = await scan([path.join(root, 'repo')]);
    expect(result.errors).toEqual([]);
    expect(result.items.map(item => item.absolutePath).sort()).toEqual([expected, inherited, cli].sort());
  });

  it('reports malformed and cyclic manifests without losing independently discovered skills', async () => {
    const expected = skill('repo/.agents/skills/ok');
    write('repo/.agents/skills.json', JSON.stringify({ inherits: [{ path: '.agents/skills.json' }] }));
    write('home/.gemini/config/skills.json', '{invalid');
    const result = await scan([path.join(root, 'repo')]);
    expect(result.items.map(item => item.absolutePath)).toEqual([expected]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some(error => /cycl/i.test(error.message))).toBe(true);
  });
});
