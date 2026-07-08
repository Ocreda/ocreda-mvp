'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Mic, MicOff, Loader } from 'lucide-react';

interface QuickCaptureProps {
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}

export default function QuickCapture({ onSave, onClose }: QuickCaptureProps) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSave = async () => {
    if (!content.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(content.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSave();
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
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += (finalTranscript ? ' ' : '') + transcript;
          } else {
            interim = transcript;
          }
        }
        setContent(finalTranscript + (interim ? ' ' + interim : ''));
      };

      recognition.onend = () => {
        setRecording(false);
        setContent(finalTranscript);
      };

      recognition.onerror = () => {
        setRecording(false);
      };

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
          formData.append('model', 'whisper-1');

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
    if (recording) {
      stopVoice();
    } else {
      startVoice();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/20">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Quick Capture</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What's on your mind..."
            rows={5}
            className="w-full text-sm text-foreground placeholder:text-muted-foreground/50 bg-transparent focus:outline-none resize-none leading-relaxed"
          />
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/10">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleVoice}
              disabled={transcribing}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                recording
                  ? 'bg-destructive/10 text-destructive border border-destructive/30 animate-pulse'
                  : transcribing
                  ? 'bg-muted text-muted-foreground cursor-wait'
                  : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-accent border border-border'
              }`}
            >
              {transcribing ? (
                <Loader className="w-3 h-3 animate-spin" />
              ) : recording ? (
                <MicOff className="w-3 h-3" />
              ) : (
                <Mic className="w-3 h-3" />
              )}
              {transcribing ? 'Transcribing...' : recording ? 'Stop' : 'Voice'}
            </button>
            <span className="text-[11px] text-muted-foreground/60">⌘↵ to save</span>
          </div>

          <button
            onClick={handleSave}
            disabled={!content.trim() || saving}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-primary text-white hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {saving ? <Loader className="w-3 h-3 animate-spin" /> : null}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
