// 根目录开发入口在开始原生构建前核对 Metro，复用模拟器工具的身份规则。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBundleEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { applySimMockArg, readSimEnvironment } from './lib/sim-environment.mjs';
import { extractMobileDevRegionArgs, withLocalMobileRegionConfig } from './lib/mobile-dev-region.mjs';
import { classifySimMetroListener, validateSimMetroIdentity } from './lib/sim-whoami.mjs';
import { gitSourceIdentity, probeMetroOwnership } from './sim-metro.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(mobileDir, '../..');
const { region, passthrough } = extractMobileDevRegionArgs(applySimMockArg(process.argv.slice(2)));
if (passthrough.length) throw new Error(`不支持的 Metro 检查参数：${passthrough.join(' ')}`);
const buildEnv = withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region }));
const { envFingerprint } = readSimEnvironment(mobileDir, buildEnv);
const ownership = probeMetroOwnership(8081);
const verdict = validateSimMetroIdentity({
  listener: classifySimMetroListener({ cwd: ownership?.cwd, source: ownership?.source, targetWorktree: worktreeRoot }),
  currentSource: gitSourceIdentity(worktreeRoot), runningSource: ownership?.source,
  currentRegion: region, runningRegion: ownership?.region,
  currentEnvFingerprint: envFingerprint, runningEnvFingerprint: ownership?.envFingerprint,
});
// 2 表示启动器尚未完成替换；异常仍以 1 暴露给调用方。
if (!verdict.healthy) {
  console.log(`Metro 身份尚未匹配：${verdict.code}`);
  process.exitCode = 2;
} else {
  console.log('METRO_IDENTITY=passed');
}
