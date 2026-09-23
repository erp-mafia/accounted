'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import { Brain, Loader2, Pin, Plus } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { SettingsSeg, SettingsSelect, SettingsTextarea } from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatDateLong } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

import type { FactKind as Kind, FactSource as Source } from '@/lib/agent-context/agent-competence'

interface AgentMemoryRow {
  id: string
  kind: Kind
  content: string
  source: Source
  source_ref: string | null
  relevance_score: number
  is_pinned: boolean
  is_active: boolean
  last_accessed_at: string | null
  created_at: string
  updated_at: string
}

const KIND_LABEL: Record<Kind, string> = {
  fact: 'Fakta',
  preference: 'Preferens',
  pattern: 'Mönster',
  correction: 'Korrigering',
}

const SOURCE_LABEL: Record<Source, string> = {
  composer: 'Inläst vid uppstart',
  user_taught: 'Du lärde mig',
  agent_learned: 'Jag noterade',
  derived: 'Härlett',
}

const KIND_FILTER: { value: 'all' | Kind; label: string }[] = [
  { value: 'all', label: 'Alla' },
  { value: 'fact', label: 'Fakta' },
  { value: 'preference', label: 'Preferenser' },
  { value: 'pattern', label: 'Mönster' },
  { value: 'correction', label: 'Korrigeringar' },
]

export function AgentMemoryPanel() {
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const errorLocale = useLocale() as ErrorLocale

  // null = the memory list is not known: still loading, or the read failed
  // (loadError). A failed read must never render the "Inga minnen ännu"
  // EmptyState: that is a claim about the assistant's memory, and it is only
  // true after a confirmed empty read.
  const [rows, setRows] = useState<AgentMemoryRow[] | null>(null)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [includeDismissed, setIncludeDismissed] = useState(false)
  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newKind, setNewKind] = useState<Kind>('fact')
  const [adding, setAdding] = useState(false)

  // The cancelled closure is the same idiom every sibling panel uses
  // (TeamPanel, AccountDangerZone): a response that lands after unmount, or
  // after a filter change superseded this load, must not setState. Without it
  // a slow "Alla" response could overwrite a newer filtered list.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadError(null)
      const params = new URLSearchParams()
      if (includeDismissed) params.set('include_dismissed', 'true')
      if (kindFilter !== 'all') params.set('kind', kindFilter)
      try {
        const res = await fetch(`/api/agent/memory?${params.toString()}`)
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const json = await res.json().catch(() => null)
          if (cancelled) return
          const sessionGone = res.status === 401 || res.status === 403
          setRows(null)
          setLoadError({
            detail: sessionGone
              ? getErrorMessage(json, { statusCode: res.status, locale: errorLocale })
              : null,
          })
          return
        }
        // A 200 whose body will not parse throws into the catch below; a 200
        // without the list is a failed read too. Neither may become a
        // fabricated "Inga minnen ännu".
        const json = await res.json()
        if (cancelled) return
        if (!Array.isArray(json?.data)) {
          setRows(null)
          setLoadError({ detail: null })
          return
        }
        setRows(json.data as AgentMemoryRow[])
      } catch {
        if (!cancelled) {
          setRows(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [includeDismissed, kindFilter, errorLocale, reloadKey])

  const counts = useMemo(() => {
    const active = rows?.filter((r) => r.is_active).length ?? 0
    const pinned = rows?.filter((r) => r.is_active && r.is_pinned).length ?? 0
    const dismissed = rows?.filter((r) => !r.is_active).length ?? 0
    return { active, pinned, dismissed }
  }, [rows])

  async function patch(id: string, body: Partial<Pick<AgentMemoryRow, 'content' | 'is_pinned' | 'is_active'>>) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/agent/memory/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
        // getErrorMessage falls back to the status map.
        const json = await res.json().catch(() => null)
        toast({
          title: 'Kunde inte uppdatera',
          description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const json = await res.json()
      setRows((prev) => prev?.map((r) => (r.id === id ? (json.data as AgentMemoryRow) : r)) ?? null)
    } catch (err) {
      // A rejected fetch (offline, DNS failure) or a 200 whose body will not
      // parse never reaches the !res.ok arm above: without this toast the
      // click looks like a dead control rather than a save that did not land.
      // One toast per failed click, never two: TOAST_LIMIT is 1
      // (components/ui/use-toast.tsx) and a second would evict the first.
      toast({
        title: 'Kunde inte uppdatera',
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function addMemory() {
    if (newContent.trim().length < 2) return
    setAdding(true)
    try {
      const res = await fetch('/api/agent/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent.trim(), kind: newKind }),
      })
      if (!res.ok) {
        // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
        // getErrorMessage falls back to the status map.
        const json = await res.json().catch(() => null)
        toast({
          title: 'Kunde inte spara minne',
          description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const json = await res.json()
      setRows((prev) => [json.data as AgentMemoryRow, ...(prev ?? [])])
      setNewContent('')
      setNewKind('fact')
      setShowAdd(false)
      toast({ title: 'Minne sparat' })
    } catch (err) {
      // A rejected fetch or a 200 whose body will not parse never reaches the
      // !res.ok arm above: the draft stays in the form and one toast says the
      // save did not land. One toast per outcome, never two: TOAST_LIMIT is 1
      // (components/ui/use-toast.tsx) and a second would evict the first.
      toast({
        title: 'Kunde inte spara minne',
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setAdding(false)
    }
  }

  function startEdit(row: AgentMemoryRow) {
    setEditingId(row.id)
    setEditDraft(row.content)
  }

  async function saveEdit(row: AgentMemoryRow) {
    const next = editDraft.trim()
    if (next.length < 2 || next === row.content) {
      setEditingId(null)
      return
    }
    await patch(row.id, { content: next })
    setEditingId(null)
  }

  // One clean list, the way every other v2 register reads: a toolbar (the
  // kind filter, the hidden toggle, the add button), a count line, then rows
  // of content with their meta beneath and quiet actions that show on hover.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsSeg value={kindFilter} onChange={setKindFilter} options={KIND_FILTER} aria-label="Filtrera minnen" />
        <button
          type="button"
          onClick={() => setIncludeDismissed((v) => !v)}
          aria-pressed={includeDismissed}
          className={cn(QUIET_LINK_CLASS, 'ml-1 text-[12.5px]')}
        >
          {includeDismissed ? 'Dölj dolda' : 'Visa dolda'}
        </button>
        <HelpPopover className="shrink-0">
          Bokföringsassistenten använder dessa anteckningar för att ge dig rätt råd. Fäst det som alltid
          ska vara med, redigera fel, eller dölj det som inte längre stämmer. Upp till 30 minnen ingår i
          samtal per tur.
        </HelpPopover>
        {canWrite && (
          <Button size="sm" className="ml-auto" onClick={() => setShowAdd((v) => !v)} disabled={adding}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Lägg till minne
          </Button>
        )}
      </div>

      {canWrite && showAdd && (
        <div className="space-y-3 border-b border-border pb-4">
          <SettingsTextarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="T.ex. Vi använder Stripe för B2C-betalningar; utbetalningar landar på 1930 var måndag."
            rows={3}
            maxLength={2000}
            autoFocus
            aria-label="Nytt minne"
            className="w-full border-border"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Typ</span>
              <SettingsSelect value={newKind} onChange={(e) => setNewKind(e.target.value as Kind)} aria-label="Typ">
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </SettingsSelect>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); setNewContent('') }}>
                Avbryt
              </Button>
              <Button size="sm" onClick={addMemory} disabled={adding || newContent.trim().length < 2}>
                {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Spara
              </Button>
            </div>
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <p className="text-[12px] tabular-nums text-muted-foreground">
          {counts.active} aktiva · {counts.pinned} fästa
          {includeDismissed && counts.dismissed > 0 ? ` · ${counts.dismissed} dolda` : ''}
        </p>
      )}

      {/* Live region always mounted so the failure is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite" className="min-w-0">
        {loadError && (
          <AttnLine
            action={loadError.detail ? undefined : { label: 'Försök igen', onClick: () => setReloadKey((k) => k + 1) }}
          >
            {loadError.detail ? `Minnena kunde inte läsas in just nu. ${loadError.detail}` : 'Minnena kunde inte läsas in just nu.'}
          </AttnLine>
        )}
      </div>

      {rows === null && !loadError && (
        <div aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 border-b border-border/60 py-3.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      )}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Brain}
          title="Inga minnen ännu"
          description="När du lär assistenten saker (eller när den noterar saker själv med ditt godkännande) dyker de upp här."
        />
      )}

      {rows && rows.length > 0 && (
        <ul>
          {rows.map((row) => {
            const isEditing = editingId === row.id
            const isBusy = busyId === row.id
            const dimmed = !row.is_active
            return (
              <li key={row.id} className={cn('group flex items-start gap-3 border-b border-border/60 py-3.5', dimmed && 'opacity-60')}>
                {canWrite && row.is_active ? (
                  <button
                    type="button"
                    onClick={() => patch(row.id, { is_pinned: !row.is_pinned })}
                    disabled={isBusy}
                    className={cn(
                      'mt-0.5 shrink-0 rounded-sm p-1 transition-colors duration-150',
                      row.is_pinned ? 'text-foreground' : 'text-muted-foreground/50 hover:text-foreground',
                    )}
                    aria-label={row.is_pinned ? 'Lossa' : 'Fäst'}
                    title={row.is_pinned ? 'Lossa' : 'Fäst: minnet skickas alltid med'}
                  >
                    <Pin className={cn('h-3.5 w-3.5', row.is_pinned && 'fill-current')} />
                  </button>
                ) : (
                  <span className="mt-0.5 shrink-0 p-1">
                    {row.is_pinned && <Pin className="h-3.5 w-3.5 fill-current text-foreground" />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <div className="space-y-2">
                      <SettingsTextarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={3}
                        maxLength={2000}
                        autoFocus
                        aria-label="Redigera minne"
                        className="w-full border-border"
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={() => saveEdit(row)} disabled={isBusy || editDraft.trim().length < 2}>
                          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Spara'}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditingId(null)} disabled={isBusy}>
                          Avbryt
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[13.5px] leading-6 text-foreground">{row.content}</p>
                  )}
                  <p className="mt-1 text-[11.5px] tabular-nums text-muted-foreground">
                    {KIND_LABEL[row.kind]} · {SOURCE_LABEL[row.source]} · {formatDateLong(row.created_at)}
                    {row.updated_at !== row.created_at && ` · uppdaterad ${formatDateLong(row.updated_at)}`}
                    {dimmed && ' · dold'}
                  </p>
                </div>
                {canWrite && !isEditing && (
                  <div className={cn('flex shrink-0 items-center gap-3 pt-0.5', HOVER_REVEAL_CLASS)}>
                    {row.is_active ? (
                      <>
                        <button type="button" onClick={() => startEdit(row)} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-[12px]')}>
                          Redigera
                        </button>
                        <button type="button" onClick={() => patch(row.id, { is_active: false })} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-[12px]')}>
                          Dölj
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => patch(row.id, { is_active: true })} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-[12px]')}>
                        Återställ
                      </button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
