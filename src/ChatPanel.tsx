import { ArrowRight, Check, X } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type ChatRole = 'assistant' | 'user';

export type ChatToolCall = {
  appliedAt: number | null;
  arguments: Record<string, unknown>;
  discardedAt: number | null;
  error: string | null;
  id: string;
  name: string;
};

export type ChatMessage = {
  content: string;
  createdAt: number;
  id: string;
  role: ChatRole;
  toolCalls?: ChatToolCall[];
};

export type ChatToolResult =
  | { ok: true }
  | { error: string; ok: false };

export type ChatSendResult = {
  reply: string;
};

export type EditorContextSnapshot = {
  activeClipId: string | null;
  beats: Array<{
    assetId: string;
    bpm: number | null;
    clipId: string;
    clipKind: 'audio' | 'video' | 'text' | 'unknown';
    timelineBeats: number[];
    timelineDownbeats: number[];
  }>;
  editArray: unknown;
  playheadSeconds: number;
  projectName: string;
  selectedClipId: string | null;
  selectedTextId: string | null;
  selectedTrackId: string | null;
  transcripts: Array<{
    assetId: string;
    clipId: string;
    excerpt: string;
    language: string | null;
  }>;
};

export type ChatPanelProps = {
  applyToolCall?: (call: ChatToolCall) => ChatToolResult;
  getContext?: () => EditorContextSnapshot | null;
  onSend?: (content: string, history: ChatMessage[]) => Promise<ChatSendResult>;
};

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Tighten the intro', prompt: 'Suggest cuts to tighten the first 10 seconds of the timeline.' },
  { label: 'Draft captions for the narration', prompt: 'Draft caption overlays for the spoken sections of the timeline.' },
  { label: 'Find filler words I can cut', prompt: 'Find filler words and repeated phrases I can cut.' },
  { label: 'Match color across clips', prompt: 'Suggest color grade adjustments so the clips match each other.' },
];

function createMessageId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `msg-${crypto.randomUUID()}`;
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type StreamEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'done'; cache: 'local' | 'provider' | 'miss'; usage?: unknown }
  | { type: 'error'; message: string };

// Live-streaming chat call. Hits the Rust backend's `POST /api/chat` SSE
// endpoint, parses `data: {...}` frames as they arrive, and feeds each delta
// to `onDelta`. Resolves with the final reply once the stream ends.
async function streamChat(
  history: ChatMessage[],
  context: EditorContextSnapshot | null,
  onDelta: (delta: string) => void,
  onToolCall: (call: { arguments: Record<string, unknown>; id: string; name: string }) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/chat', {
    body: JSON.stringify({
      context: context
        ? {
            active_clip_id: context.activeClipId,
            beats: context.beats.map((b) => ({
              asset_id: b.assetId,
              bpm: b.bpm,
              clip_id: b.clipId,
              clip_kind: b.clipKind,
              timeline_beats: b.timelineBeats,
              timeline_downbeats: b.timelineDownbeats,
            })),
            edit_array: context.editArray,
            playhead_seconds: context.playheadSeconds,
            project_name: context.projectName,
            selected_clip_id: context.selectedClipId,
            selected_text_id: context.selectedTextId,
            selected_track_id: context.selectedTrackId,
            // Backend EditorContext expects snake_case keys on every nested
            // field too — re-map here.
            transcripts: context.transcripts.map((t) => ({
              asset_id: t.assetId,
              clip_id: t.clipId,
              excerpt: t.excerpt,
              language: t.language,
            })),
          }
        : undefined,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    method: 'POST',
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `chat request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines. Each frame has one or more
    // lines beginning with "data:". We accumulate until we see the boundary.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const event = JSON.parse(payload) as StreamEvent;
          if (event.type === 'delta') {
            assembled += event.text;
            onDelta(event.text);
          } else if (event.type === 'tool_call') {
            onToolCall({ arguments: event.arguments, id: event.id, name: event.name });
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
          // `done` carries cache/usage metadata; we don't surface it in the
          // UI yet, but it's there for future indicators.
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }

  return assembled;
}

// Pretty-print the most informative field on the card so the user sees what
// the model wants to do without expanding the full args. For apply_eal we
// trust the model's `summary` field; otherwise fall back to a couple of
// well-known argument keys.
function summariseArgs(name: string, args: Record<string, unknown>): string {
  if (name === 'apply_eal') {
    if (typeof args.summary === 'string' && args.summary.trim().length > 0) {
      return args.summary;
    }
    const program = args.program;
    if (Array.isArray(program)) {
      const clips = program.filter((entry) => Array.isArray(entry) && entry[0] === 'clip').length;
      const overlays = program.filter((entry) => Array.isArray(entry) && entry[0] === 'text').length;
      const tracks = program.filter((entry) => Array.isArray(entry) && entry[0] === 'track').length;
      return `apply program — ${clips} clips · ${overlays} text · ${tracks} tracks`;
    }
    return 'apply EAL program';
  }
  const fmt = (key: string) => {
    const value = args[key];
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return `${key}: ${Number(value.toFixed(3))}`;
    if (typeof value === 'string') return `${key}: ${value}`;
    return null;
  };
  const fields: string[] = [];
  const candidates = ['clip_id', 'text_id', 'at_seconds', 'timeline_start_seconds', 'source_time_seconds', 'edge', 'start_seconds', 'end_seconds', 'text'];
  for (const key of candidates) {
    const out = fmt(key);
    if (out) fields.push(out);
  }
  return fields.join(' · ') || JSON.stringify(args);
}

type ToolCallCardProps = {
  call: ChatToolCall;
  onApply: () => void;
  onDiscard: () => void;
};

function ToolCallCard({ call, onApply, onDiscard }: ToolCallCardProps) {
  const resolved = call.appliedAt !== null || call.discardedAt !== null;
  const status =
    call.discardedAt !== null
      ? 'discarded'
      : call.error
        ? 'error'
        : call.appliedAt !== null
          ? 'applied'
          : 'pending';
  return (
    <div className={`chat-tool-card chat-tool-${status}`} role="group">
      <div className="chat-tool-head">
        <code className="chat-tool-name">{call.name === 'apply_eal' ? 'edit timeline' : call.name}</code>
        <span className="chat-tool-status">
          {status === 'pending' && 'proposed'}
          {status === 'applied' && 'applied'}
          {status === 'discarded' && 'discarded'}
          {status === 'error' && 'failed'}
        </span>
      </div>
      <div className="chat-tool-summary">{summariseArgs(call.name, call.arguments)}</div>
      {call.error ? <div className="chat-tool-error">{call.error}</div> : null}
      {!resolved ? (
        <div className="chat-tool-actions">
          <button className="chat-tool-apply" onClick={onApply} type="button">
            <Check size={13} strokeWidth={2.5} />
            Apply
          </button>
          <button className="chat-tool-discard" onClick={onDiscard} type="button">
            <X size={13} strokeWidth={2.25} />
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ChatPanel({ applyToolCall, getContext, onSend }: ChatPanelProps) {
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

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [draft]);

  const submit = useCallback(
    async (rawContent: string) => {
      const content = rawContent.trim();
      if (!content || isStreaming) return;

      const userMessage: ChatMessage = {
        content,
        createdAt: Date.now(),
        id: createMessageId(),
        role: 'user',
      };
      const assistantId = createMessageId();
      const history = [...messages, userMessage];

      setMessages((current) => [
        ...current,
        userMessage,
        { content: '', createdAt: Date.now(), id: assistantId, role: 'assistant' },
      ]);
      setDraft('');
      setIsStreaming(true);

      try {
        if (onSend) {
          // Custom non-streaming sender (kept for testability / future overrides).
          const result = await onSend(content, history);
          setMessages((current) =>
            current.map((msg) => (msg.id === assistantId ? { ...msg, content: result.reply } : msg)),
          );
        } else {
          // Snapshot the editor state at submit time. Pulling it lazily here
          // (vs. at each render) keeps ChatPanel from re-rendering whenever
          // the timeline changes — only matters at send time.
          const context = getContext?.() ?? null;
          await streamChat(
            history,
            context,
            (delta) => {
              setMessages((current) =>
                current.map((msg) =>
                  msg.id === assistantId ? { ...msg, content: msg.content + delta } : msg,
                ),
              );
            },
            (call) => {
              setMessages((current) =>
                current.map((msg) =>
                  msg.id === assistantId
                    ? {
                        ...msg,
                        toolCalls: [
                          ...(msg.toolCalls ?? []),
                          {
                            appliedAt: null,
                            arguments: call.arguments,
                            discardedAt: null,
                            error: null,
                            id: call.id,
                            name: call.name,
                          },
                        ],
                      }
                    : msg,
                ),
              );
            },
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reach the chat backend.';
        setMessages((current) =>
          current.map((msg) => (msg.id === assistantId ? { ...msg, content: message } : msg)),
        );
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

  const canSend = draft.trim().length > 0 && !isStreaming;

  const updateToolCall = useCallback((messageId: string, callId: string, patch: Partial<ChatToolCall>) => {
    setMessages((current) =>
      current.map((msg) =>
        msg.id === messageId && msg.toolCalls
          ? {
              ...msg,
              toolCalls: msg.toolCalls.map((tc) => (tc.id === callId ? { ...tc, ...patch } : tc)),
            }
          : msg,
      ),
    );
  }, []);

  const handleApply = useCallback(
    (messageId: string, call: ChatToolCall) => {
      if (!applyToolCall) {
        updateToolCall(messageId, call.id, { error: 'No dispatcher wired in', appliedAt: Date.now() });
        return;
      }
      const result = applyToolCall(call);
      if (result.ok) {
        updateToolCall(messageId, call.id, { appliedAt: Date.now(), error: null });
      } else {
        updateToolCall(messageId, call.id, { error: result.error, appliedAt: Date.now() });
      }
    },
    [applyToolCall, updateToolCall],
  );

  const handleDiscard = useCallback(
    (messageId: string, callId: string) => {
      updateToolCall(messageId, callId, { discardedAt: Date.now() });
    },
    [updateToolCall],
  );

  return (
    <section className="chat-panel" aria-label="Chat">
      <div className="chat-thread" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-intro">
            <p className="chat-intro-prompt">What would you like to do?</p>
            <ul className="chat-starter-list">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion.label}>
                  <button className="chat-starter" onClick={() => void submit(suggestion.prompt)} type="button">
                    {suggestion.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="chat-log">
            {messages.map((message) => {
              if (message.role === 'user') {
                return (
                  <div className="chat-user" key={message.id}>
                    <div className="chat-user-text">{message.content}</div>
                  </div>
                );
              }
              const hasContent = message.content.length > 0;
              const hasTools = (message.toolCalls?.length ?? 0) > 0;
              if (!hasContent && !hasTools) {
                return (
                  <div className="chat-assistant chat-assistant-typing" key={message.id} aria-label="Assistant is typing">
                    <span />
                    <span />
                    <span />
                  </div>
                );
              }
              return (
                <div className="chat-assistant" key={message.id}>
                  {hasContent ? (
                    <div className="chat-assistant-text chat-markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        // Force links to open in a new tab and prevent any
                        // accidental embed shenanigans from a hosted assistant.
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a {...props} rel="noreferrer noopener" target="_blank" />
                          ),
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : null}
                  {message.toolCalls?.map((call) => (
                    <ToolCallCard
                      call={call}
                      key={call.id}
                      onApply={() => handleApply(message.id, call)}
                      onDiscard={() => handleDiscard(message.id, call.id)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
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
          placeholder="Ask anything"
          ref={textareaRef}
          rows={1}
          value={draft}
        />
        <button aria-label="Send message" className="chat-send" disabled={!canSend} type="submit">
          <ArrowRight size={14} strokeWidth={2.25} />
        </button>
      </form>
    </section>
  );
}
