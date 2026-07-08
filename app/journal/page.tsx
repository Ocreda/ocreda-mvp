'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import { getJournalEntries, getJournalStreak, JournalEntry } from '@/lib/notes-api';
import { ChevronLeft, ChevronRight, PenLine, Flame } from 'lucide-react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isSameMonth, isToday, parseISO } from 'date-fns';

const MOOD_DOT_COLOR: Record<number, string> = {
  1: '#b34040',
  2: '#e07a3a',
  3: '#d4a820',
  4: '#7bbf6a',
  5: '#2db552',
};
const MOOD_LABEL: Record<number, string> = {
  1: 'Very low',
  2: 'Low',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
};

function todayStr(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

export default function JournalPage() {
  const router = useRouter();
  const [viewDate, setViewDate] = useState(new Date());
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadMonth = useCallback(async (d: Date) => {
    setLoading(true);
    try {
      const [monthEntries, s] = await Promise.all([
        getJournalEntries(d.getFullYear(), d.getMonth() + 1),
        getJournalStreak(),
      ]);
      setEntries(monthEntries);
      setStreak(s);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMonth(viewDate); }, [loadMonth, viewDate]);

  const entryMap = new Map(entries.map((e) => [e.date, e]));
  const monthStart = startOfMonth(viewDate);
  const monthEnd = endOfMonth(viewDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const paddingBefore = getDay(monthStart);

  const prevMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const nextMonth = () => setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));

  const today = todayStr();

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">

          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold text-foreground tracking-tight">Journal</h1>
              <p className="text-sm text-muted-foreground mt-1">Your private space to think out loud.</p>
            </div>
            <button
              onClick={() => router.push(`/journal/${today}`)}
              className="flex items-center gap-2 px-4 py-2.5 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary/90 transition-all shadow-sm shadow-primary/20 flex-shrink-0"
            >
              <PenLine className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Write today</span>
              <span className="sm:hidden">Today</span>
            </button>
          </div>

          {/* Streak */}
          {streak > 0 && (
            <div className="flex items-center gap-2 mb-6 px-4 py-3 bg-card border border-border rounded-2xl w-fit">
              <Flame className="w-4 h-4 text-orange-400" />
              <span className="text-sm font-semibold text-foreground">{streak}</span>
              <span className="text-sm text-muted-foreground">day streak</span>
            </div>
          )}

          {/* Calendar */}
          <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
            {/* Month nav */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <button
                onClick={prevMonth}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h2 className="text-sm font-semibold text-foreground">
                {format(viewDate, 'MMMM yyyy')}
              </h2>
              <button
                onClick={nextMonth}
                disabled={isSameMonth(viewDate, new Date())}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Day headers */}
            <div className="grid grid-cols-7 border-b border-border/50">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} className="py-2.5 text-center text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                  {d}
                </div>
              ))}
            </div>

            {/* Days grid */}
            {loading ? (
              <div className="grid grid-cols-7 gap-px p-3">
                {Array.from({ length: 35 }).map((_, i) => (
                  <div key={i} className="aspect-square rounded-lg bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-px p-3">
                {Array.from({ length: paddingBefore }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}
                {days.map((day) => {
                  const dateStr = format(day, 'yyyy-MM-dd');
                  const entry = entryMap.get(dateStr);
                  const isTodayDay = dateStr === today;
                  const hasEntry = !!entry;
                  const mood = entry?.mood;
                  const isFuture = dateStr > today;

                  return (
                    <button
                      key={dateStr}
                      onClick={() => !isFuture && router.push(`/journal/${dateStr}`)}
                      disabled={isFuture}
                      className={`
                        relative aspect-square rounded-xl flex flex-col items-center justify-center gap-0.5
                        text-sm font-medium transition-all
                        ${isFuture ? 'opacity-25 cursor-not-allowed' : 'cursor-pointer hover:bg-accent'}
                        ${isTodayDay ? 'ring-1 ring-primary ring-offset-1 ring-offset-card' : ''}
                        ${hasEntry && !mood ? 'bg-primary/8' : ''}
                      `}
                    >
                      <span className={`text-xs sm:text-sm leading-none ${isTodayDay ? 'text-primary font-bold' : 'text-foreground'}`}>
                        {format(day, 'd')}
                      </span>
                      {hasEntry && (
                        <span
                          className="rounded-full flex-shrink-0"
                          style={{
                            width: 6,
                            height: 6,
                            backgroundColor: mood ? MOOD_DOT_COLOR[mood] : 'hsl(var(--primary) / 0.5)',
                          }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Mood legend */}
          <div className="flex items-center gap-3 mt-4 px-1 flex-wrap">
            <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider font-medium">Mood</span>
            {[1, 2, 3, 4, 5].map((m) => (
              <div key={m} className="flex items-center gap-1.5">
                <span
                  className="rounded-full"
                  style={{ width: 8, height: 8, backgroundColor: MOOD_DOT_COLOR[m], display: 'inline-block' }}
                />
                <span className="text-[11px] text-muted-foreground/50">{MOOD_LABEL[m]}</span>
              </div>
            ))}
          </div>

          {/* Recent entries */}
          {entries.length > 0 && (
            <div className="mt-8 space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                {format(viewDate, 'MMMM')} entries
              </h3>
              {[...entries].reverse().slice(0, 10).map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => router.push(`/journal/${entry.date}`)}
                  className="w-full text-left bg-card border border-border rounded-xl px-4 py-3 hover:border-primary/30 hover:bg-accent/40 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    {entry.mood && (
                      <span
                        className="rounded-full flex-shrink-0"
                        style={{ width: 8, height: 8, backgroundColor: MOOD_DOT_COLOR[entry.mood], display: 'inline-block' }}
                      />
                    )}
                    <span className="text-xs font-semibold text-muted-foreground w-24 flex-shrink-0">
                      {format(parseISO(entry.date), 'EEE, MMM d')}
                    </span>
                    <p className="text-sm text-foreground truncate group-hover:text-primary transition-colors flex-1">
                      {entry.content.split('\n')[0] || 'Entry'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </SidebarMain>
    </div>
  );
}
