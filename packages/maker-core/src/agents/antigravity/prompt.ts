import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentBlock, PromptCapabilities } from '@agentclientprotocol/sdk';
import type { UserMessage } from '../../types/common.js';
import { TurnDispatchRejectedError } from '../base-agent.js';
import { detectSupportedImageMime } from '../shared/image-compressor.js';
import { formatManagedImageReferences } from '../shared/managed-image-reference.js';

/** 附件按用户消息顺序交付；本机文件保留引用，图片交付实际字节与宿主管理身份。 */
export async function buildAntigravityPrompt(message: UserMessage, cwd: string, capabilities: PromptCapabilities,
  signal: AbortSignal): Promise<ContentBlock[]> {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  const prompt: ContentBlock[] = [];
  for (const block of message.content) {
    if (signal.aborted) throw new TurnDispatchRejectedError('Antigravity input was cancelled before dispatch');
    switch (block.type) {
      case 'text': prompt.push(block); break;
      case 'image': {
        if (!capabilities.image) throw new TurnDispatchRejectedError('Antigravity did not advertise image input support');
        const bytes = await fs.readFile(path.resolve(cwd, block.path), { signal });
        const mimeType = detectSupportedImageMime(bytes) ?? block.mimeType;
        if (!mimeType) throw new TurnDispatchRejectedError('Antigravity image attachment has an unknown MIME type');
        prompt.push({ type: 'image', data: bytes.toString('base64'), mimeType });
        break;
      }
      case 'file':
      case 'mention':
        prompt.push({ type: 'resource_link', uri: pathToFileURL(path.resolve(cwd, block.path)).href,
          name: block.type === 'mention' ? block.name : path.basename(block.path),
          ...(block.type === 'file' && block.mimeType ? { mimeType: block.mimeType } : {}) });
        break;
    }
  }
  const references = formatManagedImageReferences(message.content);
  if (references) prompt.push({ type: 'text', text: references });
  return prompt;
}
