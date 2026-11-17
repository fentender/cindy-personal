import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../metro.config.js');
const excluded = (path: string) => config.resolver.blockList.some((pattern: RegExp) => pattern.test(path));

describe('Metro 原生构建目录过滤', () => {
  it.each([
    'E:\\projects\\cindy\\node_modules\\expo-structured-headers\\android\\build\\intermediates\\jni',
    'E:\\projects\\cindy\\node_modules\\react-native-worklets\\android\\.cxx\\Debug',
    'E:\\projects\\cindy\\apps\\mobile\\android\\app\\build\\outputs',
    '/repo/node_modules/expo-constants/android/build/generated',
    '/repo/apps/mobile/android/.gradle/9.4.1',
  ])('不监听生成目录 %s', (path) => {
    expect(excluded(path)).toBe(true);
  });

  it.each([
    '/repo/apps/mobile/src/App.tsx',
    '/repo/node_modules/expo-constants/build/Constants.js',
    '/repo/node_modules/react-native/android/src/main/java/ReactActivity.java',
    '/repo/apps/mobile/assets/icon.png',
  ])('保留源码和资源 %s', (path) => {
    expect(excluded(path)).toBe(false);
  });
});
