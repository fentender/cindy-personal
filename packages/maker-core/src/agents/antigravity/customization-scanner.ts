import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentCustomization, ListCustomizationsOptions, ListCustomizationsResult } from '../../types/customizations.js';
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

const workspaceFolders = ['.agents', '.agent', '_agents', '_agent'];
const manifestEntry = z.object({ path: z.string().min(1), include_only: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() });
const manifestSchema = z.object({
  entries: z.array(manifestEntry).optional(), inherits: z.array(manifestEntry).optional(), exclude: z.array(z.string()).optional(),
});
type Filter = { include_only?: string[]; exclude?: string[] };

function workspaceAncestors(cwd: string): string[] {
  const parents: string[] = [];
  let current = cwd;
  while (true) {
    parents.push(current);
    if (fs.existsSync(path.join(current, '.git'))) return parents;
    const parent = path.dirname(current);
    if (parent === current) return [cwd];
    current = parent;
  }
}

function matches(item: AgentCustomization, pattern: string, base: string): boolean {
  const relative = path.relative(base, item.absolutePath).replace(/\\/g, '/');
  return pattern === item.name || pattern.replace(/\\/g, '/') === relative;
}

function filtered(items: AgentCustomization[], filter: Filter, base: string): AgentCustomization[] {
  return items.filter(item => (!filter.include_only || filter.include_only.some(pattern => matches(item, pattern, base)))
    && !filter.exclude?.some(pattern => matches(item, pattern, base)));
}

/** 只读发现预览；原生 CLI 负责最终加载、优先级与每轮刷新。 */
export async function scanAntigravityCustomizations(options: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
  if (options.kinds?.length && !options.kinds.includes('skill')) return { items: [], errors: [] };
  const errors: ListCustomizationsResult['errors'] = [];
  const items: AgentCustomization[] = [];
  const personalRoot = path.join(os.homedir(), '.gemini', 'config');
  const workspaces = options.workingDirs?.length ? [...new Set(options.workingDirs)] : [undefined];

  for (const workingDir of workspaces) {
    try {
      if (workingDir && (!path.isAbsolute(workingDir) || !fs.statSync(workingDir).isDirectory())) {
        throw new Error('Antigravity workspace must be an existing absolute directory');
      }
      const cwd = workingDir ? fs.realpathSync(workingDir) : undefined;
      const ancestors = cwd ? workspaceAncestors(cwd) : [];
      const repoRoot = ancestors.at(-1);
      const exclusions: Array<{ patterns: string[]; base: string }> = [];
      const source = (dir: string, scope: string): SourceDef => ({
        engine: 'antigravity', kind: 'skill', scope, dir, workingDir,
        runtimeStatus: 'discovered', skillScanDepth: 1,
      });
      const scan = (dir: string, scope: string): AgentCustomization[] => {
        const result = scanCustomizationSources([source(dir, scope)]);
        errors.push(...result.errors);
        return result.items;
      };
      const scanTarget = (target: string, scope: string): AgentCustomization[] => {
        const folder = path.basename(target) === 'SKILL.md' ? path.dirname(target) : target;
        if (fs.existsSync(path.join(folder, 'SKILL.md'))) {
          return scan(path.dirname(folder), scope).filter(item => item.absolutePath === folder);
        }
        return scan(folder, scope);
      };
      const readManifest = (file: string, scope: string, stack: Set<string>, baseOverride?: string): AgentCustomization[] => {
        if (!fs.existsSync(file)) return [];
        const canonical = fs.realpathSync(file);
        if (stack.has(canonical)) {
          errors.push({ path: file, message: 'Cyclic Antigravity skill manifest inheritance' });
          return [];
        }
        const next = new Set(stack).add(canonical);
        try {
          const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
          const manifestDir = path.dirname(file);
          const base = baseOverride ?? (workspaceFolders.includes(path.basename(manifestDir)) ? path.dirname(manifestDir) : manifestDir);
          const resolve = (value: string) => {
            const resolved = path.resolve(base, value);
            return !path.isAbsolute(value) && !fs.existsSync(resolved) && repoRoot ? path.resolve(repoRoot, value) : resolved;
          };
          const found: AgentCustomization[] = [];
          for (const entry of manifest.entries ?? []) {
            const target = resolve(entry.path);
            const candidates = scanTarget(target, scope);
            // 清单允许直接指名更深的技能；标准目录仍只扫描一层。
            for (const name of entry.include_only ?? []) candidates.push(...scanTarget(path.resolve(target, name), scope));
            found.push(...filtered(candidates, entry, target));
          }
          for (const entry of manifest.inherits ?? []) {
            const target = resolve(entry.path);
            found.push(...filtered(readManifest(target, scope, next), entry, path.dirname(target)));
          }
          if (manifest.exclude?.length) exclusions.push({ patterns: manifest.exclude, base });
          return filtered(found, { exclude: manifest.exclude }, base);
        } catch (error) {
          errors.push({ path: file, message: error instanceof Error ? error.message : String(error) });
          return [];
        }
      };

      const discovered = scan(path.join(personalRoot, 'skills'), 'user');
      discovered.push(...readManifest(path.join(personalRoot, 'skills.json'), 'user', new Set()));
      const projectRoots = ancestors.flatMap(parent => workspaceFolders.map(folder => path.join(parent, folder)));
      if (repoRoot) {
        const configPath = path.join(repoRoot, '.gemini', 'config.json');
        if (fs.existsSync(configPath)) {
          const config = z.object({ personal_customization_dir: z.string().optional() }).parse(JSON.parse(fs.readFileSync(configPath, 'utf8')));
          if (config.personal_customization_dir) {
            const user = process.env.USER || process.env.USERNAME || os.userInfo().username;
            const personalProject = path.resolve(repoRoot, config.personal_customization_dir.replaceAll('{user}', user), '.agents');
            discovered.push(...scan(path.join(personalProject, 'skills'), 'repo'));
            discovered.push(...readManifest(path.join(personalProject, 'skills.json'), 'repo', new Set(), repoRoot));
          }
        }
      }
      for (const projectRoot of projectRoots) {
        discovered.push(...scan(path.join(projectRoot, 'skills'), 'repo'));
        discovered.push(...readManifest(path.join(projectRoot, 'skills.json'), 'repo', new Set()));
      }
      items.push(...discovered.filter(item => !exclusions.some(exclusion => exclusion.patterns.some(pattern => matches(item, pattern, exclusion.base)))));
      // CLI 专属目录不受 manifest exclude 影响。
      items.push(...scan(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'skills'), 'user'));
      items.push(...scan(path.join(os.homedir(), '.gemini', 'skills'), 'user'));
    } catch (error) {
      errors.push({ path: workingDir, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const seen = new Set<string>();
  return { errors, items: items.filter(item => {
    const key = `${item.workingDir ?? ''}\0${fs.realpathSync(item.absolutePath)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }) };
}
