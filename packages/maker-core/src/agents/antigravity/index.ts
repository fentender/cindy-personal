import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { McpServer, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { BaseAgent, AgentNotAuthenticatedError, AgentStartupCleanupPendingError, AgentStartupStoppedError,
  LOCAL_AGENT_CLIENT, TASK_SYSTEM_PROMPT, TurnDispatchRejectedError, TurnPermissionPolicyUnsupportedError,
  type AgentSessionHandle, type StartSessionOptions, type SendOptions, type PiExtraSpawnConfig } from '../base-agent.js';
import type { Capabilities } from '../../types/capabilities.js';
import type { AgentEvent, InteractionResolver } from '../../types/events.js';
import type { PermissionMode } from '../../types/common.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import { AntigravityProcess } from './process.js';
import { AntigravityClient } from './client.js';
import { AntigravityTranslator } from './translator.js';
import { antigravityCurrentModel } from './config.js';
import { loadMemoryContext } from '../../memory/context.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';
import type { ListCustomizationsOptions, ListCustomizationsResult } from '../../types/customizations.js';
import { scanAntigravityCustomizations } from './customization-scanner.js';
import { buildAntigravityPrompt } from './prompt.js';
import { AntigravityManagedSkills } from './managed-skills.js';
import type { ListAgentSkillsOptions, ListAgentSkillsResult } from '../../types/palette.js';

export class AntigravityAgent extends BaseAgent {
  readonly kind = 'antigravity' as const;
  readonly capabilities: Capabilities = this.buildCapabilities({
    switchModel: { supported: true }, availableModels: [], hasFastMode: false,
    effort: { supported: true }, effortLevels: [], reasoningDisplay: ['off', 'full'],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }, { id: 'auto', displayName: 'Auto' },
      { id: 'acceptEdits', displayName: 'Accept edits' }],
    setPermissionModeMidSession: { supported: true },
    turnPermissionPolicy: { supported: { supported: false, reason: 'sdk-missing' }, unsupportedPermissionModes: ['ask', 'auto', 'acceptEdits'] },
    planMode: { supported: false, reason: 'not-implemented' },
    multimodal: { text: { supported: true }, image: { supported: true }, file: { supported: true } },
    fork: { supported: false, reason: 'sdk-missing' }, rewind: { supported: false, reason: 'sdk-missing' },
    abort: { supported: true }, sameTurnSteer: { supported: false, reason: 'not-implemented' },
    memory: { supported: { supported: false, reason: 'not-implemented' } },
    extraDirs: { supported: false, reason: 'sdk-missing' }, writableDirs: { supported: false, reason: 'not-implemented' },
  });

  override async listCustomizations(options: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
    const result = await (this.deps.scanLocalCustomizations
      ? this.deps.scanLocalCustomizations(this.kind, options)
      : scanAntigravityCustomizations(options));
    if (!options.kinds || options.kinds.includes('skill')) {
      result.items.push(...(await this.deps.getManagedSkills?.() ?? []).filter(skill => skill.path).map(skill => ({
        engine: this.kind, kind: 'skill', scope: 'user', name: skill.name, description: skill.description,
        absolutePath: path.dirname(skill.path!), mdPath: skill.path, enabled: skill.enabled,
      })));
    }
    return result;
  }

  override async listAgentSkills(options: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    if (options.remoteHostId) return { skills: [] };
    const discovered = await this.listCustomizations({ workingDirs: options.workingDir ? [options.workingDir] : [], kinds: ['skill'] });
    return this.filterActiveSkillCommands({ skills: discovered.items.map(skill => ({
      kind: 'agent-skill', name: skill.name, description: skill.description, source: 'skill',
      scope: skill.scope === 'user' ? 'user' : 'project', path: skill.mdPath ?? path.join(skill.absolutePath, 'SKILL.md'),
      enabled: skill.enabled,
    })) });
  }

  async startSession(options: StartSessionOptions): Promise<AgentSessionHandle> {
    let native: AntigravityProcess | undefined;
    let client: AntigravityClient | undefined;
    let bridge: PiExtraSpawnConfig | null = null;
    let releaseAfterExit: Promise<void> | undefined;
    let skills: AntigravityManagedSkills | undefined;
    const queue = createAsyncQueue<AgentEvent>();
    let released = false;
    let aborting = false;
    let finishOnExit: (() => void) | undefined;
    const release = async () => {
      if (released) return;
      released = true;
      finishOnExit?.();
      client?.close();
      queue.end();
      bridge?.disposeSessionCtx?.();
      await skills?.dispose();
    };
    try {
      // ACP 的本机文件工具不能冒充远端文件执行，也不能提供 Cindy Review 的硬只读边界。
      if (options.remoteHostId || options.deviceHosted) this.throwNotSupported('remote execution', 'not-implemented');
      if (options[LOCAL_AGENT_CLIENT]?.hostToolsOnly) this.throwNotSupported('host-only tools');
      if (options.reviewMode || options.extraDirs?.length) this.throwNotSupported('read-only workspace scope');
      if (options.planMode || options.writableDirs?.length) this.throwNotSupported('workspace/plan configuration', 'not-implemented');
      let permissionMode = options.permissionMode ?? 'ask';
      const initialMode = nativePermissionMode(permissionMode);
      const authOptions = { providerId: options.providerId, model: options.model };
      if (!(await this.deps.auth.getState(authOptions)).authenticated) throw new AgentNotAuthenticatedError(this.kind);
      const authEnv = await this.deps.auth.getAuthEnv(authOptions);
      const ownerMemory = options.makerMemorySwitchOwned || options.makerMemoryScopeKey?.startsWith('bot:');
      const memoryEnabled = (options.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled ?? false)
        && (ownerMemory || (this.memoryOverride ?? true));
      const memoryScopeKey = options.makerMemoryScopeKey ?? (memoryEnabled
        ? await resolveMemoryScopeKey(options.workingDir) : options.workingDir);
      const memory = memoryEnabled ? await loadMemoryContext({ manager: this.deps.makerMemory, scopeKey: memoryScopeKey,
        snapshot: options.makerMemoryIndexSnapshot, projectDirectory: options.makerMemoryProjectDir }) : undefined;
      if (this.deps.preparePiExtraSpawnConfig) {
        bridge = await this.deps.preparePiExtraSpawnConfig(this.deps.mcpProviders ?? [], {
          agentKind: this.kind, sessionId: options.sessionId, sessionInstanceId: options.sessionInstanceId,
          workingDir: options.workingDir, memoryScopeKey,
          memoryEnabled: Boolean(memoryEnabled), vendorOptions: options.vendorOptions,
          // 原生子任务的 MCP 身份隔离尚无回执，不能把继承的工具请求认证成 root。
          mcpCallerKind: 'unknown', mcpCallerAttested: false,
        });
      }
      if (this.deps.mcpProviders?.length && !bridge?.mcpBridge) throw new Error('Antigravity host MCP bridge is unavailable');
      skills = await AntigravityManagedSkills.create(this.deps, options);
      const servers = bridgeServers(bridge);
      const append = [this.deps.runtimeConfig.answerDeliveryPrompt, options.botProfilePrompt,
        this.deps.runtimeConfig.systemPrompt, this.deps.getGhostRosterPrompt?.({ workingDir: options.workingDir }),
        options.botProfileContextPrompt, memory?.rules, memory?.index, options.botUserProfilePrompt,
        options[TASK_SYSTEM_PROMPT], options.userPrompt].filter(text => text !== undefined && text !== '').join('\n\n');
      let resolver: InteractionResolver | undefined;
      let turnAttemptToken: number | undefined;
      const translator = new AntigravityTranslator(options.workingDir, event => {
        queue.push({ ...event, source: this.kind, ...(turnAttemptToken === undefined ? {} : { turnAttemptToken }) });
      });
      finishOnExit = () => {
        if (aborting) translator.complete({ stopReason: 'cancelled' });
        else translator.fail(new Error('Antigravity process exited before the turn completed'));
      };
      native = new AntigravityProcess({ binaryPath: this.deps.binaryPath, cwd: options.workingDir,
        ...(skills ? { skillDirectory: skills.directory } : {}),
        env: { ...process.env, ...authEnv,
          ...(options.sessionId ? this.deps.runtimeConfig.taskShellEnv?.({ sessionId: options.sessionId }) : {}),
          AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } });
      releaseAfterExit = native.whenStopped.then(release);
      await native.started;
      client = new AntigravityClient(native.stream, {
        update: notification => translator.update(notification.update),
        complete: result => translator.complete(result),
        error: error => {
          // 取消时断开传输不是执行失败；取消回执或进程退出负责最终收口。
          if (!aborting) translator.fail(error);
        },
        permission: (request, signal) => requestPermission(request, signal, resolver),
      });
      const connection = client;
      const processOwner = native;
      const stopped = releaseAfterExit;
      const id = await connection.openSession({ cwd: options.workingDir, mcpServers: servers,
        ...(append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {}) }, options.resumeSessionId);
      await connection.setOption('model', options.model);
      if (options.effort) await connection.setOption('thought_level', options.effort);
      await connection.setOption('mode', initialMode);
      let model = antigravityCurrentModel(connection.configOptions);
      const promptCapabilities = (await connection.initialize()).agentCapabilities?.promptCapabilities ?? {};
      let preparing: AbortController | undefined;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        preparing?.abort();
        if (released) return stopped;
        if (!closing) closing = (async () => {
          try { await connection.closeSession(); }
          catch {
            // session/close 丢失回执时继续物理关闭；只有进程退出才能释放租约。
            this.deps.logger.warn('Antigravity session close unconfirmed; stopping owned process');
          } finally { connection.close(); }
          await processOwner.close();
          await stopped;
        })();
        return closing;
      };
      const configure = async (id: string, value: string): Promise<void> => {
        try { await connection.setOption(id, value); }
        catch (error) {
          if (connection.needsRestart) {
            try { await close(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Antigravity configuration failed and process exit is unconfirmed'); }
          }
          throw error;
        }
      };
      const validateSendOptions = (send: SendOptions) => {
        if (send.turnPermissionPolicy || send.toolsDisabled) throw new TurnPermissionPolicyUnsupportedError(this.kind, permissionMode);
        if (send.planMode) this.throwNotSupported('plan mode', 'not-implemented');
      };
      return {
        id, agentKind: this.kind, get model() { return model.id; },
        get disabledSkillPaths() { return skills?.disabledPaths; },
        events: () => queue, getUsageSnapshot: () => translator.snapshot(),
        setInteractionResolver: next => { resolver = next; },
        isTurnRunning: () => preparing !== undefined || translator.isTurnRunning(),
        hasPendingHostOperation: () => preparing !== undefined || connection.busy,
        // 尚无原生后台任务枚举，不能根据当前轮次空闲误回收它们。
        hasLiveBackgroundWork: async () => true,
        validateSendOptions,
        send: async (message, send = {}) => {
          validateSendOptions(send);
          if (closing || released || preparing || connection.busy) throw new TurnDispatchRejectedError('Antigravity session is not ready');
          if (send.signal?.aborted) throw new TurnDispatchRejectedError('Antigravity input was cancelled before dispatch');
          preparing = new AbortController();
          const signal = send.signal ? AbortSignal.any([preparing.signal, send.signal]) : preparing.signal;
          try {
            await skills?.refresh();
            const prompt = await buildAntigravityPrompt(message, options.workingDir, promptCapabilities, signal);
            if (signal.aborted) throw new TurnDispatchRejectedError('Antigravity input was cancelled before dispatch');
            if (closing || released) throw new TurnDispatchRejectedError('Antigravity session is not ready');
            turnAttemptToken = send.turnAttemptToken;
            translator.beginTurn(model.id);
            try { await connection.send(prompt); }
            catch (error) { if (!aborting) translator.fail(error); throw error; }
          } finally { preparing = undefined; }
        },
        steer: async () => this.throwNotSupported('same-turn steering', 'not-implemented'),
        abort: async () => {
          preparing?.abort();
          aborting = true;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const cancelled = await Promise.race([connection.cancel().then(() => true, error => {
              this.deps.logger.warn('Antigravity cancellation unconfirmed; stopping owned process', { error });
              return false;
            }),
              new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
            if (!cancelled) {
              await close();
              translator.complete({ stopReason: 'cancelled' });
            }
          } finally { if (!closing) aborting = false; if (timer) clearTimeout(timer); }
        },
        close,
        setModel: async (value, config) => {
          await configure('model', value);
          model = antigravityCurrentModel(connection.configOptions);
          if (config?.effort) await configure('thought_level', config.effort);
          model = antigravityCurrentModel(connection.configOptions);
        },
        setEffort: async value => {
          await configure('thought_level', value);
          model = antigravityCurrentModel(connection.configOptions);
        },
        getEffort: () => model.defaultEffort,
        setPermissionMode: async value => {
          await configure('mode', nativePermissionMode(value));
          permissionMode = value;
        },
        getAutoReviewOwner: () => 'native',
      };
    } catch (cause) {
      client?.close();
      if (native) {
        try { await native.close(); await releaseAfterExit; }
        catch (cleanupError) {
          throw new AgentStartupCleanupPendingError('Antigravity startup failed and process exit is unconfirmed', {
            cause: new AggregateError([cause, cleanupError], 'Antigravity startup cleanup failed'),
            whenStopped: releaseAfterExit!,
          });
        }
      } else await release();
      if (cause instanceof AgentNotAuthenticatedError) throw cause;
      throw new AgentStartupStoppedError(cause);
    }
  }
}

function nativePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'ask': case 'default': return 'default';
    case 'acceptEdits': return 'accept-edits';
    case 'auto': return 'auto';
    default: throw new Error(`Antigravity does not support permission mode: ${mode}`);
  }
}

function bridgeServers(extra: PiExtraSpawnConfig | null): McpServer[] {
  if (!extra?.mcpBridge) return [];
  const bridge = extra.mcpBridge;
  return bridge.servers.map(server => ({
    type: 'http', name: server.name, url: server.url,
    headers: server.remote ? Object.entries(server.remote.headerEnvVars).map(([name, variable]) => {
      const value = extra.mcpEnv?.[variable];
      if (value === undefined) throw new Error(`Antigravity MCP header binding is missing for ${server.name}`);
      return { name, value };
    }) : [{ name: 'Authorization', value: `Bearer ${bridge.token}` }],
  }));
}

async function requestPermission(request: RequestPermissionRequest, signal: AbortSignal,
  resolver: InteractionResolver | undefined): Promise<RequestPermissionResponse> {
  if (!resolver || signal.aborted) return { outcome: { outcome: 'cancelled' } };
  const tool = request.toolCall;
  const input = typeof tool.rawInput === 'object' && tool.rawInput !== null ? tool.rawInput as Record<string, unknown> : {};
  const decision = await resolver({ kind: 'permission', requestId: randomUUID(), toolUseId: tool.toolCallId,
    toolName: tool.title ?? tool.toolCallId, title: tool.title ?? undefined,
    input,
  }, signal);
  if (signal.aborted || decision.kind !== 'permission') return { outcome: { outcome: 'cancelled' } };
  // ACP 的批准回执不能修改工具参数，不能把修改后的授权套用到原始调用。
  if (decision.updatedInput && !isDeepStrictEqual(decision.updatedInput, input)) return { outcome: { outcome: 'cancelled' } };
  const kind = decision.behavior === 'allow' ? 'allow_once' : 'reject_once';
  const option = request.options.find(value => value.kind === kind);
  if (!option) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}
