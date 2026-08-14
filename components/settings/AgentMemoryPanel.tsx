'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import { Brain, Loader2, Pin, PinOff, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSeg,
  SettingsSelect,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn, formatDateLong } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

type Kind = 'fact' | 'preference' | 'pattern' | 'correction'
type Source = 'composer' | 'user_taught' | 'agent_learned' | 'derived'

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

  // The view wrapper in AssistantSettingsContent already provides the gap
  // under the segmented control, so the group starts flush (pt-0).
  return (
    <SettingsGroup
      label="Vad min assistent kommer ihåg"
      help={
        <>
          Bokföringsassistenten använder dessa anteckningar för att ge dig rätt råd. Fäst det som
          alltid ska vara med, redigera fel, eller dölj det som inte längre stämmer. Upp till 30
          minnen ingår i samtal per tur.
        </>
      }
      className="pt-0 first:pt-0"
    >
      {/* Toolbar row: kind filter + the add-memory entry point. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-1 py-3">
        <SettingsSeg
          value={kindFilter}
          onChange={setKindFilter}
          options={KIND_FILTER}
          aria-label="Filtrera minnen"
        />
        {canWrite && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAdd((v) => !v)}
            disabled={adding}
          >
            <Plus className="mr-2 h-4 w-4" />
            Lägg till minne
          </Button>
        )}
      </div>

      {canWrite && (
        <SettingsReveal open={showAdd}>
          <div className="space-y-3 py-3">
            <SettingsTextarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="T.ex. Vi använder Stripe för B2C-betalningar; utbetalningar landar på 1930 var måndag."
              rows={3}
              maxLength={2000}
              aria-label="Nytt minne"
              className="w-full border-border"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Typ</span>
                <SettingsSelect
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value as Kind)}
                  aria-label="Typ"
                >
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
        </SettingsReveal>
      )}

      <SettingsRow label="Visa dolda">
        <SettingsRowEnd>
          <Switch
            checked={includeDismissed}
            onCheckedChange={setIncludeDismissed}
            aria-label="Visa dolda"
          />
        </SettingsRowEnd>
      </SettingsRow>

      {/* Dynamic status stays visible; the static "how it's used" copy lives
          in the group help above. */}
      {rows && (
        <p className="px-1 pt-3">
          <SettingsRowNote className="tabular-nums">
            {counts.active} aktiva · {counts.pinned} fästa
            {includeDismissed && counts.dismissed > 0 ? ` · ${counts.dismissed} dolda` : ''}
          </SettingsRowNote>
        </p>
      )}

      {/* Live region always mounted so the failure is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite" className="min-w-0 px-1 pt-3">
        {loadError && (
          <AttnLine
            action={
              loadError.detail
                ? undefined
                : { label: 'Försök igen', onClick: () => setReloadKey((k) => k + 1) }
            }
          >
            {loadError.detail
              ? `Minnena kunde inte läsas in just nu. ${loadError.detail}`
              : 'Minnena kunde inte läsas in just nu.'}
          </AttnLine>
        )}
      </div>

      {rows === null && !loadError && (
        <div className="space-y-3 pt-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
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
              <li
                key={row.id}
                className={cn(
                  'border-b border-border px-1 py-3 transition-colors',
                  dimmed && 'opacity-70',
                )}
              >
                <div className="flex items-start gap-3">
                  {canWrite && row.is_active ? (
                    <button
                      onClick={() => patch(row.id, { is_pinned: !row.is_pinned })}
                      disabled={isBusy}
                      className={cn(
                        'mt-0.5 shrink-0 rounded-sm p-1.5 transition-colors duration-150',
                        row.is_pinned
                          ? 'bg-secondary text-foreground'
                          : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                      aria-label={row.is_pinned ? 'Lossa' : 'Fäst'}
                      title={row.is_pinned ? 'Lossa' : 'Fäst: säkerställer att minnet alltid skickas med'}
                    >
                      {row.is_pinned ? <Pin className="h-4 w-4 fill-current" /> : <PinOff className="h-4 w-4" />}
                    </button>
                  ) : (
                    <div className="mt-0.5 shrink-0 p-1.5">
                      {row.is_pinned && <Pin className="h-4 w-4 fill-current text-foreground" />}
                    </div>
                  )}

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        {KIND_LABEL[row.kind]} · {SOURCE_LABEL[row.source]}
                      </span>
                      {dimmed && <Badge variant="secondary">Dold</Badge>}
                    </div>

                    {isEditing ? (
                      <SettingsTextarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={3}
                        maxLength={2000}
                        autoFocus
                        aria-label="Redigera minne"
                        className="w-full border-border"
                      />
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{row.content}</p>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <p className="text-[11px] text-muted-foreground tabular-nums">
                        Skapad {formatDateLong(row.created_at)}
                        {row.updated_at !== row.created_at && ` · uppdaterad ${formatDateLong(row.updated_at)}`}
                      </p>

                      {canWrite && (
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditingId(null)}
                                disabled={isBusy}
                              >
                                <X className="h-4 w-4" />
                                <span className="sr-only">Avbryt</span>
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => saveEdit(row)}
                                disabled={isBusy || editDraft.trim().length < 2}
                              >
                                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Spara'}
                              </Button>
                            </>
                          ) : row.is_active ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => startEdit(row)}
                                disabled={isBusy}
                              >
                                <Pencil className="mr-1 h-3.5 w-3.5" />
                                Redigera
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => patch(row.id, { is_active: false })}
                                disabled={isBusy}
                              >
                                {isBusy ? (
                                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                                )}
                                Dölj
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => patch(row.id, { is_active: true })}
                              disabled={isBusy}
                            >
                              {isBusy ? (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                              )}
                              Återställ
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </SettingsGroup>
  )
}
