'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Plus } from 'lucide-react';

interface TagEditorProps {
  tags: string[];
  allTags?: string[];
  onChange: (tags: string[]) => void;
}

export default function TagEditor({ tags, allTags = [], onChange }: TagEditorProps) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = input.trim().length > 0
    ? allTags.filter(
        (t) =>
          t.toLowerCase().includes(input.toLowerCase()) &&
          !tags.includes(t)
      ).slice(0, 6)
    : [];

  const showDropdown = focused && suggestions.length > 0;

  const addTag = useCallback((raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag || tags.includes(tag)) {
      setInput('');
      return;
    }
    onChange([...tags, tag]);
    setInput('');
    setHighlightIndex(-1);
  }, [tags, onChange]);

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && suggestions[highlightIndex]) {
        addTag(suggestions[highlightIndex]);
      } else if (input.trim()) {
        addTag(input);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      setInput('');
      setHighlightIndex(-1);
      inputRef.current?.blur();
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    } else if (e.key === ',') {
      e.preventDefault();
      if (input.trim()) addTag(input);
    }
  };

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightIndex(-1);
  }, [input]);

  return (
    <div>
      {/* Existing tags as pills */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-muted border border-border text-muted-foreground"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="text-muted-foreground/50 hover:text-foreground transition-colors ml-0.5"
                tabIndex={-1}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="relative">
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder="Add a tag..."
            className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
          />
          <button
            type="button"
            onClick={() => { if (input.trim()) addTag(input); else inputRef.current?.focus(); }}
            className="flex items-center justify-center w-7 h-7 rounded-lg border border-border text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-all flex-shrink-0"
            tabIndex={-1}
            title="Add tag"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Autocomplete dropdown */}
        {showDropdown && (
          <div className="absolute left-0 right-8 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-lg overflow-hidden">
            {suggestions.map((s, i) => (
              <button
                key={s}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
                className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                  i === highlightIndex
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground/40 mt-1.5">Press Enter or , to add · Backspace to remove last</p>
    </div>
  );
}
