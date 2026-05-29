'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

interface CostCenter {
  id: string
  code: string
  name: string
  is_active: boolean
}

export function CostCenterManager() {
  const t = useTranslations('settings_cost_centers')
  const [centers, setCenters] = useState<CostCenter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // Per-row busy + inline rename state.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/cost-centers?include_inactive=true')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || t('load_error'))
      setCenters(json.data ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : t('load_error'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    const code = newCode.trim()
    const name = newName.trim()
    if (!code || !name) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/cost-centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || t('save_error'))
      setNewCode('')
      setNewName('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('save_error'))
    } finally {
      setCreating(false)
    }
  }

  const patch = async (id: string, body: Record<string, unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/cost-centers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || t('save_error'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('save_error'))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (c: CostCenter) => {
    if (!confirm(t('delete_confirm', { code: c.code, name: c.name }))) return
    setBusyId(c.id)
    setError(null)
    try {
      const res = await fetch(`/api/cost-centers/${c.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || t('save_error'))
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('save_error'))
    } finally {
      setBusyId(null)
    }
  }

  const startEdit = (c: CostCenter) => {
    setEditingId(c.id)
    setEditName(c.name)
  }

  const saveEdit = async (id: string) => {
    const name = editName.trim()
    if (!name) return
    await patch(id, { name })
    setEditingId(null)
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('heading')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
      </div>

      {/* Create row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="space-y-1.5 sm:w-32">
          <label className="text-xs font-medium" htmlFor="cc-code">{t('code_label')}</label>
          <Input
            id="cc-code"
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            maxLength={20}
            placeholder={t('code_placeholder')}
            className="font-mono"
          />
        </div>
        <div className="space-y-1.5 sm:flex-1">
          <label className="text-xs font-medium" htmlFor="cc-name">{t('name_label')}</label>
          <Input
            id="cc-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={100}
            placeholder={t('name_placeholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
          />
        </div>
        <Button onClick={handleCreate} disabled={creating || !newCode.trim() || !newName.trim()}>
          {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
          {t('add')}
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : centers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty_state')}</p>
      ) : (
        <div className="divide-y divide-border/8 rounded-lg border border-border">
          {centers.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-20 shrink-0 font-mono text-sm tabular-nums">{c.code}</span>
              {editingId === c.id ? (
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={100}
                  autoFocus
                  className="h-8 flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit(c.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <span className={`flex-1 text-sm ${c.is_active ? '' : 'text-muted-foreground line-through'}`}>
                  {c.name}
                </span>
              )}

              {!c.is_active && editingId !== c.id && (
                <Badge variant="outline" className="text-[10px]">{t('inactive_badge')}</Badge>
              )}

              <div className="flex items-center gap-1">
                {editingId === c.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => saveEdit(c.id)}
                      disabled={busyId === c.id || !editName.trim()}
                      aria-label={t('save')}
                    >
                      {busyId === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setEditingId(null)}
                      disabled={busyId === c.id}
                      aria-label={t('cancel')}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => startEdit(c)}
                      disabled={busyId === c.id}
                      aria-label={t('rename')}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => patch(c.id, { is_active: !c.is_active })}
                      disabled={busyId === c.id}
                    >
                      {busyId === c.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : c.is_active ? (
                        t('deactivate')
                      ) : (
                        t('activate')
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDelete(c)}
                      disabled={busyId === c.id}
                      aria-label={t('delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
