import { describe, expect, it } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { antigravityChoices, antigravityCurrentModel, assertAntigravitySelection } from './config.js';

// 生产入口：原生模型目录与设置回执。保护 ACP 配置契约，现有三个引擎没有该协议覆盖。
// 最小输入：分组目录、模型切换后的档位、拒绝或缺失的设置回执。tier：unit，无外部资源。
const options: SessionConfigOption[] = [
  { id: 'model', name: 'Model', type: 'select', currentValue: 'gemini-4-argon', options: [
    { group: 'google', name: 'Google', options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }] },
  ] },
  { id: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'high', options: [
    { value: 'low', name: 'Low' }, { value: 'high', name: 'High' },
  ] },
];

describe('Antigravity native configuration', () => {
  it('reads grouped choices without inventing model ids', () => {
    expect(antigravityChoices(options, 'model')).toEqual([{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }]);
  });

  it('projects only the current model’s reported efforts and leaves an unknown context window unknown', () => {
    expect(antigravityCurrentModel(options)).toEqual({
      id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', contextWindow: 0,
      efforts: ['low', 'high'], defaultEffort: 'high', effortDisplayNames: { low: 'Low', high: 'High' },
    });
    expect(antigravityCurrentModel(options.slice(0, 1)).efforts).toEqual([]);
  });

  it.each([
    ['an unchanged value', options, 'model', 'another-model'],
    ['an absent selector', [], 'model', 'gemini-4-argon'],
    ['a value absent from choices', [{ ...options[0], currentValue: 'unlisted' }], 'model', 'unlisted'],
  ])('rejects a setting receipt with %s', (_label, receipt, id, value) => {
    expect(() => assertAntigravitySelection(receipt as SessionConfigOption[], id, value)).toThrow();
  });

  it('accepts a server-confirmed supported selection', () => {
    expect(() => assertAntigravitySelection(options, 'model', 'gemini-4-argon')).not.toThrow();
  });

  it('rejects an unrepresentable thinking level instead of changing its meaning', () => {
    const unknown: SessionConfigOption = { id: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'dynamic', options: [{ value: 'dynamic', name: 'Dynamic' }] };
    expect(() => antigravityCurrentModel([options[0], unknown])).toThrow('dynamic');
  });
});
