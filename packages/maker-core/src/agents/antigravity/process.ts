import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

export interface AntigravityProcessOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 仅含宿主批准技能的会话目录，不替换原生 Agent。 */
  skillDirectory?: string;
}

export class AntigravityProcess {
  readonly stream: Stream;
  readonly started: Promise<void>;
  readonly whenStopped: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private stopped = false;
  private closing?: Promise<void>;

  get pid(): number | undefined { return this.child.pid; }

  constructor(options: AntigravityProcessOptions) {
    let confirmStopped!: () => void;
    this.whenStopped = new Promise(resolve => { confirmStopped = resolve; });
    // 此引擎使用原生订阅登录；宿主的 API/ADC 环境不得改变计费来源。
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) =>
      !['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_GENAI_USE_VERTEXAI'].includes(key.toUpperCase())));
    this.child = spawn(options.binaryPath, ['acp', '--process-per-session', '--disable-telemetry',
      ...(options.skillDirectory ? ['--add-dir', options.skillDirectory] : [])], {
      cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
    });
    const child = this.child;
    // Node 与 DOM 的 BYOB 类型声明不同；这里实际交付的仍是 Node 标准 Web 字节流。
    this.stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>);
    // stderr 不是 ACP 协议，可能包含提示或认证信息；只排空，不写业务日志。
    child.stderr.resume();
    const stopped = () => {
      if (this.stopped) return;
      this.stopped = true;
      confirmStopped();
    };
    this.started = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.on('error', error => {
        reject(error);
        // 运行中的 error/EPIPE 不能当作退出证据；没有 PID 的 spawn 失败才可以。
        if (child.pid === undefined) stopped();
        child.stdout.destroy(error);
      });
    });
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    child.once('exit', () => {
      stopped();
      // 子进程继承 stdout 时根进程的 exit 不会关闭管道，不能让 ACP 请求永久悬挂。
      drainTimer = setTimeout(() => {
        child.stdout.destroy(new Error('Antigravity process exited before its output pipes closed'));
        child.stderr.destroy();
        child.stdin.destroy();
      }, 1_000);
      drainTimer.unref();
    });
    child.once('close', () => { if (drainTimer) clearTimeout(drainTimer); });
  }

  close(): Promise<void> {
    if (this.stopped) return this.whenStopped;
    if (!this.closing) this.closing = this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    // adapter 先发送 session/close；EOF 再给原生服务一次正常保存和退出的机会。
    this.child.stdin.end();
    if (await this.waitForExit(1_500)) return;
    const pid = this.child.pid;
    if (pid === undefined) throw new Error('Antigravity process has not confirmed spawn or exit');
    // 强杀只针对仍由本对象持有的活动根进程；退出后不再按旧 PID 发信号。
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true, timeout: 2_000,
        }, error => {
          if (error) reject(new Error('Antigravity process tree termination failed', { cause: error }));
          else resolve();
        });
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); }
      catch (error) {
        // kill 与 exit 通知之间存在竞态，只有 ESRCH 才继续等待进程退出回执。
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (!await this.waitForExit(1_000)) throw new Error('Antigravity process did not exit after termination');
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.stopped) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.whenStopped, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
      return this.stopped;
    } finally { if (timer) clearTimeout(timer); }
  }
}
