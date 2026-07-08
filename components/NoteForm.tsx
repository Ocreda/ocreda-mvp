'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Note } from '@/lib/types';
import { X, Loader as Loader2, Sparkles, CircleCheck as CheckCircle2, Mic, MicOff } from 'lucide-react';

interface NoteFormProps {
  note?: Note | null;
  onSave: (title: string, content: string) => Promise<void>;
  onClose: () => void;
  processing?: boolean;
  processingDone?: boolean;
}

export default function NoteForm({ note, onSave, onClose, processing, processingDone }: NoteFormProps) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (note) { setTitle(note.title); setContent(note.content); }
  }, [note]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    setError('');
    setSaving(true);
    try {
      await onSave(title.trim(), content.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSaving(false);
    }
  };

  const startVoice = useCallback(() => {
    const SpeechRecognitionAPI =
      (typeof window !== 'undefined' &&
        ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;

    if (SpeechRecognitionAPI) {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      let finalTranscript = content;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += (finalTranscript ? ' ' : '') + t;
          } else {
            interim = t;
          }
        }
        setContent(finalTranscript + (interim ? ' ' + interim : ''));
      };

      recognition.onend = () => {
        setRecording(false);
        setContent(finalTranscript);
      };

      recognition.onerror = () => setRecording(false);

      recognitionRef.current = recognition;
      recognition.start();
      setRecording(true);
    } else {
      startMediaRecorder();
    }
  }, [content]);

  const startMediaRecorder = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setTranscribing(true);
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          const formData = new FormData();
          formData.append('file', blob, 'audio.webm');

          const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
          const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

          const res = await fetch(`${SUPABASE_URL}/functions/v1/transcribe-audio`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
            body: formData,
          });

          if (res.ok) {
            const data = await res.json();
            const text = data.text?.trim() ?? '';
            if (text) setContent((prev) => prev + (prev ? ' ' : '') + text);
          }
        } catch {
          // silently fail
        } finally {
          setTranscribing(false);
          setRecording(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  const stopVoice = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  const toggleVoice = () => {
    if (recording) stopVoice();
    else startVoice();
  };

  const busy = processing || saving;

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="bg-card rounded-2xl shadow-2xl w-full max-w-lg border border-border/60 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-semibold text-foreground">{note ? 'Edit Note' : 'New Note'}</h2>
          <button onClick={onClose} disabled={busy} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Title <span className="text-muted-foreground/50 font-normal normal-case tracking-normal">(optional — AI will generate one)</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leave blank to auto-generate..."
              className="w-full px-3 py-2.5 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/50"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider">Content</label>
              <button
                type="button"
                onClick={toggleVoice}
                disabled={transcribing}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  recording
                    ? 'bg-destructive/10 text-destructive border border-destructive/30 animate-pulse'
                    : transcribing
                    ? 'bg-muted text-muted-foreground cursor-wait'
                    : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-accent border border-border'
                }`}
              >
                {transcribing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : recording ? (
                  <MicOff className="w-3 h-3" />
                ) : (
                  <Mic className="w-3 h-3" />
                )}
                {transcribing ? 'Transcribing...' : recording ? 'Stop recording' : 'Voice input'}
              </button>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
              placeholder="Write your note here..."
              rows={6}
              className="w-full px-3 py-2.5 text-sm rounded-xl border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all placeholder:text-muted-foreground/50 resize-none"
            />
          </div>

          {error && <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-xl">{error}</div>}

          {processingDone && (
            <div className="flex items-center gap-2 text-sm text-primary bg-primary/10 border border-primary/20 px-3 py-2 rounded-xl">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              AI processed: title, tags and connections generated
            </div>
          )}

          {processing && !processingDone && (
            <div className="flex items-center gap-2 text-sm text-primary bg-primary/10 px-3 py-2 rounded-xl">
              <Sparkles className="w-4 h-4 flex-shrink-0 animate-pulse" />
              AI is generating title, tags and connections...
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-all disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !content.trim()}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-all disabled:opacity-60 shadow-sm shadow-primary/20"
            >
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" />Saving...</> : note ? 'Save Changes' : 'Create Note'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
