import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { botRuntimeSkillPolicy, type AgentDeps, type StartSessionOptions } from '../base-agent.js';
import { resolveAllowedManagedSkills, snapshotManagedSkillGrants } from '../shared/managed-skill-policy.js';
import { canonicalSkillPath, snapshotDisabledSkillPaths } from '../shared/skill-activation.js';

/** Cindy 管理的技能通过本会话目录供原生发现；管理偏好、Bot 授权仍由 Cindy 裁决。 */
export class AntigravityManagedSkills {
  readonly directory: string;
  disabledPaths: readonly string[] = [];
  private readonly mounted = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();

  private constructor(directory: string, private readonly deps: AgentDeps, private readonly options: StartSessionOptions) {
    this.directory = directory;
  }

  static async create(deps: AgentDeps, options: StartSessionOptions): Promise<AntigravityManagedSkills | undefined> {
    if (!deps.getManagedSkills && !options.botRuntimeProfile?.skillPolicy.ownSkills?.length && !options.hostSkills?.length) return undefined;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-antigravity-skills-'));
    const projection = new AntigravityManagedSkills(directory, deps, options);
    try {
      await fs.mkdir(path.join(directory, '.agents', 'skills'), { recursive: true });
      await projection.refresh();
      return projection;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  refresh(): Promise<void> {
    this.pending = this.reconcile();
    return this.pending;
  }

  private async reconcile(): Promise<void> {
    const disabled = snapshotDisabledSkillPaths(this.deps.getDisabledSkillPaths?.() ?? []);
    const policy = botRuntimeSkillPolicy(this.options.botRuntimeProfile);
    const mutableOwnedSources = new Set((policy?.ownSkills ?? []).map(skill => canonicalSkillPath(skill.path)));
    const managed = resolveAllowedManagedSkills(await this.deps.getManagedSkills?.() ?? [], snapshotManagedSkillGrants(policy), disabled);
    // 伙伴自有技能和本次宿主授予的技能不属于外部技能 allowlist。
    const sources = [
      ...managed.map(skill => path.dirname(skill.path)),
      ...(policy?.ownSkills ?? []).map(skill => skill.path),
      ...(this.options.hostSkills ?? []).map(skill => skill.path),
    ];
    const selected = new Map<string, string>();
    for (const source of sources) {
      const resolved = await fs.realpath(source);
      selected.set(canonicalSkillPath(resolved), resolved);
    }
    for (const [identity, source] of selected) {
      if (this.mounted.has(identity) && !mutableOwnedSources.has(identity)) continue;
      const name = createHash('sha256').update(identity).digest('hex');
      const target = path.join(this.directory, '.agents', 'skills', name);
      const staging = path.join(this.directory, `pending-${randomUUID()}`);
      try {
        // agy 不发现 Windows junction 中的技能；复制批准的资源，原始目录不变。
        await fs.cp(source, staging, { recursive: true, verbatimSymlinks: true });
        await fs.access(path.join(staging, 'SKILL.md'));
        // Bot 学到的新内容在下一轮使用；整目录替换同时移除已经删除的资源。
        if (this.mounted.has(identity)) {
          await fs.rm(target, { recursive: true, force: true });
          this.mounted.delete(identity);
        }
        await fs.rename(staging, target);
        this.mounted.set(identity, target);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    }
    for (const [identity, target] of this.mounted) {
      if (selected.has(identity)) continue;
      await fs.rm(target, { recursive: true, force: true });
      this.mounted.delete(identity);
    }
    this.disabledPaths = disabled;
  }

  async dispose(): Promise<void> {
    // 退出可能发生在下一轮技能准备期间，等写入结束后再释放所属目录。
    try { await this.pending; }
    finally { await fs.rm(this.directory, { recursive: true, force: true }); }
  }
}
