'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { ChevronDown, Loader as Loader2, RefreshCw } from 'lucide-react';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import { useAuth } from '@/lib/auth-context';
import { AdminUsage, getAdminUsage, isAdmin, USAGE_WINDOWS, UsageRequest, UsageTotals, UsageWindow } from '@/lib/admin-usage';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * AI spend and requests per person, which models served them, and the
 * OpenRouter balance. Visible only to accounts in public.app_admins.
 */

const WINDOW_LABELS: Record<UsageWindow, string> = { 1: 'Today', 7: '7 days', 30: '30 days', 90: '90 days' };

const FEATURE_LABELS: Record<string, string> = {
  'find-relevant-notes': 'Related-notes search',
  'chat-message': 'Chat',
  'handle-message': 'Ask a question',
  'process-note': 'Note processing',
  'guided-chat': 'Onboarding chat',
  'guided-notes': 'Onboarding notes',
  'extract-document': 'Document import',
  'embed-notes': 'Note embeddings',
  'semantic-retrieval': 'Semantic search',
};

/** Small amounts keep enough digits to tell apart; most requests cost fractions of a cent. */
function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function count(value: number): string {
  return value.toLocaleString();
}

function averageCost(totals: UsageTotals): number | null {
  const priced = totals.requests - totals.google_requests;
  return priced > 0 ? totals.cost_usd / priced : null;
}

/** "deepseek/deepseek-v4.1-flash: 22 · google/gemini-3.7-flash: 3", most used first. */
function countsLine(counts: Record<string, number> | null | undefined): string {
  return Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, calls]) => `${name} ×${calls}`)
    .join(' · ') || '—';
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
    <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    {note && <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
  </div>;
}

function StatusBadge({ status }: { status: UsageRequest['status'] }) {
  const styles = { ok: 'bg-emerald-500/10 text-emerald-600', cancelled: 'bg-amber-500/10 text-amber-600', failed: 'bg-red-500/10 text-red-600' };
  const labels = { ok: 'Done', cancelled: 'Cancelled', failed: 'Failed' };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[status]}`}>{labels[status]}</span>;
}

export default function AdminUsagePage() {
  const router = useRouter();
  const { user } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [days, setDays] = useState<UsageWindow>(7);
  const [usage, setUsage] = useState<AdminUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedUser, setSelectedUser] = useState<string | null | undefined>(undefined);
  const [openRequest, setOpenRequest] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!user) { router.replace('/auth'); return; }
    let active = true;
    isAdmin().then((admin) => { if (active) setAllowed(admin); });
    return () => { active = false; };
  }, [user, router]);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setLoading(true);
    setError('');
    getAdminUsage(days)
      .then((loaded) => { if (active) setUsage(loaded); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "Couldn't load usage right now."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [allowed, days, reloads]);

  // undefined: everyone; null: requests no signed-in user could be found for.
  const requests = useMemo(() => (usage?.recent ?? []).filter((request) => selectedUser === undefined || request.user_id === selectedUser), [usage, selectedUser]);
  const features = useMemo(() => Object.entries(usage?.features ?? {}).sort((a, b) => b[1].cost_usd - a[1].cost_usd || b[1].requests - a[1].requests), [usage]);

  const balance = usage?.openrouter;
  const accountLeft = balance?.account?.remaining_usd ?? null;
  const keyLeft = balance?.key?.remaining_usd ?? null;
  const keyLimit = balance?.key?.limit_usd ?? null;
  const lowBalance = (accountLeft !== null && balance?.account?.credits_usd && accountLeft < balance.account.credits_usd * 0.1)
    || (keyLeft !== null && keyLimit && keyLeft < keyLimit * 0.1);

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="mx-auto max-w-6xl px-4 pb-24 pt-4 sm:px-6 sm:pt-10">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">AI usage</h1>
              <p className="mt-1 text-sm text-muted-foreground">Spend, requests, and models per person. Only admins see this page.</p>
            </div>
            {allowed && <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-border bg-card p-0.5" role="radiogroup" aria-label="Time window">
                {USAGE_WINDOWS.map((window) => <button
                  key={window}
                  role="radio"
                  aria-checked={days === window}
                  onClick={() => setDays(window)}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${days === window ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                >{WINDOW_LABELS[window]}</button>)}
              </div>
              <button onClick={() => setReloads((value) => value + 1)} disabled={loading} aria-label="Reload" title="Reload" className="rounded-lg border border-border bg-card p-2 text-muted-foreground hover:text-foreground disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>}
          </div>

          {IS_LOCAL_MODE ? <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Usage is recorded by the Supabase functions, so it isn&apos;t available in local mode.</p>  /* DEV-LOCAL-MODE */
            : allowed === null ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking access…</div>
              : !allowed ? <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">This page is only for admins.</p>
                : error ? <p className="rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-600">{error}</p>
                  : !usage ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading usage…</div>
                    : <>
                      {balance && <section className={`mb-6 rounded-2xl border p-5 shadow-sm ${lowBalance ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-card'}`} aria-label="OpenRouter balance">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">OpenRouter balance</h2>
                          {lowBalance && <span className="text-xs font-medium text-amber-600">Running low: under 10% left</span>}
                        </div>
                        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                          <div><p className="text-[11px] text-muted-foreground">Account credit left</p><p className="text-xl font-semibold tabular-nums">{usd(accountLeft)}</p><p className="text-[11px] text-muted-foreground">of {usd(balance.account?.credits_usd)} bought</p></div>
                          <div><p className="text-[11px] text-muted-foreground">This key&apos;s limit left</p><p className="text-xl font-semibold tabular-nums">{keyLimit === null ? 'No limit' : usd(keyLeft)}</p>{keyLimit !== null && <p className="text-[11px] text-muted-foreground">of {usd(keyLimit)}</p>}</div>
                          <div><p className="text-[11px] text-muted-foreground">Key spend today</p><p className="text-xl font-semibold tabular-nums">{usd(balance.key?.used_today_usd)}</p></div>
                          <div><p className="text-[11px] text-muted-foreground">Key spend this month</p><p className="text-xl font-semibold tabular-nums">{usd(balance.key?.used_this_month_usd)}</p></div>
                        </div>
                        <p className="mt-3 text-[11px] text-muted-foreground">Straight from OpenRouter, so it includes any use outside this app.</p>
                      </section>}

                      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
                        <Tile label="Spend" value={usd(usage.totals.cost_usd)} note="OpenRouter, this window" />
                        <Tile label="Requests" value={count(usage.totals.requests)} note={`${count(usage.totals.calls)} AI calls`} />
                        <Tile label="Avg per request" value={usd(averageCost(usage.totals))} note="OpenRouter requests" />
                        <Tile label="Google requests" value={count(usage.totals.google_requests)} note="Not priced: billed by Google" />
                        <Tile label="Cancelled / failed" value={`${count(usage.totals.cancelled)} / ${count(usage.totals.failed)}`} />
                      </div>
                      {usage.truncated && <p className="mb-4 text-xs text-amber-600">This window has more requests than the page loads, so these totals are a lower bound.</p>}

                      <section className="mb-6 rounded-2xl border border-border bg-card p-5 shadow-sm" aria-label="Per person">
                        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Per person</h2>
                        {usage.users.length === 0 ? <p className="text-sm text-muted-foreground">No AI requests in this window.</p> : <div className="overflow-x-auto">
                          <table className="w-full min-w-[760px] text-left text-sm">
                            <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                              <tr><th className="py-2 pr-3 font-medium">Person</th><th className="py-2 pr-3 text-right font-medium">Spend</th><th className="py-2 pr-3 text-right font-medium">Requests</th><th className="py-2 pr-3 text-right font-medium">Avg / request</th><th className="py-2 pr-3 font-medium">Models used</th><th className="py-2 pr-3 font-medium">Last active</th></tr>
                            </thead>
                            <tbody>
                              {usage.users.map((person) => {
                                const selected = selectedUser === person.user_id;
                                return <tr key={person.user_id ?? 'unknown'} onClick={() => setSelectedUser(selected ? undefined : person.user_id)} className={`cursor-pointer border-t border-border align-top hover:bg-muted/40 ${selected ? 'bg-muted/60' : ''}`} title="Show this person's requests below">
                                  <td className="py-2 pr-3"><span className="font-medium text-foreground">{person.email ?? (person.user_id ? person.user_id.slice(0, 8) : 'Not signed in')}</span><span className="block text-[11px] text-muted-foreground">{Object.entries(person.features).sort((a, b) => b[1].requests - a[1].requests).map(([feature, totals]) => `${FEATURE_LABELS[feature] ?? feature} ${totals.requests}`).join(' · ')}</span></td>
                                  <td className="py-2 pr-3 text-right font-medium tabular-nums">{usd(person.cost_usd)}</td>
                                  <td className="py-2 pr-3 text-right tabular-nums">{count(person.requests)}{person.cancelled + person.failed > 0 && <span className="block text-[11px] text-muted-foreground">{person.cancelled} cancelled · {person.failed} failed</span>}</td>
                                  <td className="py-2 pr-3 text-right tabular-nums">{usd(averageCost(person))}</td>
                                  <td className="py-2 pr-3 text-[12px] text-muted-foreground">{countsLine(person.models)}<span className="block text-[11px]">via {countsLine(person.providers)}</span></td>
                                  <td className="py-2 pr-3 text-[12px] text-muted-foreground">{format(new Date(person.last_at), 'MMM d, HH:mm')}</td>
                                </tr>;
                              })}
                            </tbody>
                          </table>
                        </div>}
                      </section>

                      {features.length > 0 && <section className="mb-6 rounded-2xl border border-border bg-card p-5 shadow-sm" aria-label="Per feature">
                        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Per feature</h2>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {features.map(([feature, totals]) => <div key={feature} className="flex items-baseline justify-between gap-3 rounded-lg border border-border px-3 py-2">
                            <span className="text-sm text-foreground">{FEATURE_LABELS[feature] ?? feature}</span>
                            <span className="text-right text-[12px] tabular-nums text-muted-foreground"><span className="font-medium text-foreground">{totals.google_requests === totals.requests ? 'Google' : usd(totals.cost_usd)}</span> · {count(totals.requests)} req</span>
                          </div>)}
                        </div>
                      </section>}

                      <section className="rounded-2xl border border-border bg-card p-5 shadow-sm" aria-label="Recent requests">
                        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent requests{selectedUser !== undefined && ' · one person'}</h2>
                          {selectedUser !== undefined && <button onClick={() => setSelectedUser(undefined)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">Show everyone</button>}
                        </div>
                        {requests.length === 0 ? <p className="text-sm text-muted-foreground">No requests to show.</p> : <div className="overflow-x-auto">
                          <table className="w-full min-w-[860px] text-left text-sm">
                            <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                              <tr><th className="py-2 pr-3 font-medium">When</th><th className="py-2 pr-3 font-medium">Person</th><th className="py-2 pr-3 font-medium">Feature</th><th className="py-2 pr-3 font-medium">Model</th><th className="py-2 pr-3 text-right font-medium">Calls</th><th className="py-2 pr-3 text-right font-medium">Tokens in / out</th><th className="py-2 pr-3 text-right font-medium">Cost</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2" /></tr>
                            </thead>
                            <tbody>
                              {requests.map((request) => {
                                const open = openRequest === request.id;
                                return <Fragment key={request.id}>
                                  <tr onClick={() => setOpenRequest(open ? null : request.id)} className="cursor-pointer border-t border-border hover:bg-muted/40">
                                    <td className="whitespace-nowrap py-2 pr-3 text-[12px] text-muted-foreground">{format(new Date(request.created_at), 'MMM d, HH:mm:ss')}</td>
                                    <td className="max-w-[180px] truncate py-2 pr-3">{request.email ?? (request.user_id ? request.user_id.slice(0, 8) : 'Not signed in')}</td>
                                    <td className="py-2 pr-3">{FEATURE_LABELS[request.feature] ?? request.feature}</td>
                                    <td className="py-2 pr-3 text-[12px] text-muted-foreground">{request.model ?? '—'}{request.tier && <span className="ml-1 rounded bg-muted px-1 text-[10px]">{request.tier}</span>}</td>
                                    <td className="py-2 pr-3 text-right tabular-nums">{request.calls}</td>
                                    <td className="py-2 pr-3 text-right text-[12px] tabular-nums text-muted-foreground">{count(request.input_tokens)} / {count(request.output_tokens)}</td>
                                    <td className="py-2 pr-3 text-right font-medium tabular-nums">{request.billed_by === 'google' ? 'Google' : usd(request.cost_usd)}</td>
                                    <td className="py-2 pr-3"><StatusBadge status={request.status} /></td>
                                    <td className="py-2 text-muted-foreground"><ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} /></td>
                                  </tr>
                                  {open && <tr className="border-t border-border bg-muted/30">
                                    <td colSpan={9} className="px-3 py-3 text-[12px] text-muted-foreground">
                                      <p><span className="font-medium text-foreground">Answered by:</span> {countsLine(request.models)} <span className="ml-2 font-medium text-foreground">via</span> {countsLine(request.providers)}</p>
                                      {request.steps && Object.keys(request.steps).length > 0 && <p className="mt-1"><span className="font-medium text-foreground">Steps:</span> {Object.entries(request.steps).map(([step, part]) => `${step}: ${part.calls} call${part.calls === 1 ? '' : 's'}, ${count(part.input_tokens)} in / ${count(part.output_tokens)} out${part.cost_usd === null ? '' : `, ${usd(part.cost_usd)}`}`).join(' · ')}</p>}
                                      <p className="mt-1"><span className="font-medium text-foreground">Took:</span> {request.duration_ms === null ? '—' : `${(request.duration_ms / 1000).toFixed(1)}s`}{request.reasoning_tokens > 0 && <span className="ml-2">({count(request.reasoning_tokens)} of the output tokens were reasoning)</span>}</p>
                                    </td>
                                  </tr>}
                                </Fragment>;
                              })}
                            </tbody>
                          </table>
                          {usage.recent.length >= 100 && <p className="mt-2 text-[11px] text-muted-foreground">Showing the latest 100 requests in this window.</p>}
                        </div>}
                      </section>
                    </>}
        </div>
      </SidebarMain>
    </div>
  );
}
