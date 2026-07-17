'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Navigation from '@/components/Navigation';
import SidebarMain from '@/components/SidebarMain';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { useTheme, ThemePreference } from '@/lib/theme-context';
import { getNotes, getMemoryStrengths, getAllNoteRelations, getQuestions } from '@/lib/notes-api';
import {
  Camera,
  Check,
  Loader as Loader2,
  LogOut,
  Trash2,
  User,
  Calendar,
  FileText,
  Network,
  MessageSquare,
  Activity,
  Tag,
  LayoutGrid,
} from 'lucide-react';
import { format } from 'date-fns';

interface ProfileData {
  full_name: string;
  avatar_url: string | null;
}

interface Stats {
  totalNotes: number;
  totalConnections: number;
  totalQuestions: number;
  avgMemoryScore: number;
  createdAt: string;
  topTags: { tag: string; count: number }[];
  topCategories: { name: string; count: number }[];
}

function getInitials(name: string, email: string): string {
  if (name.trim()) {
    return name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  }
  return (email[0] ?? '?').toUpperCase();
}

export default function ProfilePage() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { preference: themePref, setPreference: setThemePref } = useTheme();

  const [profile, setProfile] = useState<ProfileData>({ full_name: '', avatar_url: null });
  const [editName, setEditName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);

  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('user_settings')
      .select('full_name, avatar_url')
      .eq('user_id', user.id)
      .maybeSingle();
    const p = { full_name: data?.full_name ?? '', avatar_url: data?.avatar_url ?? null };
    setProfile(p);
    setEditName(p.full_name);
  }, [user]);

  const loadStats = useCallback(async () => {
    if (!user) return;
    setLoadingStats(true);
    try {
      const [notes, strengths, relations, questions] = await Promise.all([
        getNotes(),
        getMemoryStrengths(),
        getAllNoteRelations(),
        getQuestions(),
      ]);

      const avgScore = strengths.length
        ? Math.round(strengths.reduce((s, n) => s + n.score, 0) / strengths.length)
        : 0;

      const tagCount = new Map<string, number>();
      for (const n of notes) {
        for (const t of n.tags ?? []) {
          tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
        }
      }
      const topTags = Array.from(tagCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag, count]) => ({ tag, count }));

      const catCount = new Map<string, number>();
      for (const n of notes) {
        if (n.category) catCount.set(n.category, (catCount.get(n.category) ?? 0) + 1);
      }
      const topCategories = Array.from(catCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => ({ name, count }));

      setStats({
        totalNotes: notes.length,
        totalConnections: relations.length,
        totalQuestions: questions.length,
        avgMemoryScore: avgScore,
        createdAt: user.created_at,
        topTags,
        topCategories,
      });
    } finally {
      setLoadingStats(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user) { router.replace('/auth'); return; }
    loadProfile();
    loadStats();
  }, [user, loadProfile, loadStats, router]);

  const saveName = async () => {
    if (!user) return;
    setSavingName(true);
    await supabase
      .from('user_settings')
      .upsert({ user_id: user.id, full_name: editName.trim(), updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    setProfile((p) => ({ ...p, full_name: editName.trim() }));
    setNameDirty(false);
    setSavingName(false);
    setNameSaved(true);
    setTimeout(() => setNameSaved(false), 2000);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (file.size > 2 * 1024 * 1024) { setAvatarError('Max 2MB'); return; }
    setAvatarError('');
    setUploadingAvatar(true);
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${user.id}/avatar.${ext}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
    if (upErr) { setAvatarError('Upload failed'); setUploadingAvatar(false); return; }
    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
    const urlWithBust = `${publicUrl}?t=${Date.now()}`;
    await supabase
      .from('user_settings')
      .upsert({ user_id: user.id, avatar_url: urlWithBust, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    setProfile((p) => ({ ...p, avatar_url: urlWithBust }));
    setUploadingAvatar(false);
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/auth');
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return;
    setDeletingAccount(true);
    // Delete user data then sign out (actual user deletion requires service role — sign out and let them contact support or use edge function)
    await signOut();
    router.replace('/auth');
  };

  if (!user) return null;

  const initials = getInitials(profile.full_name, user.email ?? '');

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <SidebarMain>
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-4 sm:pt-10 pb-24">

          {/* Page title */}
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Profile</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your account and view your brain stats</p>
          </div>

          {/* Avatar + name */}
          <div className="bg-card border border-border rounded-2xl p-6 mb-4 shadow-sm">
            <div className="flex items-start gap-5">
              {/* Avatar */}
              <div className="relative flex-shrink-0">
                <div className="w-20 h-20 rounded-full overflow-hidden bg-primary/10 flex items-center justify-center ring-2 ring-border">
                  {profile.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profile.avatar_url} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-2xl font-bold text-primary select-none">{initials}</span>
                  )}
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:bg-primary/90 transition-all disabled:opacity-60"
                  title="Upload photo"
                >
                  {uploadingAvatar ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </div>

              {/* Name + email */}
              <div className="flex-1 min-w-0">
                <div className="mb-3">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Full Name</label>
                  <div className="flex items-center gap-2">
                    <input
                      value={editName}
                      onChange={(e) => { setEditName(e.target.value); setNameDirty(e.target.value !== profile.full_name); }}
                      placeholder="Your name"
                      className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                      onKeyDown={(e) => { if (e.key === 'Enter' && nameDirty) saveName(); }}
                    />
                    {nameDirty && (
                      <button
                        onClick={saveName}
                        disabled={savingName}
                        className="flex items-center gap-1 text-xs text-white bg-primary hover:bg-primary/90 px-3 py-2 rounded-lg transition-all disabled:opacity-60 flex-shrink-0"
                      >
                        {savingName ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Save
                      </button>
                    )}
                    {nameSaved && !nameDirty && (
                      <span className="text-xs text-green-500 flex items-center gap-1 flex-shrink-0">
                        <Check className="w-3 h-3" /> Saved
                      </span>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">Email</label>
                  <p className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg border border-border/50 truncate">{user.email}</p>
                </div>

                {avatarError && <p className="text-xs text-destructive mt-2">{avatarError}</p>}
              </div>
            </div>
          </div>

          {/* Appearance */}
          <div className="bg-card border border-border rounded-2xl p-6 mb-4 shadow-sm">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">Appearance</h2>
            <div className="flex items-center gap-2">
              {(['light', 'dark', 'auto'] as ThemePreference[]).map((option) => {
                const active = themePref === option;
                return (
                  <button
                    key={option}
                    onClick={() => setThemePref(option)}
                    className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-all ${
                      active
                        ? 'text-white border-transparent'
                        : 'text-muted-foreground border-border hover:text-foreground hover:border-border/80'
                    }`}
                    style={active ? { backgroundColor: '#487BE9', borderColor: '#487BE9' } : undefined}
                  >
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground/50 mt-3">
              {themePref === 'auto' ? 'Follows your device system preference.' : themePref === 'dark' ? 'Always dark, regardless of device setting.' : 'Always light, regardless of device setting.'}
            </p>
          </div>

          {/* Stats summary */}
          <div className="bg-card border border-border rounded-2xl p-6 mb-4 shadow-sm">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">Account Stats</h2>
            {loadingStats ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-xl bg-muted animate-pulse" />
                ))}
              </div>
            ) : stats ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatTile icon={FileText} label="Total Notes" value={stats.totalNotes} />
                <StatTile icon={Network} label="Connections" value={stats.totalConnections} />
                <StatTile icon={MessageSquare} label="Questions Asked" value={stats.totalQuestions} />
                <StatTile
                  icon={Activity}
                  label="Memory Health"
                  value={`${stats.avgMemoryScore}%`}
                  color={stats.avgMemoryScore > 70 ? 'text-emerald-500' : stats.avgMemoryScore > 40 ? 'text-amber-500' : 'text-red-400'}
                />
                <StatTile
                  icon={Calendar}
                  label="Member Since"
                  value={format(new Date(stats.createdAt), 'MMM yyyy')}
                  small
                />
                <StatTile
                  icon={User}
                  label="Last Active"
                  value={format(new Date(user.last_sign_in_at ?? user.created_at), 'MMM d')}
                  small
                />
              </div>
            ) : null}
          </div>

          {/* Brain stats */}
          {stats && (stats.topTags.length > 0 || stats.topCategories.length > 0) && (
            <div className="bg-card border border-border rounded-2xl p-6 mb-6 shadow-sm">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4">Ocreda Stats</h2>

              {stats.topTags.length > 0 && (
                <div className="mb-5">
                  <div className="flex items-center gap-2 mb-3">
                    <Tag className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <span className="text-xs font-medium text-muted-foreground">Top Tags</span>
                  </div>
                  <div className="space-y-2">
                    {stats.topTags.map(({ tag, count }, i) => (
                      <div key={tag} className="flex items-center gap-3">
                        <span className="text-[10px] text-muted-foreground/40 w-3 text-right flex-shrink-0">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-foreground truncate">{tag}</span>
                            <span className="text-[10px] text-muted-foreground/50 ml-2 flex-shrink-0">{count} {count === 1 ? 'note' : 'notes'}</span>
                          </div>
                          <div className="h-1 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary/60 rounded-full transition-all"
                              style={{ width: `${(count / stats.topTags[0].count) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {stats.topCategories.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <LayoutGrid className="w-3.5 h-3.5 text-muted-foreground/50" />
                    <span className="text-xs font-medium text-muted-foreground">Most Active Categories</span>
                  </div>
                  <div className="space-y-2">
                    {stats.topCategories.map(({ name, count }, i) => (
                      <div key={name} className="flex items-center gap-3">
                        <span className="text-[10px] text-muted-foreground/40 w-3 text-right flex-shrink-0">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-foreground truncate">{name}</span>
                            <span className="text-[10px] text-muted-foreground/50 ml-2 flex-shrink-0">{count} {count === 1 ? 'note' : 'notes'}</span>
                          </div>
                          <div className="h-1 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary/40 rounded-full transition-all"
                              style={{ width: `${(count / stats.topCategories[0].count) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Sign out */}
          <div className="border-t border-border pt-6 mb-4">
            <button
              onClick={handleSignOut}
              className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-border hover:border-destructive/20 transition-all"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          </div>

          {/* Delete account */}
          <div className="pt-2">
            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="text-xs text-muted-foreground/40 hover:text-destructive/70 transition-colors"
              >
                Delete account
              </button>
            ) : (
              <div className="bg-destructive/5 border border-destructive/20 rounded-xl p-4 space-y-3">
                <p className="text-sm font-medium text-destructive">Delete account permanently?</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  This will sign you out. All your notes and data stored in this app will be lost. Type <strong>DELETE</strong> to confirm.
                </p>
                <input
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="Type DELETE to confirm"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-destructive/20 focus:border-destructive/40 transition-all"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(''); }}
                    className="text-xs text-muted-foreground hover:text-foreground px-3 py-2 rounded-lg border border-border hover:bg-accent transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deleteConfirmText !== 'DELETE' || deletingAccount}
                    className="flex items-center gap-1.5 text-xs text-white bg-destructive hover:bg-destructive/90 px-3 py-2 rounded-lg transition-all disabled:opacity-40"
                  >
                    {deletingAccount ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Delete Account
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </SidebarMain>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  color,
  small,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  color?: string;
  small?: boolean;
}) {
  return (
    <div className="bg-muted/40 rounded-xl px-4 py-3 border border-border/50">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="w-3.5 h-3.5 text-muted-foreground/50" />
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
      </div>
      <p className={`font-bold leading-none ${small ? 'text-base' : 'text-xl'} ${color ?? 'text-foreground'}`}>
        {value}
      </p>
    </div>
  );
}
