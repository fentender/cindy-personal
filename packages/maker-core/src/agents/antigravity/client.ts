import { client, RequestError, type Stream, type ClientConnection, type ContentBlock, type NewSessionRequest,
  type SessionNotification, type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse,
  type SessionConfigOption, type InitializeResponse } from '@agentclientprotocol/sdk';
import { TurnDispatchRejectedError, TurnDispatchUnconfirmedError } from '../base-agent.js';
import { assertAntigravitySelection, antigravityChoices } from './config.js';

export interface AntigravityClientCallbacks {
  update(notification: SessionNotification): void;
  complete(result: PromptResponse): void;
  error(error: unknown): void;
  permission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}

interface ActiveTurn {
  accepted: boolean;
  accept(): void;
  reject(error: unknown): void;
  abort: AbortController;
  completed: Promise<PromptResponse | undefined>;
}

/** 一条 ACP 连接只持有一个原生任务；进程退出由注入该流的宿主负责确认。 */
export class AntigravityClient {
  private readonly connection: ClientConnection;
  private sessionId = '';
  private options: SessionConfigOption[] = [];
  private turn?: ActiveTurn;
  private initialization?: Promise<InitializeResponse>;
  private opening = false;
  private configuring = false;
  private closing = false;

  get configOptions(): readonly SessionConfigOption[] { return this.options; }
  get busy(): boolean { return this.turn !== undefined || this.configuring || this.opening; }
  get needsRestart(): boolean { return this.closing || this.connection.signal.aborted; }

  constructor(stream: Stream, private readonly callbacks: AntigravityClientCallbacks) {
    this.connection = client({ name: 'cindy' })
      .onNotification('session/update', ({ params }) => this.handleUpdate(params))
      .onRequest('session/request_permission', ({ params: request }) => {
        const turn = this.turn;
        if (!turn || request.sessionId !== this.sessionId || turn.abort.signal.aborted) {
          return { outcome: { outcome: 'cancelled' } };
        }
        this.accept(turn);
        return this.callbacks.permission(request, turn.abort.signal);
      })
      .connect(stream);
  }

  initialize(): Promise<InitializeResponse> {
    if (this.closing) return Promise.reject(new Error('Antigravity connection is closing'));
    if (!this.initialization) {
      this.initialization = this.connection.agent.request('initialize', {
        protocolVersion: 1, clientInfo: { name: 'cindy', version: '0.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, { cancellationSignal: AbortSignal.timeout(30_000), stopWaitingOnCancel: true }).then(result => {
        if (result.protocolVersion !== 1) throw new Error(`Unsupported Antigravity protocol version: ${result.protocolVersion}`);
        return result;
      });
    }
    return this.initialization;
  }

  async authenticate(signal: AbortSignal): Promise<void> {
    const initialized = await this.initialize();
    if (!initialized.authMethods?.some(method => method.id === 'oauth-personal')) {
      throw new Error('Antigravity does not support personal Google login');
    }
    if (this.busy || this.sessionId || this.closing) throw new Error('Antigravity authentication requires an idle connection');
    this.configuring = true;
    try {
      await this.connection.agent.request('authenticate', { methodId: 'oauth-personal' }, {
        cancellationSignal: signal, stopWaitingOnCancel: true,
      });
    } finally { this.configuring = false; }
  }

  async logout(): Promise<void> {
    if (!(await this.initialize()).agentCapabilities?.auth?.logout) throw new Error('Antigravity does not support logout');
    if (this.busy || this.sessionId || this.closing) throw new Error('Antigravity logout requires an idle connection');
    this.configuring = true;
    try {
      await this.connection.agent.request('logout', {}, {
        cancellationSignal: AbortSignal.timeout(30_000), stopWaitingOnCancel: true,
      });
    } finally { this.configuring = false; }
  }

  async openSession(request: NewSessionRequest, resumeId?: string): Promise<string> {
    if (this.opening || this.sessionId || this.closing) throw new Error('Antigravity connection already has a session or is closing');
    this.opening = true;
    try { return await this.createSession(request, resumeId); }
    finally { this.opening = false; }
  }

  private async createSession(request: NewSessionRequest, resumeId?: string): Promise<string> {
    const capabilities = (await this.initialize()).agentCapabilities;
    if (request.mcpServers.some(server => 'type' in server && server.type === 'http') && !capabilities?.mcpCapabilities?.http) {
      throw new Error('Antigravity HTTP MCP requires agy acp --process-per-session');
    }
    if (request._meta?.antigravity) {
      const extension = capabilities?._meta?.antigravity as { systemPrompt?: { append?: boolean } } | undefined;
      if (extension?.systemPrompt?.append !== true) throw new Error('Antigravity does not support appended system instructions');
    }
    if (resumeId && !capabilities?.sessionCapabilities?.resume) throw new Error('Antigravity does not support native session resume');
    // 恢复过程中的历史重播不再进入 Cindy 已持久化的时间线。
    const control = { cancellationSignal: AbortSignal.timeout(60_000), stopWaitingOnCancel: true };
    const result = resumeId
      ? await this.connection.agent.request('session/resume', { ...request, sessionId: resumeId }, control)
      : await this.connection.agent.request('session/new', request, control);
    this.sessionId = resumeId ?? (result as { sessionId: string }).sessionId;
    this.options = result.configOptions ?? [];
    return this.sessionId;
  }

  send(prompt: ContentBlock[]): Promise<void> {
    if (!this.sessionId || this.connection.signal.aborted || this.busy || this.closing) {
      return Promise.reject(new TurnDispatchRejectedError('Antigravity session is not ready for a new turn'));
    }
    let accept!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
    const turn: ActiveTurn = { accepted: false, accept, reject, abort: new AbortController(), completed: Promise.resolve(undefined) };
    this.turn = turn;
    // ACP prompt 的响应是轮次终态。不能设置空闲超时，也不能把写入管道当作执行确认。
    turn.completed = this.connection.agent.request('session/prompt', { sessionId: this.sessionId, prompt })
      .then(result => {
        this.accept(turn);
        this.finish(turn);
        this.callbacks.complete(result);
        return result;
      }, error => {
        this.finish(turn);
        if (turn.accepted) this.callbacks.error(error);
        else if (error instanceof RequestError && [-32600, -32601, -32602, -32000].includes(error.code)) {
          reject(new TurnDispatchRejectedError(error.message, { cause: error }));
        } else {
          reject(new TurnDispatchUnconfirmedError('Antigravity prompt acceptance could not be confirmed', { cause: error }));
        }
        return undefined;
      });
    return accepted;
  }

  private accept(turn: ActiveTurn): void {
    if (turn.accepted) return;
    turn.accepted = true;
    turn.accept();
  }

  private finish(turn: ActiveTurn): void {
    turn.abort.abort();
    if (this.turn === turn) this.turn = undefined;
  }

  private handleUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.sessionId) return;
    if (notification.update.sessionUpdate === 'config_option_update') {
      this.options = notification.update.configOptions;
    }
    const turn = this.turn;
    if (!turn) return;
    switch (notification.update.sessionUpdate) {
      case 'agent_message_chunk': case 'agent_thought_chunk': case 'tool_call': case 'tool_call_update':
        this.accept(turn);
    }
    this.callbacks.update(notification);
  }

  async setOption(id: string, value: string): Promise<void> {
    if (this.busy || this.closing) throw new Error('Antigravity session is busy');
    if (!antigravityChoices(this.options, id).some(item => item.value === value)) {
      throw new Error(`Unsupported Antigravity ${id}: ${value}`);
    }
    this.configuring = true;
    try {
      const result = await this.connection.agent.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value }, {
        cancellationSignal: AbortSignal.timeout(30_000), stopWaitingOnCancel: true,
      });
      this.options = result.configOptions;
      assertAntigravitySelection(this.options, id, value);
    } catch (error) {
      // 请求已发出后缺少有效回执，原生模型或权限状态未知，不能继续发送。
      this.close();
      throw error;
    } finally {
      this.configuring = false;
    }
  }

  async cancel(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.abort.abort();
    await this.connection.agent.notify('session/cancel', { sessionId: this.sessionId });
    const result = await turn.completed;
    if (!result) throw new Error('Antigravity cancellation has no native completion receipt');
  }

  async closeSession(): Promise<void> {
    this.closing = true;
    if (this.sessionId && !this.connection.signal.aborted) {
      await this.connection.agent.request('session/close', { sessionId: this.sessionId }, {
        cancellationSignal: AbortSignal.timeout(5_000), stopWaitingOnCancel: true,
      });
      this.sessionId = '';
    }
  }

  close(): void {
    this.closing = true;
    this.connection.close();
  }
}
