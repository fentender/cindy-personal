import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import type { ModelDescriptor } from '../../types/capabilities.js';
import type { Effort } from '../../types/common.js';

/** 原生配置回执是模型与推理档位的唯一来源。 */
export function antigravityChoices(options: readonly SessionConfigOption[], id: string): SessionConfigSelectOption[] {
  const option = options.find(item => item.id === id);
  if (!option || option.type !== 'select') throw new Error(`Antigravity did not provide the ${id} selector`);
  return option.options.flatMap(item => 'group' in item ? item.options : [item]);
}

export function antigravityCurrentModel(options: readonly SessionConfigOption[]): ModelDescriptor {
  const model = options.find(item => item.id === 'model');
  if (!model || model.type !== 'select') throw new Error('Antigravity did not provide a model selector');
  assertAntigravitySelection(options, 'model', model.currentValue);
  const selected = antigravityChoices(options, 'model').find(item => item.value === model.currentValue)!;
  const thought = options.find(item => item.id === 'thought_level');
  const effortChoices = thought ? antigravityChoices(options, 'thought_level') : [];
  const efforts = effortChoices.map(item => parseEffort(item.value));
  let defaultEffort: Effort | null = null;
  if (thought) {
    if (thought.type !== 'select') throw new Error('Antigravity thought_level must be a selector');
    assertAntigravitySelection(options, 'thought_level', thought.currentValue);
    defaultEffort = parseEffort(thought.currentValue);
  }
  return {
    id: selected.value,
    displayName: selected.name,
    contextWindow: 0,
    efforts,
    defaultEffort,
    effortDisplayNames: Object.fromEntries(effortChoices.map(item => [item.value, item.name])),
  };
}

export function assertAntigravitySelection(options: readonly SessionConfigOption[], id: string, value: string): void {
  const choices = antigravityChoices(options, id);
  if (options.find(item => item.id === id)!.currentValue !== value || !choices.some(item => item.value === value)) {
    throw new Error(`Antigravity did not confirm ${id}=${value}`);
  }
}

function parseEffort(value: string): Effort {
  switch (value) {
    case 'minimal': case 'low': case 'medium': case 'high': case 'xhigh': case 'max': case 'ultra': return value;
    default: throw new Error(`Unsupported Antigravity thinking level: ${value}`);
  }
}
