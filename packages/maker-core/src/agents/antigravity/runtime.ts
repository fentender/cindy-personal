import type { AuthState } from '../../types/common.js';
import type { ModelDescriptor } from '../../types/capabilities.js';
import { RequestError } from '@agentclientprotocol/sdk';
import { AntigravityProcess, type AntigravityProcessOptions } from './process.js';
import { AntigravityClient } from './client.js';
import { antigravityChoices, antigravityCurrentModel } from './config.js';

export interface AntigravityRuntimeState {
  auth: AuthState;
  models: ModelDescriptor[];
  defaultModel: string | null;
}

/** 宿主通过原生 ACP 检查连接与目录，不读取或复制 CLI 凭证。 */
export class AntigravityRuntime {
  constructor(private readonly options: AntigravityProcessOptions) {}

  async getAuthState(): Promise<AuthState> {
    return this.withClient(client => this.openAuthenticatedSession(client));
  }

  async login(signal: AbortSignal): Promise<AuthState> {
    return this.withClient(async client => {
      await client.authenticate(signal);
      return this.openAuthenticatedSession(client);
    });
  }

  async logout(): Promise<void> {
    await this.withClient(client => client.logout());
  }

  async inspect(): Promise<AntigravityRuntimeState> {
    return this.withClient(async client => {
      const auth = await this.openAuthenticatedSession(client);
      if (!auth.authenticated) return { auth, models: [], defaultModel: null };
      const defaultModel = antigravityCurrentModel(client.configOptions).id;
      const models: ModelDescriptor[] = [];
      // 思考档位会随模型变化，每个型号都使用它自己的配置回执。
      // 发现使用独立会话，切换不会改变任何正在执行的用户任务。
      for (const choice of antigravityChoices(client.configOptions, 'model')) {
        await client.setOption('model', choice.value);
        models.push(antigravityCurrentModel(client.configOptions));
      }
      return { auth, models, defaultModel };
    });
  }

  private async openAuthenticatedSession(client: AntigravityClient): Promise<AuthState> {
    try { await client.openSession({ cwd: this.options.cwd, mcpServers: [] }); }
    catch (error) {
      if (error instanceof RequestError && error.code === -32000) return { authenticated: false };
      throw error;
    }
    return { authenticated: true };
  }

  private async withClient<T>(operation: (client: AntigravityClient) => Promise<T>): Promise<T> {
    const native = new AntigravityProcess(this.options);
    const client = new AntigravityClient(native.stream, {
      update: () => {}, complete: () => {}, error: error => { throw error; },
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });
    try {
      await native.started;
      return await operation(client);
    } finally {
      try { await client.closeSession(); }
      finally { client.close(); await native.close(); }
    }
  }
}
