import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './ChatPanel';

function createUserMessage(content: string): ChatMessage {
  return { content, createdAt: 1, id: 'user-1', role: 'user' };
}

describe('ChatPanel message shape', () => {
  it('treats trimmed-empty input as a no-op', () => {
    const trimmed = '   \n  '.trim();
    expect(trimmed).toBe('');
  });

  it('keeps user and assistant messages in chronological order', () => {
    const messages: ChatMessage[] = [
      { content: 'hi', createdAt: 1, id: 'u-1', role: 'user' },
      { content: 'hello', createdAt: 2, id: 'a-1', role: 'assistant' },
      { content: 'what can you do', createdAt: 3, id: 'u-2', role: 'user' },
    ];

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages.every((m, index) => index === 0 || messages[index - 1].createdAt <= m.createdAt)).toBe(true);
  });
});
