import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../types/events.js';
import { AntigravityTranslator } from './translator.js';

// 生产入口：原生流转 Cindy 时间线。保护增量工具、终态与用量语义；现有 translator 不支持 ACP。
// 最小输入：只有状态的工具更新、重复终态、带缓存的原生用量、连续两次编辑。tier：unit，无 I/O。
function setup() {
  const events: AgentEvent[] = [];
  const translator = new AntigravityTranslator('/workspace', event => events.push(event));
  translator.beginTurn('gemini-4-argon');
  return { events, translator };
}

describe('Antigravity event translation', () => {
  it('records only completed edits, retaining the proposed diff until the status receipt', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'pending',
      content: [{ type: 'diff', path: '/workspace/a.txt', oldText: 'before\n', newText: 'after\n' }] });
    expect(events.filter(event => event.type === 'turn_diff')).toHaveLength(0);
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed' });
    const diffs = events.filter(event => event.type === 'turn_diff');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].data).toMatchObject({ diff: expect.stringContaining('diff --git a/a.txt b/a.txt\n') });
  });

  it('never reports a rejected edit proposal as an applied change', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'pending',
      content: [{ type: 'diff', path: '/workspace/a.txt', oldText: 'before\n', newText: 'after\n' }] });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'failed' });
    expect(events.filter(event => event.type === 'turn_diff').every(event => !(event.data as { diff: string }).diff.includes('+after'))).toBe(true);
  });

  it('marks the cumulative capture partial after a command with unknown filesystem effects', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'completed',
      content: [{ type: 'diff', path: '/workspace/a.txt', oldText: 'before\n', newText: 'after\n' }] });
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'command', title: 'Command', kind: 'execute', status: 'completed' });
    const last = events.filter(event => event.type === 'turn_diff').at(-1);
    expect(last?.data).toMatchObject({ isComplete: false, diff: expect.stringContaining('+after') });
  });

  it('preserves text chunks and separates thinking from the visible answer', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    translator.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    translator.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    expect(events.filter(event => event.type === 'text').map(event => (event.data as { text: string }).text)).toEqual(['Hello ', 'world']);
    expect(events.find(event => event.type === 'thinking' && (event.data as { stage: string }).stage === 'final')?.data).toMatchObject({ text: 'thinking' });
  });

  it('merges partial tool updates and emits only one result for a completed tool', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read file', name: 'read_file', status: 'in_progress', rawInput: { Path: '/workspace/a.txt' } });
    const completion = { sessionUpdate: 'tool_call_update' as const, toolCallId: 'read-1', status: 'completed' as const, rawOutput: 'file contents' };
    translator.update(completion);
    translator.update(completion);
    expect(events.filter(event => event.type === 'tool_use')).toHaveLength(1);
    expect(events.find(event => event.type === 'tool_use')?.data).toMatchObject({ toolUseId: 'read-1', toolName: 'read_file', input: { Path: '/workspace/a.txt' } });
    expect(events.filter(event => event.type === 'tool_result_full')).toHaveLength(1);
    expect(events.find(event => event.type === 'tool_result_full')?.data).toMatchObject({ fullText: 'file contents', isError: false });
  });

  it('publishes tool arguments that arrive after the pending notification', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read file', status: 'pending' });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', name: 'read_file',
      rawInput: { Path: '/workspace/a.txt' }, status: 'in_progress' });
    translator.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'contents' });
    expect(events.filter(event => event.type === 'tool_use').at(-1)?.data).toMatchObject({
      toolUseId: 'read-1', toolName: 'read_file', input: { Path: '/workspace/a.txt' },
    });
    expect(events.filter(event => event.type === 'tool_result_full')).toHaveLength(1);
  });

  it('accounts for cached input without confusing turn usage with the current context', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'usage_update', used: 8970, size: 1048576 });
    expect(events.find(event => event.type === 'status')?.data).toMatchObject({ status: 'Working', isRunning: true });
    translator.complete({ stopReason: 'end_turn', ...{ usage: { inputTokens: 11005, outputTokens: 77, cachedReadTokens: 6726, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 17808 } } });
    expect(translator.snapshot()).toMatchObject({ tokenUsage: 17808, outputTokens: 77, contextTokens: 8970, contextWindow: 1048576 });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('does not turn an exhausted output limit into successful completion', () => {
    const { events, translator } = setup();
    translator.complete({ stopReason: 'max_tokens' });
    translator.complete({ stopReason: 'end_turn' });
    expect(events.filter(event => event.type === 'done')).toHaveLength(0);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ isTerminal: true, reason: 'output-limit' });
  });

  it('settles malformed native usage as a terminal protocol error', () => {
    const { events, translator } = setup();
    expect(() => translator.complete({ stopReason: 'end_turn', ...{ usage: { inputTokens: -1 } } })).not.toThrow();
    expect(events.find(event => event.type === 'error')?.data).toMatchObject({ isTerminal: true, message: 'Invalid Antigravity usage.inputTokens' });
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('closes pending tools on cancellation and rejects late events from the completed turn', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'pending', title: 'Command', status: 'in_progress' });
    translator.complete({ stopReason: 'cancelled' });
    translator.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
    translator.fail(new Error('late error'));
    expect(events.find(event => event.type === 'tool_result')?.data).toMatchObject({ toolUseIds: ['pending'] });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ cancelled: true });
    expect(events.filter(event => event.type === 'text' || event.type === 'error')).toHaveLength(0);
  });

  it('composes repeated edits into one cumulative turn diff', () => {
    const { events, translator } = setup();
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit', status: 'completed', content: [{ type: 'diff', path: '/workspace/a.txt', oldText: 'a\n', newText: 'b\n' }] });
    translator.update({ sessionUpdate: 'tool_call', toolCallId: 'edit-2', title: 'Edit', status: 'completed', content: [{ type: 'diff', path: '/workspace/a.txt', oldText: 'b\n', newText: 'c\n' }] });
    const diffs = events.filter(event => event.type === 'turn_diff');
    expect(diffs).toHaveLength(2);
    expect(diffs[1].data).toMatchObject({ isComplete: true });
    expect((diffs[1].data as { diff: string }).diff).toContain('-a\n+c');
  });
});
