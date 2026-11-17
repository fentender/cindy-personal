import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityRuntime, type AuthAdapter, type AuthAdapterOptions, type AuthState } from '@cindy/maker-core';
import type { CatalogModel } from '@cindy/model-providers';
import { activeDataOwnerId, isOwnerBoundaryPending, ownerGeneration } from '../ownerContext.js';
import {
  bindNativeProviderAuth, captureNativeProviderAuthorizationGeneration,
  claimDetectedNativeProviderAuth, isNativeProviderAuthBound, isNativeProviderAuthRevoked,
  unbindNativeProviderAuth,
} from './nativeProviderAuthBinding.js';
import type { ConnectionReadOptions } from './provider-service.js';
import { setDiscoveredProviderModels } from './active-catalog.js';

const AUTH_SNAPSHOT_TTL_MS = 30_000;

/** 发现用户安装的原生 CLI，不使用 Cindy 的其它引擎下载清单。 */
export function resolveAntigravityBinary(): string | undefined {
  const name = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const directories = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ...(process.platform === 'win32'
      ? process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'agy', 'bin')] : []
      : [path.join(os.homedir(), '.local', 'bin')]),
  ];
  for (const directory of directories) {
    const candidate = path.resolve(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw error;
    }
  }
  return undefined;
}

/** 原生授权归属和发现缓存；不持有 CLI 的令牌，也不把它翻译为 API 密钥。 */
export function createAntigravityHost(ports: { publishModels(models: CatalogModel[]): void }) {
  let snapshot: { owner: string; generation: number; authorization: string | null; at: number; auth: AuthState } | undefined;
  let pending: { owner: string; generation: number; authorization: string | null; operation: Promise<boolean> } | undefined;
  let login: { controller: AbortController; owner: string; generation: number } | undefined;

  function sameOwner(owner: string, generation: number): boolean {
    return !isOwnerBoundaryPending() && activeDataOwnerId() === owner && ownerGeneration() === generation;
  }

  function runtime(): AntigravityRuntime {
    const binaryPath = resolveAntigravityBinary();
    if (!binaryPath) throw new Error('Antigravity CLI is not installed');
    return new AntigravityRuntime({ binaryPath, cwd: os.homedir(), env: process.env });
  }

  function currentSnapshot(): AuthState | undefined {
    if (!snapshot || !sameOwner(snapshot.owner, snapshot.generation) ||
      !isNativeProviderAuthBound('antigravity') ||
      captureNativeProviderAuthorizationGeneration('antigravity') !== snapshot.authorization) return undefined;
    return snapshot.auth;
  }

  async function readConnection(options: Partial<ConnectionReadOptions> = {}): Promise<boolean> {
    const owner = activeDataOwnerId();
    const generation = ownerGeneration();
    if (!owner || isOwnerBoundaryPending() || isNativeProviderAuthRevoked('antigravity')) return false;
    const cached = currentSnapshot();
    if (cached && (options.snapshotOnly || Date.now() - snapshot!.at < AUTH_SNAPSHOT_TTL_MS)) return cached.authenticated;
    if (options.snapshotOnly || (!options.allowSideEffects && !isNativeProviderAuthBound('antigravity'))) return false;
    if (!resolveAntigravityBinary()) return false;
    const authorization = captureNativeProviderAuthorizationGeneration('antigravity');
    if (pending?.owner === owner && pending.generation === generation && pending.authorization === authorization) return pending.operation;
    const operation = (async () => {
      const result = await runtime().inspect();
      // 探测期间的账号切换、主动断开或重新授权使旧回执失效。
      if (!sameOwner(owner, generation) || isNativeProviderAuthRevoked('antigravity') ||
        captureNativeProviderAuthorizationGeneration('antigravity') !== authorization) return false;
      if (result.auth.authenticated && options.allowSideEffects && !isNativeProviderAuthBound('antigravity')) {
        claimDetectedNativeProviderAuth('antigravity', () => true);
      }
      if (!isNativeProviderAuthBound('antigravity')) return false;
      snapshot = { owner, generation, at: Date.now(), auth: result.auth,
        authorization: captureNativeProviderAuthorizationGeneration('antigravity') };
      ports.publishModels(result.auth.authenticated ? result.models.map(model => ({
        id: model.id, name: model.displayName, contextWindow: model.contextWindow,
        contextWindowVerified: false, efforts: [...model.efforts], defaultEffort: model.defaultEffort,
        ...(model.effortDisplayNames ? { effortDisplayNames: model.effortDisplayNames } : {}),
      })) : []);
      return result.auth.authenticated;
    })();
    pending = { owner, generation, authorization, operation };
    try { return await operation; }
    finally { if (pending?.operation === operation) pending = undefined; }
  }

  function assertNativeRoute(options?: AuthAdapterOptions): void {
    if (options?.providerId && options.providerId !== 'antigravity') {
      throw new Error('Antigravity requires its native subscription provider');
    }
  }

  function disconnect(): void {
    // 系统 CLI 与 Cindy 共用登录；断开只撤销 Cindy 的使用许可。
    unbindNativeProviderAuth('antigravity', { revoked: true });
    snapshot = undefined;
    ports.publishModels([]);
  }

  const auth: AuthAdapter = {
    async getState(options) {
      assertNativeRoute(options);
      return { authenticated: await readConnection() };
    },
    async getAuthEnv(options) {
      assertNativeRoute(options);
      if (!isNativeProviderAuthBound('antigravity') || isOwnerBoundaryPending()) {
        throw new Error('Antigravity is not authorized for the current owner');
      }
      return {};
    },
    async triggerLogin() {
      if (login) throw new Error('Antigravity login is already running');
      const owner = activeDataOwnerId();
      const generation = ownerGeneration();
      if (!owner || isOwnerBoundaryPending()) throw new Error('Antigravity login requires an active owner');
      const controller = new AbortController();
      const operation = { controller, owner, generation };
      login = operation;
      try {
        const result = await runtime().login(controller.signal);
        if (controller.signal.aborted) return { authenticated: false, errorReason: 'login_cancelled' };
        if (!sameOwner(owner, generation)) throw new Error('Antigravity login owner changed');
        if (!result.authenticated) return result;
        bindNativeProviderAuth('antigravity', { sharedSystem: true });
        snapshot = undefined;
        const authenticated = await readConnection();
        if (controller.signal.aborted) return { authenticated: false, errorReason: 'login_cancelled' };
        return { authenticated, ...(authenticated ? { authSource: 'oauth' as const } : {}) };
      } catch (error) {
        if (controller.signal.aborted) return { authenticated: false, errorReason: 'login_cancelled' };
        throw error;
      } finally { if (login === operation) login = undefined; }
    },
    cancelLogin() {
      if (!login) return;
      login.controller.abort();
      if (sameOwner(login.owner, login.generation)) disconnect();
    },
    async logout() {
      login?.controller.abort();
      disconnect();
    },
    captureCredentialGeneration: () => captureNativeProviderAuthorizationGeneration('antigravity'),
    getOneShotAuth: async () => null,
  };
  return { auth, readConnection };
}

export const nativeAntigravityHost = createAntigravityHost({
  publishModels: models => setDiscoveredProviderModels('antigravity', 'antigravity', models),
});
