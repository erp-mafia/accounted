'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Brain, Loader2, Pin, PinOff, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDateLong } from '@/lib/utils'

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

  const [rows, setRows] = useState<AgentMemoryRow[] | null>(null)
  const [includeDismissed, setIncludeDismissed] = useState(false)
  const [kindFilter, setKindFilter] = useState<'all' | Kind>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [newKind, setNewKind] = useState<Kind>('fact')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (includeDismissed) params.set('include_dismissed', 'true')
    if (kindFilter !== 'all') params.set('kind', kindFilter)
    const res = await fetch(`/api/agent/memory?${params.toString()}`)
    const json = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte hämta minne', description: json.error, variant: 'destructive' })
      setRows([])
      return
    }
    setRows(json.data as AgentMemoryRow[])
  }, [includeDismissed, kindFilter, toast])

  useEffect(() => { void load() }, [load])

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
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte uppdatera', description: json.error, variant: 'destructive' })
        return
      }
      setRows((prev) => prev?.map((r) => (r.id === id ? (json.data as AgentMemoryRow) : r)) ?? null)
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
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte spara minne', description: json.error, variant: 'destructive' })
        return
      }
      setRows((prev) => [json.data as AgentMemoryRow, ...(prev ?? [])])
      setNewContent('')
      setNewKind('fact')
      setShowAdd(false)
      toast({ title: 'Minne sparat' })
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

  return (
    <Card>
      <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base">Vad min assistent kommer ihåg</CardTitle>
          <CardDescription>
            Bokföringsassistenten använder dessa anteckningar för att ge dig rätt råd. Fäst det som
            alltid ska vara med, redigera fel, eller dölj det som inte längre stämmer.
          </CardDescription>
        </div>
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
      </CardHeader>

      <CardContent className="space-y-6">
        {showAdd && canWrite && (
          <div className="rounded-lg border border-border p-4 space-y-3">
            <Textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="T.ex. Vi använder Stripe för B2C-betalningar; utbetalningar landar på 1930 var måndag."
              rows={3}
              maxLength={2000}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Typ</span>
                <Select value={newKind} onValueChange={(v) => setNewKind(v as Kind)}>
                  <SelectTrigger className="h-8 w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                      <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setNewContent('') }}>
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

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1">
            {KIND_FILTER.map((f) => {
              const active = kindFilter === f.value
              return (
                <button
                  key={f.value}
                  onClick={() => setKindFilter(f.value)}
                  className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                    active
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                  }`}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeDismissed}
              onChange={(e) => setIncludeDismissed(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Visa dolda
          </label>
        </div>

        {rows && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {counts.active} aktiva · {counts.pinned} fästa
            {includeDismissed && counts.dismissed > 0 ? ` · ${counts.dismissed} dolda` : ''}
            <span className="ml-1">(upp till 30 ingår i samtal per tur)</span>
          </div>
        )}

        {rows === null && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
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
          <ul className="space-y-3">
            {rows.map((row) => {
              const isEditing = editingId === row.id
              const isBusy = busyId === row.id
              const dimmed = !row.is_active
              return (
                <li
                  key={row.id}
                  className={`rounded-lg border border-border p-4 transition-colors ${
                    dimmed ? 'bg-muted/30 opacity-70' : 'bg-card'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {canWrite && row.is_active ? (
                      <button
                        onClick={() => patch(row.id, { is_pinned: !row.is_pinned })}
                        disabled={isBusy}
                        className={`mt-0.5 shrink-0 rounded-md p-1.5 transition-colors ${
                          row.is_pinned
                            ? 'text-foreground bg-secondary'
                            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                        }`}
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

                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">
                          {KIND_LABEL[row.kind]} · {SOURCE_LABEL[row.source]}
                        </span>
                        {dimmed && <Badge variant="secondary">Dold</Badge>}
                      </div>

                      {isEditing ? (
                        <Textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={3}
                          maxLength={2000}
                          autoFocus
                        />
                      ) : (
                        <p className="text-sm text-foreground whitespace-pre-wrap break-words">{row.content}</p>
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
                                  variant="ghost"
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
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => startEdit(row)}
                                  disabled={isBusy}
                                >
                                  <Pencil className="mr-1 h-3.5 w-3.5" />
                                  Redigera
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => patch(row.id, { is_active: false })}
                                  disabled={isBusy}
                                >
                                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                                  Dölj
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => patch(row.id, { is_active: true })}
                                disabled={isBusy}
                              >
                                <RotateCcw className="mr-1 h-3.5 w-3.5" />
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
      </CardContent>
    </Card>
  )
}
