import { ArrowUp, Sparkles } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

export type ChatRole = 'assistant' | 'user';

export type ChatMessage = {
  content: string;
  createdAt: number;
  id: string;
  role: ChatRole;
};

export type ChatSendResult = {
  reply: string;
};

export type ChatPanelProps = {
  onSend?: (content: string, history: ChatMessage[]) => Promise<ChatSendResult>;
};

function createMessageId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `msg-${crypto.randomUUID()}`;
  }

  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function stubSend(content: string): Promise<ChatSendResult> {
  await new Promise((resolve) => window.setTimeout(resolve, 420));
  return {
    reply:
      "I'm a placeholder. Wire me up to OpenRouter or ElevenLabs Convai in src/ChatPanel.tsx by passing an `onSend` prop. You said: " +
      content,
  };
}

export function ChatPanel({ onSend }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, isStreaming]);

  const submit = useCallback(
    async (rawContent: string) => {
      const content = rawContent.trim();
      if (!content || isStreaming) {
        return;
      }

      const userMessage: ChatMessage = {
        content,
        createdAt: Date.now(),
        id: createMessageId(),
        role: 'user',
      };

      setMessages((current) => [...current, userMessage]);
      setDraft('');
      setIsStreaming(true);

      try {
        const sender = onSend ?? stubSend;
        const result = await sender(content, [...messages, userMessage]);

        setMessages((current) => [
          ...current,
          {
            content: result.reply,
            createdAt: Date.now(),
            id: createMessageId(),
            role: 'assistant',
          },
        ]);
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            content: error instanceof Error ? error.message : 'Failed to reach the chat backend.',
            createdAt: Date.now(),
            id: createMessageId(),
            role: 'assistant',
          },
        ]);
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, messages, onSend],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submit(draft);
    },
    [draft, submit],
  );

  return (
    <section className="chat-panel" aria-label="Chat">
      <header className="chat-panel-header">
        <div className="chat-brand">
          <span className="chat-brand-glyph" aria-hidden="true">
            <Sparkles size={14} />
          </span>
          <div>
            <strong>Chat</strong>
            <span>Ask about your timeline.</span>
          </div>
        </div>
      </header>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Sparkles size={22} />
            <strong>Start a conversation</strong>
            <span>Ask for edit suggestions, EAL changes, or transcript review.</span>
          </div>
        ) : (
          messages.map((message) => (
            <div className={`chat-message chat-message-${message.role}`} key={message.id}>
              <div className="chat-message-bubble">{message.content}</div>
            </div>
          ))
        )}
        {isStreaming ? (
          <div className="chat-message chat-message-assistant">
            <div className="chat-message-bubble chat-message-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <textarea
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit(draft);
            }
          }}
          placeholder="Message"
          ref={textareaRef}
          rows={1}
          value={draft}
        />
        <button
          aria-label="Send message"
          className="chat-send"
          disabled={!draft.trim() || isStreaming}
          type="submit"
        >
          <ArrowUp size={16} />
        </button>
      </form>
    </section>
  );
}
