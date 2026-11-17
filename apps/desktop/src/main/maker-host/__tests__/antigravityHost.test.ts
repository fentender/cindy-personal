import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { AntigravityRuntime, type AntigravityRuntimeState } from '@cindy/maker-core';
import { claimDetectedNativeProviderAuth, bindNativeProviderAuth, unbindNativeProviderAuth } from '../nativeProviderAuthBinding.js';
import { createAntigravityHost } from '../antigravity-host.js';

// 宿主入口验证真实连接投影与 owner 边界；CLI 协议另由 maker-core 协议测试覆盖。
const state = vi.hoisted(() => ({ owner: 'owner-a', generation: 1, bound: false, revoked: false,
  boundary: false, authorization: 'auth-1' }));
vi.mock('../../ownerContext.js', () => ({
  activeDataOwnerId: () => state.owner, ownerGeneration: () => state.generation,
  isOwnerBoundaryPending: () => state.boundary,
}));
vi.mock('../nativeProviderAuthBinding.js', () => ({
  isNativeProviderAuthBound: () => state.bound,
  isNativeProviderAuthRevoked: () => state.revoked,
  captureNativeProviderAuthorizationGeneration: () => state.bound ? state.authorization : null,
  claimDetectedNativeProviderAuth: vi.fn(() => { state.bound = true; return true; }),
  bindNativeProviderAuth: vi.fn(() => { state.bound = true; state.revoked = false; }),
  unbindNativeProviderAuth: vi.fn(() => { state.bound = false; state.revoked = true; }),
}));
const discovery: AntigravityRuntimeState = { auth: { authenticated: true }, defaultModel: 'gemini-4-argon', models: [
  { id: 'gemini-4-argon', displayName: 'Gemini', contextWindow: 0, efforts: ['low', 'high'], defaultEffort: 'low' },
] };

beforeEach(() => {
  Object.assign(state, { owner: 'owner-a', generation: 1, bound: false, revoked: false, boundary: false, authorization: 'auth-1' });
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {});
  vi.spyOn(AntigravityRuntime.prototype, 'inspect').mockResolvedValue(discovery);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Antigravity native host', () => {
  it.each(['before-binding', 'during-discovery'] as const)('does not retain Cindy authorization when login is cancelled %s', async (phase) => {
    let finishLogin!: (value: { authenticated: boolean }) => void;
    vi.spyOn(AntigravityRuntime.prototype, 'login').mockReturnValue(new Promise(resolve => { finishLogin = resolve; }));
    let finishDiscovery!: (value: AntigravityRuntimeState) => void;
    vi.mocked(AntigravityRuntime.prototype.inspect).mockReturnValue(new Promise(resolve => { finishDiscovery = resolve; }));
    const host = createAntigravityHost({ publishModels: vi.fn() });
    const pending = host.auth.triggerLogin();
    if (phase === 'before-binding') host.auth.cancelLogin?.();
    finishLogin({ authenticated: true });
    if (phase === 'during-discovery') {
      await vi.waitFor(() => expect(AntigravityRuntime.prototype.inspect).toHaveBeenCalled());
      host.auth.cancelLogin?.();
    }
    await Promise.resolve();
    finishDiscovery?.(discovery);
    await expect(pending).resolves.toMatchObject({ authenticated: false, errorReason: 'login_cancelled' });
    expect(state.bound).toBe(false);
    expect(await host.readConnection({ allowSideEffects: true })).toBe(false);
  });

  it('reports OAuth authorization after native login and model discovery', async () => {
    vi.spyOn(AntigravityRuntime.prototype, 'login').mockResolvedValue({ authenticated: true });
    const host = createAntigravityHost({ publishModels: vi.fn() });
    await expect(host.auth.triggerLogin()).resolves.toMatchObject({ authenticated: true, authSource: 'oauth' });
  });

  it('does not reuse a discovery started before an explicit login binding', async () => {
    let finishOldDiscovery!: (value: AntigravityRuntimeState) => void;
    vi.mocked(AntigravityRuntime.prototype.inspect).mockReturnValueOnce(new Promise(resolve => {
      finishOldDiscovery = resolve;
    }));
    vi.spyOn(AntigravityRuntime.prototype, 'login').mockResolvedValue({ authenticated: true });
    const publish = vi.fn();
    const host = createAntigravityHost({ publishModels: publish });
    const oldDiscovery = host.readConnection({ allowSideEffects: true });
    const login = host.auth.triggerLogin();
    await vi.waitFor(() => expect(bindNativeProviderAuth).toHaveBeenCalled());
    finishOldDiscovery(discovery);
    await expect(oldDiscovery).resolves.toBe(false);
    await expect(login).resolves.toMatchObject({ authenticated: true, authSource: 'oauth' });
    expect(AntigravityRuntime.prototype.inspect).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: 'gemini-4-argon' })]);
  });

  it('adopts cached CLI login only on a local side-effecting read, publishes exact models, and reuses the snapshot', async () => {
    const publish = vi.fn();
    const host = createAntigravityHost({ publishModels: publish });
    expect(await host.readConnection({ snapshotOnly: true })).toBe(false);
    expect(await host.readConnection({ allowSideEffects: false })).toBe(false);
    expect(AntigravityRuntime.prototype.inspect).not.toHaveBeenCalled();
    expect(await host.readConnection({ allowSideEffects: true })).toBe(true);
    expect(claimDetectedNativeProviderAuth).toHaveBeenCalledWith('antigravity', expect.any(Function));
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({
      id: 'gemini-4-argon', name: 'Gemini', contextWindow: 0, contextWindowVerified: false,
      efforts: ['low', 'high'], defaultEffort: 'low',
    })]);
    expect(await host.auth.getState({ providerId: 'antigravity' })).toEqual({ authenticated: true });
    expect(AntigravityRuntime.prototype.inspect).toHaveBeenCalledTimes(1);
    await expect(host.auth.getState({ providerId: 'xd' })).rejects.toThrow(/provider/i);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    expect(await host.readConnection({ snapshotOnly: true })).toBe(true);
    expect(AntigravityRuntime.prototype.inspect).toHaveBeenCalledTimes(1);
    expect(await host.readConnection()).toBe(true);
    expect(AntigravityRuntime.prototype.inspect).toHaveBeenCalledTimes(2);
  });

  it('rejects a late native receipt after the owner changes', async () => {
    let finish!: (value: AntigravityRuntimeState) => void;
    vi.mocked(AntigravityRuntime.prototype.inspect).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const publish = vi.fn();
    const host = createAntigravityHost({ publishModels: publish });
    const pending = host.readConnection({ allowSideEffects: true });
    state.owner = 'owner-b'; state.generation++;
    finish(discovery);
    expect(await pending).toBe(false);
    expect(claimDetectedNativeProviderAuth).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('disconnects Cindy without signing the user out of their shared command-line login', async () => {
    const nativeLogout = vi.spyOn(AntigravityRuntime.prototype, 'logout');
    const publish = vi.fn();
    const host = createAntigravityHost({ publishModels: publish });
    await host.readConnection({ allowSideEffects: true });
    await host.auth.logout();
    expect(unbindNativeProviderAuth).toHaveBeenCalledWith('antigravity', { revoked: true });
    expect(nativeLogout).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith([]);
    expect(await host.readConnection({ allowSideEffects: true })).toBe(false);
    expect(AntigravityRuntime.prototype.inspect).toHaveBeenCalledTimes(1);
  });

  it('does not bind an interactive login completed after an owner boundary', async () => {
    let finish!: (value: { authenticated: boolean }) => void;
    vi.spyOn(AntigravityRuntime.prototype, 'login').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const host = createAntigravityHost({ publishModels: vi.fn() });
    const pending = host.auth.triggerLogin();
    state.generation++;
    finish({ authenticated: true });
    await expect(pending).rejects.toThrow(/owner/i);
    expect(bindNativeProviderAuth).not.toHaveBeenCalled();
  });
});
