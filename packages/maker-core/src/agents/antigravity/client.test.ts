import { agent, RequestError, type AgentConnection, type AgentContext, type Stream, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityClient, type AntigravityClientCallbacks } from './client.js';

// 生产入口：ACP 会话连接。保护 dispatch 确认、代次隔离与恢复契约，其他引擎测试不覆盖 ACP。
// 最小输入：已写出但尚未确认的 prompt、断流、错误回执、恢复期间的历史帧。tier：unit，内存双向流。
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const config: SessionConfigOption[] = [{ id: 'model', type: 'select', name: 'Model', currentValue: 'gemini-4-argon', options: [{ value: 'gemini-4-argon', name: 'Argon' }] }];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });

function setup(allowAppend = true, protocolVersion = 1, allowAuth = true) {
  const toServer = new TransformStream();
  const toClient = new TransformStream();
  const stream: Stream = { readable: toClient.readable, writable: toServer.writable };
  const received = deferred<AgentContext>();
  const response = deferred<{ stopReason: 'end_turn' | 'cancelled' }>();
  const end = deferred<void>();
  const configResult = deferred<{ configOptions: SessionConfigOption[] }>();
  const configReceived = deferred<void>();
  const authenticate = vi.fn(async (_request: { params: { methodId: string } }) => ({}));
  const logout = vi.fn(async () => ({}));
  const callbacks: AntigravityClientCallbacks = {
    update: vi.fn(), complete: vi.fn(() => end.resolve()), error: vi.fn(() => end.resolve()),
    permission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
  };
  const native = agent({ name: 'Antigravity' })
    .onRequest('initialize', () => ({ protocolVersion, authMethods: allowAuth ? [{ id: 'oauth-personal', name: 'Log in with Google' }] : [], agentCapabilities: { ...(allowAuth ? { auth: { logout: {} } } : {}), loadSession: true, sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true }, _meta: { antigravity: { systemPrompt: { append: allowAppend } } } } }))
    .onRequest('authenticate', authenticate)
    .onRequest('logout', logout)
    .onRequest('session/new', () => ({ sessionId: 'native-1', configOptions: config }))
    .onRequest('session/resume', async ({ client, params }) => {
      await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' } } });
      return { configOptions: config };
    })
    .onRequest('session/set_config_option', () => { configReceived.resolve(); return configResult.promise; })
    .onNotification('session/cancel', () => { response.resolve({ stopReason: 'cancelled' }); })
    .onRequest('session/prompt', ({ client }) => { received.resolve(client); return response.promise; });
  const peer: AgentConnection = native.connect({ readable: toServer.readable, writable: toClient.writable });
  const connection = new AntigravityClient(stream, callbacks);
  cleanups.push(() => { connection.close(); peer.close(); });
  return { native, peer, connection, callbacks, received, response, end, configResult, configReceived, authenticate, logout,
    disconnect: async () => { peer.close(); await toClient.writable.getWriter().close(); },
  };
}

describe('Antigravity ACP session', () => {
  it('uses the advertised personal Google login without passing credentials and delegates logout to native', async () => {
    const s = setup();
    await s.connection.authenticate(new AbortController().signal);
    expect(s.authenticate.mock.calls[0][0]).toMatchObject({ params: { methodId: 'oauth-personal' } });
    await s.connection.logout();
    expect(s.logout).toHaveBeenCalledOnce();
  });

  it('refuses absent personal-login and logout capabilities without falling back to an API key', async () => {
    const s = setup(true, 1, false);
    await expect(s.connection.authenticate(new AbortController().signal)).rejects.toThrow('personal Google login');
    await expect(s.connection.logout()).rejects.toThrow('logout');
    expect(s.authenticate).not.toHaveBeenCalled();
    expect(s.logout).not.toHaveBeenCalled();
  });

  it('discovers native capabilities before opening a session on the same connection', async () => {
    const s = setup();
    const [first, second] = await Promise.all([s.connection.initialize(), s.connection.initialize()]);
    expect(first).toBe(second);
    expect(first.agentCapabilities?.mcpCapabilities?.http).toBe(true);
    expect(await s.connection.openSession({ cwd: '/workspace', mcpServers: [] })).toBe('native-1');
  });

  it('refuses a protocol version outside the implemented ACP contract', async () => {
    const s = setup(true, 2);
    await expect(s.connection.openSession({ cwd: '/workspace', mcpServers: [] })).rejects.toThrow('protocol version');
  });

  it('waits for native work before confirming dispatch and finishes once', async () => {
    const s = setup();
    await s.connection.openSession({ cwd: '/workspace', mcpServers: [] });
    let accepted = false;
    const sent = s.connection.send([{ type: 'text', text: 'hello' }]).then(() => { accepted = true; });
    await Promise.resolve();
    expect(accepted).toBe(false);
    const ctx = await s.received.promise;
    await ctx.notify('session/update', { sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } });
    await sent;
    expect(s.callbacks.update).toHaveBeenCalledOnce();
    s.response.resolve({ stopReason: 'end_turn' });
    await s.end.promise;
    expect(s.callbacks.complete).toHaveBeenCalledExactlyOnceWith({ stopReason: 'end_turn' });
    expect(s.callbacks.error).not.toHaveBeenCalled();
  });

  it('fences an unconfirmed request when the connection disappears', async () => {
    const s = setup();
    await s.connection.openSession({ cwd: '/workspace', mcpServers: [] });
    const sent = s.connection.send([{ type: 'text', text: 'hello' }]);
    const rejected = expect(sent).rejects.toMatchObject({ code: 'TURN_DISPATCH_UNCONFIRMED' });
    await s.received.promise;
    await s.disconnect();
    await rejected;
    expect(s.callbacks.complete).not.toHaveBeenCalled();
  });

  it('distinguishes a protocol rejection before work from an ambiguous disconnect', async () => {
    const s = setup();
    await s.connection.openSession({ cwd: '/workspace', mcpServers: [] });
    const sent = s.connection.send([{ type: 'text', text: 'hello' }]);
    const rejected = expect(sent).rejects.toMatchObject({ code: 'TURN_DISPATCH_REJECTED' });
    await s.received.promise;
    s.response.reject(RequestError.invalidParams('bad prompt'));
    await rejected;
    expect(s.callbacks.complete).not.toHaveBeenCalled();
  });

  it('resumes the supplied native id and suppresses load replay', async () => {
    const s = setup();
    expect(await s.connection.openSession({ cwd: '/workspace', mcpServers: [] }, 'previous-native')).toBe('previous-native');
    expect(s.callbacks.update).not.toHaveBeenCalled();
  });

  it('refuses startup when required appended instructions cannot be delivered', async () => {
    const s = setup(false);
    await expect(s.connection.openSession({ cwd: '/workspace', mcpServers: [], _meta: { antigravity: { systemPrompt: { append: 'Host instructions' } } } }))
      .rejects.toThrow('does not support appended system instructions');
  });

  it('keeps new prompts out of an unconfirmed model configuration change', async () => {
    const s = setup();
    await s.connection.openSession({ cwd: '/workspace', mcpServers: [] });
    const setting = s.connection.setOption('model', 'gemini-4-argon');
    await s.configReceived.promise;
    const attempted = s.connection.send([{ type: 'text', text: 'hello' }]).then(() => undefined, error => error);
    s.response.resolve({ stopReason: 'end_turn' });
    s.configResult.resolve({ configOptions: config });
    await setting;
    expect(await attempted).toMatchObject({ code: 'TURN_DISPATCH_REJECTED' });
  });

  it('rejects subsequent prompts after a dispatched configuration change times out', async () => {
    const s = setup();
    await s.connection.openSession({ cwd: '/workspace', mcpServers: [] });
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const setting = s.connection.setOption('model', 'gemini-4-argon').catch(error => error);
    await s.configReceived.promise;
    timeout.abort(new DOMException('Configuration timed out', 'TimeoutError'));
    expect(await setting).toBeInstanceOf(Error);
    const attempted = s.connection.send([{ type: 'text', text: 'hello' }]).then(() => undefined, error => error);
    s.response.resolve({ stopReason: 'end_turn' });
    expect(await attempted).toMatchObject({ code: 'TURN_DISPATCH_REJECTED' });
  });

  it('cancels the pending permission interaction before reporting the turn stopped', async () => {
    const s = setup();
    const permissionSeen = deferred<AbortSignal>();
    s.callbacks.permission = async (_request, signal) => {
      permissionSeen.resolve(signal);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { outcome: { outcome: 'cancelled' } };
    };
    await s.connection.openSession({ cwd: '/workspace', mcpServers: [] });
    const sent = s.connection.send([{ type: 'text', text: 'hello' }]);
    const ctx = await s.received.promise;
    const permission = ctx.request('session/request_permission', {
      sessionId: 'native-1', toolCall: { toolCallId: 'command', title: 'Command' },
      options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }],
    });
    const signal = await permissionSeen.promise;
    await sent;
    await s.connection.cancel();
    expect(signal.aborted).toBe(true);
    expect(await permission).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(s.callbacks.complete).toHaveBeenCalledExactlyOnceWith({ stopReason: 'cancelled' });
  });
});
