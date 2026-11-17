import { agent, RequestError, type AgentConnection, type SessionConfigOption, type NewSessionRequest, type ResumeSessionRequest, type RequestPermissionResponse, type PromptRequest } from '@agentclientprotocol/sdk';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityAgent } from './index.js';
import { AntigravityProcess } from './process.js';
import { AntigravityRuntime } from './runtime.js';
import { LOCAL_AGENT_CLIENT, TASK_SYSTEM_PROMPT, type AgentDeps } from '../base-agent.js';
import { createConsoleLogger } from '../../interfaces/logger.js';

// 生产入口：完整 Agent adapter。保护恢复身份、宿主工具/指令、关闭后桥租约释放。
// 协议单测不经过 AgentDeps 与 handle；最小输入为一个恢复任务和一次带工具的文本轮次。
// tier：unit，真实 ACP 双向内存流，只替换 OS 进程边界。
vi.mock('./process.js', () => ({ AntigravityProcess: vi.fn() }));
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(runtime?: { openError?: Error; catalog?: boolean; permission?: boolean; images?: boolean; deferFirstEvent?: boolean }) {
  const up = new TransformStream();
  const down = new TransformStream();
  const stopped = deferred<void>();
  const closeRequested = deferred<void>();
  const open = vi.fn<(request: NewSessionRequest | ResumeSessionRequest) => void>();
  const received = deferred<void>();
  const prompt = vi.fn<(request: PromptRequest) => void>();
  const permissionResult = deferred<RequestPermissionResponse>();
  const response = deferred<{ stopReason: 'end_turn' }>();
  let config: SessionConfigOption[] = [
    { id: 'model', name: 'Model', type: 'select', currentValue: 'gemini-4-argon', options: [{ value: 'gemini-4-argon', name: 'Argon' }, ...(runtime?.catalog ? [{ value: 'gemini-3.8-flash', name: 'Flash' }] : [])] },
    { id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'auto', name: 'Auto' }] },
  ];
  const peer: AgentConnection = agent({ name: 'Antigravity' })
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: runtime?.images ?? false }, sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true }, _meta: { antigravity: { systemPrompt: { append: true } } } } }))
    .onRequest('session/new', ({ params }) => {
      open(params);
      if (runtime?.openError) throw runtime.openError;
      return { sessionId: 'native-1', configOptions: config };
    })
    .onRequest('session/resume', ({ params }) => { open(params); return { configOptions: config }; })
    .onRequest('session/set_config_option', ({ params }) => {
      const value = String(params.value);
      config = config.map(option => option.id === params.configId && option.type === 'select' ? { ...option, currentValue: value } : option);
      if (runtime?.catalog && params.configId === 'model') {
        config = config.filter(option => option.id !== 'thought_level');
        if (value === 'gemini-4-argon') config.push({ id: 'thought_level', name: 'Thinking', type: 'select',
          currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] });
      }
      return { configOptions: config };
    })
    .onRequest('session/prompt', async ({ client, params }) => {
      prompt(params);
      received.resolve();
      if (runtime?.deferFirstEvent) await response.promise;
      if (runtime?.permission) permissionResult.resolve(await client.request('session/request_permission', {
        sessionId: 'previous-native', toolCall: { toolCallId: 'write-1', title: 'Write file', rawInput: { path: 'original.txt' } },
        options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }],
      }));
      await client.notify('session/update', { sessionId: 'previous-native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued' } } });
      return response.promise;
    })
    .onRequest('session/close', () => ({}))
    .connect({ readable: up.readable, writable: down.writable });
  const native = {
    started: Promise.resolve(), stream: { writable: up.writable, readable: down.readable },
    whenStopped: stopped.promise, pid: 123,
    close: vi.fn(() => { closeRequested.resolve(); return stopped.promise; }),
  };
  vi.mocked(AntigravityProcess).mockImplementation(function () { return native as unknown as AntigravityProcess; });
  const dispose = vi.fn();
  const deps: AgentDeps = {
    binaryPath: '/native/agy', logger: createConsoleLogger('test'),
    runtimeConfig: { systemPrompt: 'Existing host instructions' },
    auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}),
      triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
    preparePiExtraSpawnConfig: vi.fn(async () => ({
      mcpBridge: { token: 'test-only-token', servers: [{ name: 'tools', url: 'http://127.0.0.1:12345/mcp' }] },
      disposeSessionCtx: dispose,
    })),
  };
  const adapter = new AntigravityAgent(deps);
  cleanup.push(() => { stopped.resolve(); peer.close(); });
  return { adapter, deps, open, dispose, native, stopped, closeRequested, received, response, permissionResult, prompt };
}

describe('Antigravity Agent adapter', () => {
  it('refreshes managed Skill activation before dispatch and releases its projection only after exit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-agy-skills-test-'));
    const source = path.join(root, 'skill');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture\n---\nSkill instructions');
    await fs.writeFile(path.join(source, 'resource.txt'), 'Skill resource');
    const s = setup();
    let disabled: string[] = [];
    s.deps.getDisabledSkillPaths = () => disabled;
    s.deps.getManagedSkills = async () => [{ kind: 'agent-skill', name: 'fixture', source: 'skill', scope: 'user',
      path: path.join(source, 'SKILL.md'), enabled: true, claudeCommandName: 'cindy:fixture' }];
    s.deps.scanLocalCustomizations = async () => ({ items: [], errors: [] });
    try {
      const handle = await s.adapter.startSession({ workingDir: root, model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
      const launch = vi.mocked(AntigravityProcess).mock.calls.at(-1)![0] as { skillDirectory?: string };
      expect(launch.skillDirectory).toBeTruthy();
      const skillsRoot = path.join(launch.skillDirectory!, '.agents', 'skills');
      const mounted = await fs.readdir(skillsRoot);
      expect(mounted).toHaveLength(1);
      expect(await fs.readFile(path.join(skillsRoot, mounted[0]!, 'resource.txt'), 'utf8')).toBe('Skill resource');
      expect((await s.adapter.listAgentSkills({ workingDir: root })).skills).toHaveLength(1);
      disabled = [source];
      s.response.resolve({ stopReason: 'end_turn' });
      await handle.send({ type: 'user', content: 'Read current skills' });
      expect(await fs.readdir(skillsRoot)).toEqual([]);
      expect((await s.adapter.listCustomizations({ workingDirs: [root] })).items).toHaveLength(1);
      expect((await s.adapter.listAgentSkills({ workingDir: root })).skills).toEqual([]);
      await new Promise(resolve => setTimeout(resolve, 0));
      disabled = [];
      await handle.send({ type: 'user', content: 'Read enabled skills' });
      expect(await fs.readdir(skillsRoot)).toHaveLength(1);
      const closing = handle.close();
      await s.closeRequested.promise;
      expect(await fs.stat(skillsRoot)).toBeDefined();
      s.stopped.resolve();
      await closing;
      await expect(fs.stat(launch.skillDirectory!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(source, 'resource.txt'), 'utf8')).toBe('Skill resource');
    } finally {
      s.stopped.resolve();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('settles a timed-out cancellation only after physical exit (unconfirmed=%s)', async (deferFirstEvent) => {
    const s = setup({ deferFirstEvent });
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
    const events: Array<{ type: string; data: unknown }> = [];
    const consumed = (async () => { for await (const event of handle.events()) events.push(event); })();
    const sent = handle.send({ type: 'user', content: 'Continue' }).catch(error => error);
    await s.received.promise;
    if (!deferFirstEvent) await sent;
    vi.useFakeTimers();
    const cancelled = handle.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await s.closeRequested.promise;
    const terminalBeforeExit = events.filter(event => event.type === 'done' || event.type === 'error');
    expect(s.dispose).not.toHaveBeenCalled();
    s.stopped.resolve();
    await cancelled;
    await sent;
    await consumed;
    expect(terminalBeforeExit).toEqual([]);
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events.filter(event => event.type === 'done')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ cancelled: true }) }),
    ]);
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it('preserves ordered image, file, mention and managed attachment identities in the native prompt', async () => {
    const s = setup({ images: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfN8AAAAASUVORK5CYII=', 'base64');
    vi.spyOn(fs, 'readFile').mockResolvedValue(bytes);
    const cwd = path.resolve('/workspace');
    const handle = await s.adapter.startSession({ workingDir: cwd, model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
    await handle.send({ type: 'user', content: [
      { type: 'text', text: 'Continue with these references' },
      { type: 'image', path: 'screen.png', managedUrl: 'cindy-media://blobs/test-image' },
      { type: 'file', path: 'design #1.pdf', mimeType: 'application/pdf' },
      { type: 'mention', path: 'src', name: 'Source', kind: 'dir' },
    ] });
    expect(s.prompt.mock.calls[0][0].prompt).toEqual([
      { type: 'text', text: 'Continue with these references' },
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
      { type: 'resource_link', uri: pathToFileURL(path.join(cwd, 'design #1.pdf')).href, name: 'design #1.pdf', mimeType: 'application/pdf' },
      { type: 'resource_link', uri: pathToFileURL(path.join(cwd, 'src')).href, name: 'Source' },
      { type: 'text', text: expect.stringContaining('cindy-media://blobs/test-image') },
    ]);
    s.response.resolve({ stopReason: 'end_turn' });
    const close = handle.close(); await s.closeRequested.promise; s.stopped.resolve(); await close;
  });

  it('rejects unsupported vision before dispatch and can still send a subsequent text turn', async () => {
    const s = setup();
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
    await expect(handle.send({ type: 'user', content: [{ type: 'image', path: 'screen.png' }] })).rejects.toThrow(/image/i);
    expect(s.prompt).not.toHaveBeenCalled();
    await handle.send({ type: 'user', content: 'Continue' });
    expect(s.prompt).toHaveBeenCalledOnce();
    s.response.resolve({ stopReason: 'end_turn' });
    const close = handle.close(); await s.closeRequested.promise; s.stopped.resolve(); await close;
  });

  it('cancels attachment preparation and rejects a concurrent send before native dispatch', async () => {
    const s = setup({ images: true });
    const read = deferred<Buffer<ArrayBuffer>>();
    vi.spyOn(fs, 'readFile').mockReturnValue(read.promise);
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
    const first = handle.send({ type: 'user', content: [{ type: 'image', path: 'screen.png', mimeType: 'image/png' }] });
    const rejected = first.then(() => undefined, error => error);
    expect(handle.hasPendingHostOperation!()).toBe(true);
    await expect(handle.send({ type: 'user', content: 'Concurrent' })).rejects.toThrow(/not ready/i);
    await handle.abort();
    read.resolve(Buffer.from('image bytes'));
    expect(await rejected).toMatchObject({ message: expect.stringMatching(/cancel/i) });
    expect(s.prompt).not.toHaveBeenCalled();
    expect(handle.hasPendingHostOperation!()).toBe(false);
    const close = handle.close(); await s.closeRequested.promise; s.stopped.resolve(); await close;
  });

  it('routes customization discovery through the host isolation boundary', async () => {
    const s = setup();
    const result = { items: [], errors: [{ path: '/workspace/.agents/skills.json', message: 'Invalid manifest' }] };
    s.deps.scanLocalCustomizations = vi.fn(async () => result);
    const options = { workingDirs: ['/workspace'], kinds: ['skill'] };
    expect(await s.adapter.listCustomizations(options)).toBe(result);
    expect(s.deps.scanLocalCustomizations).toHaveBeenCalledWith('antigravity', options);
    expect(AntigravityProcess).not.toHaveBeenCalled();
  });

  it('reports the model that native accepted even if its subsequent effort selection fails', async () => {
    const s = setup({ catalog: true });
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon' });
    await expect(handle.setModel!('gemini-3.8-flash', { effort: 'high' })).rejects.toThrow('thought_level');
    expect(handle.model).toBe('gemini-3.8-flash');
    expect(handle.getEffort!()).toBeNull();
    const close = handle.close();
    await s.closeRequested.promise; s.stopped.resolve(); await close;
  });

  it.each([
    [{ path: 'original.txt' }, 'selected'],
    [{ path: 'edited.txt' }, 'cancelled'],
  ])('does not approve the original tool input when approval changes its arguments: %j', async (updatedInput, outcome) => {
    const s = setup({ permission: true });
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
    handle.setInteractionResolver!(async () => ({ kind: 'permission', behavior: 'allow', updatedInput }));
    await handle.send({ type: 'user', content: 'Write a file' });
    expect((await s.permissionResult.promise).outcome.outcome).toBe(outcome);
    s.response.resolve({ stopReason: 'end_turn' });
    const close = handle.close();
    await s.closeRequested.promise; s.stopped.resolve(); await close;
  });

  it('resumes the native identity, delivers host instructions and publishes native events', async () => {
    const s = setup();
    const handle = await s.adapter.startSession({ sessionId: 'cindy-task', sessionInstanceId: 'instance-1',
      workingDir: '/workspace', model: 'gemini-4-argon', resumeSessionId: 'previous-native',
      permissionMode: 'auto', [TASK_SYSTEM_PROMPT]: 'Existing task instructions' });
    expect(handle.id).toBe('previous-native');
    const request = s.open.mock.calls[0][0];
    expect(request.mcpServers).toEqual([{ type: 'http', name: 'tools', url: 'http://127.0.0.1:12345/mcp', headers: [{ name: 'Authorization', value: 'Bearer test-only-token' }] }]);
    expect(request._meta).toMatchObject({ antigravity: { systemPrompt: { append: expect.stringContaining('Existing task instructions') } } });
    const events = handle.events()[Symbol.asyncIterator]();
    await handle.send({ type: 'user', content: 'Continue' });
    expect(handle.isTurnRunning?.()).toBe(true);
    expect((await events.next()).value).toMatchObject({ type: 'status', source: 'antigravity', data: { isRunning: true } });
    expect((await events.next()).value).toMatchObject({ type: 'text', source: 'antigravity', data: { text: 'Continued' } });
    s.response.resolve({ stopReason: 'end_turn' });
    expect((await events.next()).value).toMatchObject({ type: 'done', source: 'antigravity' });
    expect(handle.isTurnRunning?.()).toBe(false);
    const closing = handle.close();
    await s.closeRequested.promise;
    expect(s.dispose).not.toHaveBeenCalled();
    s.stopped.resolve(); await closing;
    expect(s.dispose).toHaveBeenCalledOnce();
    expect((await events.next()).done).toBe(true);
  });

  it('retains the bridge lease when startup cleanup is unconfirmed', async () => {
    const s = setup();
    s.native.close.mockRejectedValue(new Error('process still running'));
    const error = await s.adapter.startSession({ workingDir: '/workspace', model: 'missing-model' }).catch(error => error);
    expect(error).toMatchObject({ name: 'AgentStartupCleanupPendingError' });
    expect(s.dispose).not.toHaveBeenCalled();
    s.stopped.resolve(); await error.whenStopped;
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it('refuses a remote filesystem scope before spawning locally', async () => {
    const s = setup();
    const error = await s.adapter.startSession({ workingDir: '/remote', model: 'gemini-4-argon', remoteHostId: 'remote' }).catch(error => error);
    expect(error).toMatchObject({ name: 'AgentStartupStoppedError' });
    expect(AntigravityProcess).not.toHaveBeenCalled();
  });

  it('does not replace a host-tools-only grant with unrestricted native tools', async () => {
    const s = setup();
    const pending = s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon',
      [LOCAL_AGENT_CLIENT]: { url: 'http://127.0.0.1:12345/mcp', token: 'test-only', hostToolsOnly: true } })
      .then(() => null, error => error);
    // 未拒绝时仍关闭 fake native，避免把泄漏本身变成测试超时。
    await Promise.resolve();
    const result = await pending;
    s.stopped.resolve();
    expect(result).toMatchObject({ name: 'AgentStartupStoppedError' });
    expect(AntigravityProcess).not.toHaveBeenCalled();
  });

  it('publishes a terminal error before ending the event stream after an unexpected exit', async () => {
    const s = setup();
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon', resumeSessionId: 'previous-native' });
    const events = handle.events()[Symbol.asyncIterator]();
    await handle.send({ type: 'user', content: 'Continue' });
    expect((await events.next()).value).toMatchObject({ type: 'status', data: { isRunning: true } });
    await events.next();
    s.stopped.resolve();
    expect((await events.next()).value).toMatchObject({ type: 'error', data: { isTerminal: true } });
    expect(handle.isTurnRunning?.()).toBe(false);
    expect((await events.next()).done).toBe(true);
  });

  it('accepts late physical exit as cleanup proof after an earlier close failure', async () => {
    const s = setup();
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon' });
    s.native.close.mockRejectedValue(new Error('exit not confirmed'));
    await expect(handle.close()).rejects.toThrow('exit not confirmed');
    expect(s.dispose).not.toHaveBeenCalled();
    s.stopped.resolve();
    await Promise.resolve();
    await expect(handle.close()).resolves.toBeUndefined();
    expect(s.dispose).toHaveBeenCalledOnce();
  });

  it('keeps frozen memory and plugin instructions in the native startup prompt', async () => {
    const s = setup();
    s.deps.getGhostRosterPrompt = () => 'Existing plugin roster';
    const handle = await s.adapter.startSession({ workingDir: '/workspace', model: 'gemini-4-argon',
      makerMemoryEnabled: true, makerMemoryScopeKey: 'frozen-scope', makerMemoryIndexSnapshot: 'Frozen memory bytes',
      userPrompt: 'User preferences' });
    const meta = s.open.mock.calls[0][0]._meta as { antigravity: { systemPrompt: { append: string } } };
    expect(meta.antigravity.systemPrompt.append).toContain('Frozen memory bytes');
    expect(meta.antigravity.systemPrompt.append).toContain('Existing plugin roster');
    expect(meta.antigravity.systemPrompt.append).toContain('User preferences');
    expect(s.deps.preparePiExtraSpawnConfig).toHaveBeenCalledWith([], expect.objectContaining({
      memoryEnabled: true, memoryScopeKey: 'frozen-scope', sessionInstanceId: undefined,
    }));
    const close = handle.close();
    await s.closeRequested.promise;
    s.stopped.resolve(); await close;
  });
});

// 同一原生进程边界下验证目录/认证探测：Agent 会话测试不覆盖无 prompt 的宿主发现。
// 最小输入为不同思考档位的两个模型、未登录回执和非认证错误；tier：unit。
describe('Antigravity runtime discovery', () => {
  const options = { binaryPath: '/native/agy', cwd: '/workspace', env: {} };

  it('reads each model configuration without inference and waits for physical cleanup', async () => {
    const s = setup({ catalog: true });
    let settled = false;
    const pending = new AntigravityRuntime(options).inspect().then(result => { settled = true; return result; }, (error: unknown) => { settled = true; return { error }; });
    await Promise.race([s.closeRequested.promise, pending]);
    expect(settled).toBe(false);
    expect(s.open).toHaveBeenCalledExactlyOnceWith({ cwd: '/workspace', mcpServers: [] });
    s.stopped.resolve();
    const result = await pending;
    if ('error' in result) throw result.error;
    expect(result.auth.authenticated).toBe(true);
    expect(result.defaultModel).toBe('gemini-4-argon');
    expect(result.models.map(model => [model.id, model.efforts, model.defaultEffort])).toEqual([
      ['gemini-4-argon', ['low', 'medium'], 'medium'], ['gemini-3.8-flash', [], null],
    ]);
  });

  it.each([
    [RequestError.authRequired(), false],
    [new RequestError(-32603, 'native service unavailable'), true],
  ])('distinguishes missing authentication from a failed native service: %s', async (error, shouldThrow) => {
    const s = setup({ openError: error });
    const pending = new AntigravityRuntime(options).inspect().then(value => ({ value }), error => ({ error }));
    await Promise.race([s.closeRequested.promise, pending]);
    s.stopped.resolve();
    const result = await pending;
    if (shouldThrow) expect(result).toMatchObject({ error: { message: expect.stringContaining('native service unavailable') } });
    else expect(result).toEqual({ value: { auth: { authenticated: false }, models: [], defaultModel: null } });
  });
});
