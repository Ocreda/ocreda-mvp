'use client';

import { useState, useRef, useEffect } from 'react';
import { ConversationMessage } from '@/lib/types';
import { sendChatMessage } from '@/lib/notes-api';
import { Send, Sparkles, User, BookOpen, Loader as Loader2 } from 'lucide-react';
import { format } from 'date-fns';

interface SourceNote {
  id: string;
  summary: string | null;
  raw_text: string;
  connection_count: number;
}

interface MessageWithSources {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  sources?: SourceNote[];
  keyPoints?: string[];
  noteTitleMap?: Record<string, { id: string; title: string }>;
}

interface ConversationThreadProps {
  questionId: string;
  originalQuestion: string;
  originalAnswer: string;
  initialSources: SourceNote[];
  existingMessages: ConversationMessage[];
  onNoteClick?: (noteId: string) => void;
  keyPoints?: string[];
  noteTitleMap?: Record<string, { id: string; title: string }>;
}

// Highlight exact key-point phrases within answer text
function highlightKeyPoints(text: string, keyPoints: string[]): string {
  if (!keyPoints || keyPoints.length === 0) return text;
  let result = text;
  for (const kp of keyPoints) {
    if (!kp || kp.length < 4) continue;
    const escaped = kp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(
      new RegExp(`(${escaped})`, 'gi'),
      '<mark class="key-point-highlight">$1</mark>'
    );
  }
  return result;
}

// Render markdown + inline [Note N] markers as clickable chips
function renderAnswerWithSources(
  text: string,
  keyPoints: string[],
  noteTitleMap: Record<string, { id: string; title: string }>,
  onNoteClick: (id: string) => void
): React.ReactNode {
  const highlighted = highlightKeyPoints(text, keyPoints);
  const parts = highlighted.split(/(\[Note \d+\])/g);

  return (
    <span>
      {parts.map((part, i) => {
        const noteMarkerMatch = part.match(/^\[Note (\d+)\]$/);
        if (noteMarkerMatch) {
          const key = `Note ${noteMarkerMatch[1]}`;
          const noteInfo = noteTitleMap[key];
          if (!noteInfo) return null;
          return (
            <button
              key={i}
              onClick={() => onNoteClick(noteInfo.id)}
              className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-all align-baseline cursor-pointer"
              title={noteInfo.title}
            >
              <BookOpen className="w-2.5 h-2.5" />
              {noteInfo.title.length > 20 ? noteInfo.title.slice(0, 20) + '…' : noteInfo.title}
            </button>
          );
        }
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{
              __html: part
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>')
                .replace(/\n\n/g, '</p><p class="mt-2">')
                .replace(/\n/g, '<br />')
            }}
          />
        );
      })}
    </span>
  );
}

function renderMarkdown(text: string) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-xs font-mono">$1</code>')
    .replace(/\n\n/g, '</p><p class="mt-2">')
    .replace(/\n/g, '<br />');
}

function SourceChips({ sources, onChipClick }: { sources: SourceNote[]; onChipClick: (id: string) => void }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <BookOpen className="w-3 h-3" />
        Sources
      </p>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((n) => (
          <button
            key={n.id}
            onClick={() => onChipClick(n.id)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border bg-muted text-foreground border-border transition-all hover:shadow-sm hover:bg-accent hover:scale-105 active:scale-95 cursor-pointer"
            title="Click to open note"
          >
            <span className="font-medium">{n.summary || n.raw_text.slice(0, 40)}</span>
            {n.connection_count > 0 && <span className="opacity-40">connects to {n.connection_count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ConversationThread({
  questionId,
  originalQuestion,
  originalAnswer,
  initialSources,
  existingMessages,
  onNoteClick,
  keyPoints: initialKeyPoints = [],
  noteTitleMap: initialNoteTitleMap = {},
}: ConversationThreadProps) {
  const [messages, setMessages] = useState<MessageWithSources[]>(() => {
    const msgs: MessageWithSources[] = [];
    msgs.push({ id: 'orig-q', role: 'user', content: originalQuestion, created_at: new Date().toISOString() });
    msgs.push({
      id: 'orig-a',
      role: 'assistant',
      content: originalAnswer,
      created_at: new Date().toISOString(),
      sources: initialSources,
      keyPoints: initialKeyPoints,
      noteTitleMap: initialNoteTitleMap,
    });
    for (const m of existingMessages) {
      msgs.push({ id: m.id, role: m.role, content: m.content, created_at: m.created_at });
    }
    return msgs;
  });

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleChipClick = (noteId: string) => onNoteClick?.(noteId);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError('');
    setSending(true);

    const tempUserMsg: MessageWithSources = {
      id: `temp-u-${Date.now()}`,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const result = await sendChatMessage(questionId, text);
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.id !== tempUserMsg.id);
        const newMsgs = result.messages.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          created_at: m.created_at,
          sources: m.role === 'assistant' ? result.relevant_notes : undefined,
        }));
        return [...filtered, ...newMsgs];
      });
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-4 pb-4">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mt-0.5">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
              </div>
            )}
            <div className={`max-w-[85%] ${msg.role === 'user' ? 'order-first' : ''}`}>
              <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-primary text-white rounded-tr-sm'
                  : 'bg-card border border-border rounded-tl-sm shadow-sm'
              }`}>
                {msg.role === 'assistant' ? (
                  <div className="answer-prose">
                    {msg.noteTitleMap && Object.keys(msg.noteTitleMap).length > 0
                      ? <p>{renderAnswerWithSources(msg.content, msg.keyPoints ?? [], msg.noteTitleMap, handleChipClick)}</p>
                      : <div dangerouslySetInnerHTML={{ __html: `<p>${renderMarkdown(msg.content)}</p>` }} />
                    }
                  </div>
                ) : (
                  <p>{msg.content}</p>
                )}
                {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                  <SourceChips sources={msg.sources} onChipClick={handleChipClick} />
                )}
              </div>
              <p className={`text-xs text-muted-foreground mt-1 px-1 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                {format(new Date(msg.created_at), 'h:mm a')}
              </p>
            </div>
            {msg.role === 'user' && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted border border-border flex items-center justify-center mt-0.5">
                <User className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="flex gap-3 justify-start">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-card border border-border shadow-sm">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-destructive/10 text-xs text-destructive border border-destructive/20">
          {error}
        </div>
      )}

      <div className="relative">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          placeholder="Ask a follow-up... (Enter to send)"
          rows={2}
          className="w-full px-4 py-3 pr-14 text-sm rounded-2xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/50 resize-none shadow-sm"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="absolute right-3 bottom-3 p-2.5 rounded-xl bg-primary hover:bg-primary/90 text-white disabled:opacity-40 transition-all shadow-sm shadow-primary/20"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground text-center mt-2">
        Gemini reads all your notes in every reply
      </p>
    </div>
  );
}
