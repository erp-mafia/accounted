'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'

interface AllowlistEntry {
  id: string
  email: string
  note: string | null
  created_at: string
}

interface AccessData {
  brand: { domain: string; appName: string; signupMode: 'open' | 'invite_only' }
  role: 'owner' | 'admin' | 'member'
  entries: AllowlistEntry[]
}

/**
 * Invite-only signup management (2026-08-27): the mode switch and the email
 * allowlist for the byrå's brand domain. Company invites bypass the list, so
 * this list only governs who can create an account cold on the domain.
 */
export default function SignupAccessManager({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('clients')
  const { toast } = useToast()
  const [data, setData] = useState<AccessData | null>(null)
  const [loadError, setLoadError] = useState<'no_brand' | 'failed' | null>(null)
  const [savingMode, setSavingMode] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/clients/signup-access', { cache: 'no-store' })
      if (res.status === 404) {
        setLoadError('no_brand')
        return
      }
      if (!res.ok) {
        setLoadError('failed')
        return
      }
      const json = (await res.json()) as { data: AccessData }
      setData(json.data)
      setLoadError(null)
    } catch {
      setLoadError('failed')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggleMode = async (inviteOnly: boolean) => {
    if (!data) return
    setSavingMode(true)
    const previous = data.brand.signupMode
    setData({
      ...data,
      brand: { ...data.brand, signupMode: inviteOnly ? 'invite_only' : 'open' },
    })
    try {
      const res = await fetch('/api/clients/signup-access', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signup_mode: inviteOnly ? 'invite_only' : 'open' }),
      })
      if (!res.ok) throw new Error(`PATCH failed: ${res.status}`)
    } catch {
      setData((current) =>
        current
          ? { ...current, brand: { ...current.brand, signupMode: previous } }
          : current,
      )
      toast({ title: t('access_save_failed'), variant: 'destructive' })
    } finally {
      setSavingMode(false)
    }
  }

  const addEntry = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!email.trim() || !data) return
    setAdding(true)
    try {
      const res = await fetch('/api/clients/signup-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          note: note.trim() || undefined,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title:
            res.status === 409
              ? t('access_duplicate')
              : t('access_save_failed'),
          variant: 'destructive',
        })
        return
      }
      // Functional update: a concurrent mode toggle or remove must not be
      // clobbered by the `data` snapshot captured when this request started.
      setData((current) =>
        current
          ? { ...current, entries: [json.data as AllowlistEntry, ...current.entries] }
          : current,
      )
      setEmail('')
      setNote('')
    } catch {
      toast({ title: t('access_save_failed'), variant: 'destructive' })
    } finally {
      setAdding(false)
    }
  }

  const removeEntry = async (id: string) => {
    if (!data) return
    setRemovingId(id)
    try {
      const res = await fetch('/api/clients/signup-access', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`DELETE failed: ${res.status}`)
      // Functional update: see addEntry. Avoids clobbering a concurrent
      // mode toggle or add with a stale snapshot.
      setData((current) =>
        current
          ? { ...current, entries: current.entries.filter((entry) => entry.id !== id) }
          : current,
      )
    } catch {
      toast({ title: t('access_save_failed'), variant: 'destructive' })
    } finally {
      setRemovingId(null)
    }
  }

  if (loadError === 'no_brand') {
    return <p className="text-sm text-muted-foreground">{t('access_no_brand')}</p>
  }
  if (loadError === 'failed') {
    return <p className="text-sm text-muted-foreground">{t('access_load_failed')}</p>
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const inviteOnly = data.brand.signupMode === 'invite_only'

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-border p-6 space-y-1">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">
              {t('access_mode_label', { domain: data.brand.domain })}
            </p>
            <p className="text-[13px] text-muted-foreground leading-relaxed mt-1">
              {t('access_mode_hint')}
            </p>
          </div>
          <Switch
            checked={inviteOnly}
            disabled={!canEdit || savingMode}
            onCheckedChange={(checked) => void toggleMode(checked)}
            aria-label={t('access_mode_label', { domain: data.brand.domain })}
          />
        </div>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('access_readonly_hint')}</p>
        )}
      </div>

      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('access_list_heading')}
        </h2>

        {canEdit && (
          <form onSubmit={addEntry} className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="allowlist-email">{t('access_col_email')}</Label>
              <Input
                id="allowlist-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('access_add_placeholder')}
                required
                disabled={adding}
                className="w-64"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="allowlist-note">{t('access_col_note')}</Label>
              <Input
                id="allowlist-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('access_add_note_placeholder')}
                disabled={adding}
                className="w-56"
              />
            </div>
            <Button type="submit" disabled={adding || !email.trim()}>
              {adding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {t('access_add')}
            </Button>
          </form>
        )}

        {data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('access_empty')}</p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('access_col_email')}</th>
                <th className={TH_CLASS}>{t('access_col_note')}</th>
                <th className={TH_CLASS}>{t('access_col_added')}</th>
                {canEdit && <th className={TH_CLASS} aria-hidden />}
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-secondary/35">
                  <td className={TD_CLASS}>{entry.email}</td>
                  <td className={`${TD_CLASS} text-muted-foreground`}>
                    {entry.note || ''}
                  </td>
                  <td className={`${TD_CLASS} tabular-nums text-muted-foreground`}>
                    {formatDate(entry.created_at)}
                  </td>
                  {canEdit && (
                    <td className={`${TD_CLASS} text-right`}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('access_remove')}
                        disabled={removingId === entry.id}
                        onClick={() => void removeEntry(entry.id)}
                      >
                        {removingId === entry.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <X className="h-4 w-4" />
                        )}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
