import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentDeps, StartSessionOptions } from '../base-agent.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { AntigravityManagedSkills } from './managed-skills.js';

describe('Antigravity managed Skill projection', () => {
  it('keeps Bot-owned Skills outside external grants and refreshes learned instructions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-agy-owned-test-'));
    const own = path.join(root, 'own');
    const external = path.join(root, 'external');
    for (const directory of [own, external]) {
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${path.basename(directory)}\ndescription: fixture\n---\ninitial`);
    }
    const deps: AgentDeps = {
      binaryPath: '/native/agy', logger: createConsoleLogger('test'), runtimeConfig: {},
      auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
      getDisabledSkillPaths: () => [own],
      getManagedSkills: async () => [{ kind: 'agent-skill', name: 'external', path: path.join(external, 'SKILL.md'),
        source: 'skill', scope: 'user', claudeCommandName: 'fixture:external' }],
    };
    const options: StartSessionOptions = { workingDir: root, model: 'gemini-4-argon',
      botRuntimeProfile: { botId: 'fixture', profileVersion: 1,
        mcpPolicy: { mode: 'inherit', configured: [], catalog: [] },
        toolsetPolicy: { mode: 'inherit', configured: [], catalog: [] },
        skillPolicy: { mode: 'allowlist', configured: [], catalog: [],
          ownSkills: [{ name: 'own', path: own }] } } };
    const projection = await AntigravityManagedSkills.create(deps, options);
    try {
      const mounted = path.join(projection!.directory, '.agents', 'skills');
      const directories = await fs.readdir(mounted);
      expect(directories).toHaveLength(1);
      const entry = path.join(mounted, directories[0]!, 'SKILL.md');
      expect(await fs.readFile(entry, 'utf8')).toContain('name: own');
      await fs.writeFile(path.join(own, 'SKILL.md'), '---\nname: own\ndescription: fixture\n---\nlearned update');
      await projection!.refresh();
      expect(await fs.readFile(entry, 'utf8')).toContain('learned update');
    } finally {
      await projection!.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
