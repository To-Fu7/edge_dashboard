'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
  last_login_at: string | null;
}

const ROLE_ITEMS = { admin: 'Admin — everything', user: 'Viewer — live CCTV and dashboard' };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' as 'admin' | 'user' });
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api('/api/users')).users);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api('/api/users'), api('/api/auth/me')])
      .then(([u, m]) => { if (!cancelled) { setUsers(u.users); setMe(m.user?.id ?? null); } })
      .catch(e => toast.error((e as Error).message));
    return () => { cancelled = true; };
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify(newUser) });
      toast.success(`Added ${newUser.username}`);
      setNewUser({ username: '', password: '', role: 'user' });
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function setRole(u: User, role: 'admin' | 'user') {
    try {
      await api(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ role }) });
      toast.success(`${u.username} is now ${role === 'admin' ? 'an admin' : 'a viewer'}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function resetPassword(u: User) {
    try {
      await api(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ password: newPassword }) });
      toast.success(`Password changed for ${u.username}`);
      setResetFor(null);
      setNewPassword('');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(u: User) {
    setConfirmDelete(null);
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      toast.success(`Deleted ${u.username}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Admins can change everything. Viewers see only the live CCTV and the detection dashboard.
          Changing a password or role signs that user out.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {users === null ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 font-medium">Username</th>
                    <th className="py-2 pr-4 font-medium">Role</th>
                    <th className="py-2 pr-4 font-medium">Last sign-in</th>
                    <th className="py-2 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} className="border-b border-border last:border-0 align-top">
                      <td className="py-2 pr-4">
                        {u.username}
                        {u.id === me && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                      </td>
                      <td className="py-2 pr-4 w-56">
                        <Select items={ROLE_ITEMS} value={u.role} onValueChange={v => v && v !== u.role && setRole(u, v as 'admin' | 'user')}>
                          <SelectTrigger className="w-full" aria-label={`Role of ${u.username}`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">{ROLE_ITEMS.admin}</SelectItem>
                            <SelectItem value="user">{ROLE_ITEMS.user}</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground tabular-nums">
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {resetFor === u.id ? (
                          <span className="inline-flex items-center gap-1">
                            <Input type="password" placeholder="New password" value={newPassword}
                              onChange={e => setNewPassword(e.target.value)} className="h-8 w-40" aria-label="New password" />
                            <Button size="sm" onClick={() => resetPassword(u)} disabled={newPassword.length < 4}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => { setResetFor(null); setNewPassword(''); }}>Cancel</Button>
                          </span>
                        ) : confirmDelete === u.id ? (
                          <span className="inline-flex items-center gap-1">
                            <Button size="sm" variant="destructive" onClick={() => remove(u)}>Delete</Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setResetFor(u.id)} aria-label={`Change password of ${u.username}`}>
                              <KeyRound className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(u.id)} disabled={u.id === me}
                              aria-label={`Delete ${u.username}`}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add user</CardTitle>
          <CardDescription>Usernames: letters, digits, &quot;.&quot;, &quot;_&quot; or &quot;-&quot;. Passwords: at least 4 characters.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="new-username">Username</Label>
              <Input id="new-username" value={newUser.username} onChange={e => setNewUser(n => ({ ...n, username: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Password</Label>
              <Input id="new-password" type="password" value={newUser.password} onChange={e => setNewUser(n => ({ ...n, password: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-role">Role</Label>
              <Select items={ROLE_ITEMS} value={newUser.role} onValueChange={v => v && setNewUser(n => ({ ...n, role: v as 'admin' | 'user' }))}>
                <SelectTrigger id="new-role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{ROLE_ITEMS.user}</SelectItem>
                  <SelectItem value="admin">{ROLE_ITEMS.admin}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!newUser.username || newUser.password.length < 4}>
              <Plus className="w-4 h-4 mr-1.5" />Add
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
