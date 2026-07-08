'use client';

import { useState, useEffect, useCallback } from 'react';

import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import GuestSignupPrompt from '@/components/GuestSignupPrompt';
import { useGuest } from '@/lib/guest-context';
import { WeeklyReport } from '@/lib/types';
import { getWeeklyReports, generateWeeklyReport } from '@/lib/notes-api';
import { FileText, Loader, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { format, startOfWeek, endOfWeek, subWeeks } from 'date-fns';

function getWeekBounds(offsetWeeks: number = 0): { start: string; end: string } {
  const now = subWeeks(new Date(), offsetWeeks);
  const start = startOfWeek(now, { weekStartsOn: 1 });
  const end = endOfWeek(now, { weekStartsOn: 1 });
  return {
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
  };
}

export default function ReportsPage() {
  const { isGuest } = useGuest();
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showSignupPrompt, setShowSignupPrompt] = useState(false);

  const loadReports = useCallback(async () => {
    if (isGuest) { setLoadingReports(false); return; }
    try {
      const data = await getWeeklyReports();
      setReports(data);
      if (data.length > 0) setExpanded(data[0].id);
    } finally {
      setLoadingReports(false);
    }
  }, [isGuest]);

  useEffect(() => { loadReports(); }, [loadReports]);

  const handleGenerateThisWeek = async () => {
    if (isGuest) { setShowSignupPrompt(true); return; }
    setGenerating(true);
    setError('');
    try {
      const { start, end } = getWeekBounds(0);
      const report = await generateWeeklyReport(start, end);
      setReports((prev) => {
        const filtered = prev.filter((r) => r.week_start !== start);
        return [report, ...filtered];
      });
      setExpanded(report.id);
    } catch (e) {
      setError('Failed to generate report. Try again.');
    } finally {
      setGenerating(false);
    }
  };

  const thisWeek = getWeekBounds(0);
  const hasThisWeek = reports.some((r) => r.week_start === thisWeek.start);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
          <div className="flex items-start sm:items-center justify-between gap-3 mb-6 sm:mb-8">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">Weekly Reports</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                A letter about your mind, written every week
              </p>
            </div>
            <div className="flex items-center gap-2">
                <button
              onClick={handleGenerateThisWeek}
              disabled={generating}
              className="flex-shrink-0 flex items-center gap-2 bg-primary hover:bg-primary/90 text-white text-sm font-medium px-3 sm:px-4 py-2.5 rounded-xl shadow-sm shadow-primary/20 transition-all disabled:opacity-60 min-h-[44px]"
            >
              {generating ? (
                <Loader className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{generating ? 'Generating...' : hasThisWeek ? 'Regenerate this week' : 'Generate this week'}</span>
              <span className="sm:hidden">{generating ? '...' : hasThisWeek ? 'Regenerate' : 'Generate'}</span>
            </button>
            </div>
          </div>

          {isGuest && (
            <div className="mb-5 px-4 py-3 bg-primary/5 border border-primary/20 rounded-xl text-sm text-muted-foreground">
              Weekly reports summarize everything you've learned.{' '}
              <button onClick={() => setShowSignupPrompt(true)} className="text-primary hover:underline font-medium">Sign up free</button> to generate them.
            </div>
          )}

          {error && (
            <div className="mb-4 px-4 py-3 bg-destructive/10 text-destructive text-sm rounded-xl border border-destructive/20">
              {error}
            </div>
          )}

          {loadingReports ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-2xl p-5 h-24 animate-pulse" />
              ))}
            </div>
          ) : reports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <FileText className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-foreground mb-1">No reports yet</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-xs">
                Generate your first weekly report to see a narrative summary of your thinking this week.
              </p>
              <button
                onClick={handleGenerateThisWeek}
                disabled={generating}
                className="flex items-center gap-2 bg-primary text-white text-sm font-medium px-4 py-2 rounded-xl shadow-sm shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-60"
              >
                {generating ? <Loader className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                {generating ? 'Generating...' : 'Generate report'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {reports.map((report) => {
                const isOpen = expanded === report.id;
                const weekStart = new Date(report.week_start + 'T00:00:00');
                const weekEnd = new Date(report.week_end + 'T00:00:00');
                return (
                  <div key={report.id} className="bg-card border border-border rounded-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded(isOpen ? null : report.id)}
                      className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-muted/30 transition-all"
                    >
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          Week of {format(weekStart, 'MMMM d')} – {format(weekEnd, 'MMMM d, yyyy')}
                        </p>
                        <div className="flex items-center gap-3 mt-1">
                          {report.stats && (
                            <>
                              <span className="text-[11px] text-muted-foreground">{report.stats.notes_added} notes</span>
                              <span className="text-[11px] text-muted-foreground">{report.stats.questions_asked} questions</span>
                              <span className="text-[11px] text-muted-foreground">{report.stats.connections_formed} connections</span>
                            </>
                          )}
                        </div>
                      </div>
                      {isOpen ? (
                        <ChevronUp className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      )}
                    </button>

                    {isOpen && (
                      <div className="px-5 pb-6 border-t border-border/50">
                        <div className="pt-4 prose prose-sm max-w-none">
                          {report.report_text.split('\n\n').map((para, i) => (
                            <p key={i} className="text-sm text-foreground leading-relaxed mb-4 last:mb-0">
                              {para}
                            </p>
                          ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground/60 mt-4">
                          Generated {format(new Date(report.created_at), 'MMM d, yyyy · h:mm a')}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SidebarMain>

      {showSignupPrompt && (
        <GuestSignupPrompt
          onClose={() => setShowSignupPrompt(false)}
          message="Create a free account to generate weekly reports — a letter about your mind, every week."
        />
      )}
    </div>
  );
}
