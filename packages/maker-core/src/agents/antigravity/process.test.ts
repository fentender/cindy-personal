import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityProcess } from './process.js';

// 生产入口：原生进程所有者。现有协议测试不证明停止时进程实际退出。
// 最小输入：EOF 后仍存活、强杀未确认、迟到 exit、启动失败。tier：unit，假时钟和进程边界。
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
const children: ReturnType<typeof childFixture>[] = [];
function childFixture(pid: number | undefined = 12345) {
  const child = Object.assign(new EventEmitter(), {
    pid: pid as number | undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}
function start(pid?: number) {
  vi.useFakeTimers();
  const child = childFixture(pid);
  children.push(child);
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const native = new AntigravityProcess({ binaryPath: '/native/agy', cwd: '/workspace', env: { PATH: '/bin' } });
  return { child, native };
}
afterEach(() => {
  for (const child of children.splice(0)) {
    child.emit('exit', 0, null);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
  vi.useRealTimers(); vi.clearAllMocks();
});

describe('Antigravity process ownership', () => {
  it('launches a hidden native ACP process and waits for spawn confirmation', async () => {
    const { native, child } = start();
    let started = false;
    void native.started.then(() => { started = true; });
    await Promise.resolve();
    expect(started).toBe(false);
    expect(spawn).toHaveBeenCalledWith('/native/agy', ['acp', '--process-per-session', '--disable-telemetry'],
      expect.objectContaining({ shell: false, windowsHide: true, cwd: '/workspace' }));
    child.emit('spawn');
    await native.started;
  });

  it('keeps the subscription process from inheriting API-key or ADC selection', () => {
    const child = childFixture();
    children.push(child);
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const env = { PATH: '/bin', GEMINI_API_KEY: 'api-fixture', AGY_ADC_AUTH: 'true',
      GOOGLE_GENAI_USE_VERTEXAI: 'true', HTTPS_PROXY: 'http://localhost:8888' };
    new AntigravityProcess({ binaryPath: '/native/agy', cwd: '/workspace', env });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env).toEqual({
      PATH: '/bin', HTTPS_PROXY: 'http://localhost:8888',
    });
    expect(env.GEMINI_API_KEY).toBe('api-fixture');
    child.emit('spawn');
  });

  it('does not release process ownership on EOF or on pipe failure', async () => {
    const { native, child } = start();
    child.emit('spawn'); await native.started;
    let stopped = false;
    const close = native.close().then(() => { stopped = true; });
    await Promise.resolve();
    expect(child.stdin.writableEnded).toBe(true);
    child.stdin.emit('error', new Error('EPIPE'));
    await Promise.resolve();
    expect(stopped).toBe(false);
    child.emit('exit', 0, null);
    await close;
    expect(stopped).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports a missing executable while confirming that no process owns the session', async () => {
    const { native, child } = start();
    child.pid = undefined;
    const rejected = expect(native.started).rejects.toThrow('ENOENT');
    child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await rejected;
    await native.close();
    await native.whenStopped;
    expect(execFile).not.toHaveBeenCalled();
  });

  it('keeps late-exit proof separate from a failed bounded close', async () => {
    const { native, child } = start();
    child.emit('spawn'); await native.started;
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      (args.at(-1) as (error: Error | null) => void)(null);
      return child as unknown as ReturnType<typeof execFile>;
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const close = native.close();
      const rejected = expect(close).rejects.toThrow('did not exit');
      await vi.runAllTimersAsync();
      await rejected;
      let stopped = false;
      void native.whenStopped.then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      child.emit('exit', null, 'SIGKILL');
      await native.whenStopped;
      await native.close();
    } finally { kill.mockRestore(); }
  });

  it('ends an inherited output pipe after the native process has exited', async () => {
    const { native, child } = start();
    child.emit('spawn'); await native.started;
    const reader = native.stream.readable.getReader();
    const result = reader.read().then(() => null, error => error);
    child.emit('exit', 1, null);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ message: 'Antigravity process exited before its output pipes closed' });
    reader.releaseLock();
  });
});
