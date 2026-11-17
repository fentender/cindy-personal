import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import path from 'node:path';
import type { PromptResponse, SessionUpdate, ToolCall, ToolCallUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';

class AntigravityUsageProtocolError extends Error {}

/** 将单个原生任务的增量事件转换为 Cindy 时间线。 */
export class AntigravityTranslator {
  private active = false;
  private turnId = '';
  private model = '';
  private block = 0;
  private thinking = '';
  private thinkingId = '';
  private readonly epoch = randomUUID();
  private readonly totals = new Map<string, { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }>();
  private readonly tools = new Map<string, ToolCall>();
  private readonly proposedDiffs = new Map<string, ToolCallContent[]>();
  private readonly completedTools = new Set<string>();
  private readonly edits = new Map<string, { original: string | null; current: string }>();
  private completeDiff = true;
  private usage: UsageSnapshot = { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };

  constructor(private readonly cwd: string, private readonly emit: (event: AgentEvent) => void) {}

  isTurnRunning(): boolean {
    return this.active;
  }

  beginTurn(model: string): void {
    if (this.active) throw new Error('Antigravity turn is already active');
    this.active = true;
    this.turnId = randomUUID();
    this.model = model;
    this.block = 0;
    this.thinking = '';
    this.thinkingId = '';
    this.tools.clear();
    this.proposedDiffs.clear();
    this.completedTools.clear();
    this.edits.clear();
    this.completeDiff = true;
    this.usage = { ...this.usage, tokenUsage: 0, outputTokens: 0 };
    this.emit({ type: 'status', data: { status: 'Working', ...this.snapshot(), isRunning: true } });
  }

  update(update: SessionUpdate): void {
    if (!this.active) return;
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk':
        if (update.content.type !== 'text') return;
        if (!this.thinkingId) {
          this.thinkingId = `${this.turnId}:thinking:${this.block++}`;
          this.emit({ type: 'thinking', data: { stage: 'start', blockId: this.thinkingId, startedAt: Date.now() } });
        }
        this.thinking += update.content.text;
        this.emit({ type: 'thinking', data: { stage: 'delta', blockId: this.thinkingId, text: update.content.text } });
        break;
      case 'agent_message_chunk':
        this.finishThinking();
        if (update.content.type === 'text') {
          this.emit({ type: 'text', data: { text: update.content.text, isFinal: false, agentMessageId: `${this.turnId}:message:${this.block}` } });
        } else if (update.content.type === 'image') {
          this.emit({ type: 'image', data: { kind: 'generation', blockId: `${this.turnId}:image:${this.block++}`, data: update.content.data, mimeType: update.content.mimeType } });
        }
        break;
      case 'tool_call':
      case 'tool_call_update':
        this.finishThinking();
        this.updateTool(update);
        break;
      case 'usage_update':
        this.usage.contextTokens = update.used;
        this.usage.contextWindow = update.size;
        if (update.cost?.currency === 'USD') this.usage.costUsd = update.cost.amount;
        this.emit({ type: 'status', data: { status: 'Working', ...this.snapshot(), isRunning: true } });
        break;
      case 'plan':
        this.emit({ type: 'tool_use', data: { toolUseId: `plan:${this.turnId}`, toolName: 'update_plan', runtimeActivity: 'snapshot', input: { plan: update.entries.map(entry => ({ step: entry.content, status: entry.status })) } } });
        break;
    }
  }

  complete(result: PromptResponse): void {
    if (!this.active) return;
    try { this.recordUsage(result); }
    catch (error) {
      if (!(error instanceof AntigravityUsageProtocolError)) throw error;
      // 原生扩展字段不受 ACP schema 校验；坏回执必须结束轮次，不能悬挂在完成回调里。
      this.fail(error);
      return;
    }
    if (result.stopReason === 'max_tokens' || result.stopReason === 'max_turn_requests' || result.stopReason === 'refusal') {
      this.finishTools('Stopped');
      this.finishThinking();
      this.active = false;
      this.emit({ type: 'error', data: {
        message: `Antigravity stopped: ${result.stopReason}`, isTerminal: true,
        reason: result.stopReason === 'max_tokens' ? 'output-limit' : `antigravity-${result.stopReason}`,
        usage: this.snapshot(),
      } });
      return;
    }
    this.finishTools(result.stopReason === 'cancelled' ? 'Cancelled' : 'Stopped without a tool result');
    this.finishThinking();
    this.active = false;
    this.emit({ type: 'done', data: { cancelled: result.stopReason === 'cancelled', ...this.snapshot(), usage: this.snapshot() } });
  }

  fail(error: unknown): void {
    if (!this.active) return;
    this.finishTools('Interrupted');
    this.finishThinking();
    this.active = false;
    this.emit({ type: 'error', data: { message: error instanceof Error ? error.message : String(error), isTerminal: true, reason: 'antigravity-error', usage: this.snapshot() } });
  }

  snapshot(): UsageSnapshot {
    return { ...this.usage, requestUsage: { epoch: this.epoch, models: [...this.totals.values()].map(model => ({ ...model })) } };
  }

  private finishThinking(): void {
    if (!this.thinkingId) return;
    this.emit({ type: 'thinking', data: { stage: 'final', blockId: this.thinkingId, text: this.thinking } });
    this.thinkingId = '';
    this.thinking = '';
    this.block++;
  }

  private updateTool(update: ToolCall | ToolCallUpdate): void {
    const id = update.toolCallId;
    if (this.completedTools.has(id)) return;
    const previous = this.tools.get(id);
    const fields = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null));
    const tool = { ...previous, ...fields } as ToolCall;
    this.tools.set(id, tool);
    if (!previous) this.block++;
    if (!previous || (previous.name ?? previous.title ?? id) !== (tool.name ?? tool.title ?? id)
      || !isDeepStrictEqual(previous.rawInput, tool.rawInput)) {
      this.emit({ type: 'tool_use', data: {
        toolUseId: id, toolName: tool.name ?? tool.title ?? id,
        input: record(tool.rawInput) ?? (tool.rawInput === undefined ? {} : { value: tool.rawInput }),
      } });
    }
    const proposed = update.content?.filter(content => content.type === 'diff');
    if (proposed?.length) this.proposedDiffs.set(id, proposed);
    if (tool.status !== 'completed' && tool.status !== 'failed') return;
    const edits = this.proposedDiffs.get(id);
    // ACP 可以先报告待批准的 diff，再只报告状态；只有成功回执证明修改已执行。
    if (tool.status === 'completed' && edits?.length) this.updateDiffs(edits);
    else if (!tool.kind || !['read', 'search', 'think', 'fetch', 'switch_mode'].includes(tool.kind)) {
      this.completeDiff = false;
      this.emitDiff();
    }
    this.proposedDiffs.delete(id);
    const text = toolOutput(tool);
    this.finishTool(id, text, tool.status === 'failed');
  }

  private finishTool(id: string, text: string, isError: boolean): void {
    this.completedTools.add(id);
    this.emit({ type: 'tool_result_full', data: { toolUseId: id, fullText: text, isError } });
    this.emit({ type: 'tool_result', data: { toolUseIds: [id], summary: text.slice(0, 500), isError } });
  }

  private finishTools(reason: string): void {
    for (const id of this.tools.keys()) {
      if (!this.completedTools.has(id)) this.finishTool(id, reason, true);
    }
  }

  private updateDiffs(contents: ToolCallContent[]): void {
    let changed = false;
    for (const content of contents) {
      if (content.type !== 'diff') continue;
      const relative = path.relative(this.cwd, path.resolve(this.cwd, content.path)).replace(/\\/g, '/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        this.completeDiff = false;
        changed = true;
        continue;
      }
      const existing = this.edits.get(relative);
      const original = content.oldText ?? null;
      if (existing?.current === content.newText) continue;
      if (existing && existing.current !== original) this.completeDiff = false;
      this.edits.set(relative, { original: existing ? existing.original : original, current: content.newText });
      changed = true;
    }
    if (changed) this.emitDiff();
  }

  private emitDiff(): void {
    this.emit({ type: 'turn_diff', data: {
      turnId: this.turnId, cwd: this.cwd, isComplete: this.completeDiff,
      diff: [...this.edits].map(([file, edit]) => `diff --git a/${file} b/${file}\n`
        + (edit.original === null ? 'new file mode 100644\n' : '')
        + createTwoFilesPatch(edit.original === null ? '/dev/null' : `a/${file}`, `b/${file}`, edit.original ?? '', edit.current)).join('\n'),
    } });
  }

  private recordUsage(result: PromptResponse): void {
    // agy 在标准 prompt 响应上追加 usage；字段不属于 ACP v1 的标准必选部分。
    const usage = record((result as PromptResponse & { usage?: unknown }).usage);
    if (!usage) return;
    const input = tokenCount(usage, 'inputTokens');
    const output = tokenCount(usage, 'outputTokens');
    const cacheRead = tokenCount(usage, 'cachedReadTokens');
    const cacheWrite = tokenCount(usage, 'cachedWriteTokens');
    this.usage.tokenUsage = tokenCount(usage, 'totalTokens');
    this.usage.outputTokens = output;
    const previous = this.totals.get(this.model);
    this.totals.set(this.model, {
      model: this.model, inputTokens: (previous?.inputTokens ?? 0) + input,
      outputTokens: (previous?.outputTokens ?? 0) + output,
      cacheReadTokens: (previous?.cacheReadTokens ?? 0) + cacheRead,
      cacheCreateTokens: (previous?.cacheCreateTokens ?? 0) + cacheWrite,
    });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tokenCount(usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AntigravityUsageProtocolError(`Invalid Antigravity usage.${key}`);
  return value;
}

function toolOutput(tool: ToolCall): string {
  const text = tool.content?.flatMap(content => content.type === 'content' && content.content.type === 'text' ? [content.content.text] : []).join('\n');
  if (text) return text;
  if (typeof tool.rawOutput === 'string') return tool.rawOutput;
  if (tool.rawOutput !== undefined) return JSON.stringify(tool.rawOutput);
  // 原生文件读取可能只报告完成状态，不把读取正文发给 ACP 客户端。
  return tool.title ?? tool.status ?? tool.toolCallId;
}
