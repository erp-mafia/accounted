'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Brain, Pin, Plus } from 'lucide-react'
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

const KINDS: Kind[] = ['fact', 'preference', 'pattern', 'correction']

export function AgentMemoryPanel() {
  const t = useTranslations('agent_memory_panel')
  const { toast } = useToast()

  function kindLabel(kind: Kind): string {
    switch (kind) {
      case 'fact':
        return t('kind_fact')
      case 'preference':
        return t('kind_preference')
      case 'pattern':
        return t('kind_pattern')
      case 'correction':
        return t('kind_correction')
    }
  }

  function sourceLabel(source: Source): string {
    switch (source) {
      case 'composer':
        return t('source_composer')
      case 'user_taught':
        return t('source_user_taught')
      case 'agent_learned':
        return t('source_agent_learned')
      case 'derived':
        return t('source_derived')
    }
  }

  const kindFilterOptions: { value: 'all' | Kind; label: string }[] = [
    { value: 'all', label: t('filter_all') },
    { value: 'fact', label: t('kind_fact') },
    { value: 'preference', label: t('filter_preference') },
    { value: 'pattern', label: t('kind_pattern') },
    { value: 'correction', label: t('filter_correction') },
  ]
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
          title: t('update_failed'),
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
        title: t('update_failed'),
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
          title: t('save_failed'),
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
      toast({ title: t('saved') })
    } catch (err) {
      // A rejected fetch or a 200 whose body will not parse never reaches the
      // !res.ok arm above: the draft stays in the form and one toast says the
      // save did not land. One toast per outcome, never two: TOAST_LIMIT is 1
      // (components/ui/use-toast.tsx) and a second would evict the first.
      toast({
        title: t('save_failed'),
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
        <SettingsSeg value={kindFilter} onChange={setKindFilter} options={kindFilterOptions} aria-label={t('filter_aria')} />
        <button
          type="button"
          onClick={() => setIncludeDismissed((v) => !v)}
          aria-pressed={includeDismissed}
          className={cn(QUIET_LINK_CLASS, 'ml-1 text-[12.5px]')}
        >
          {includeDismissed ? t('hide_hidden') : t('show_hidden')}
        </button>
        <HelpPopover className="shrink-0">
          {t('help')}
        </HelpPopover>
        {canWrite && (
          <Button size="sm" className="ml-auto" onClick={() => setShowAdd((v) => !v)} disabled={adding}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('add')}
          </Button>
        )}
      </div>

      {canWrite && showAdd && (
        <div className="space-y-3 border-b border-border pb-4">
          <SettingsTextarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder={t('new_placeholder')}
            rows={3}
            maxLength={2000}
            autoFocus
            aria-label={t('new_aria')}
            className="w-full border-border"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('type')}</span>
              <SettingsSelect value={newKind} onChange={(e) => setNewKind(e.target.value as Kind)} aria-label={t('type')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{kindLabel(k)}</option>
                ))}
              </SettingsSelect>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowAdd(false); setNewContent('') }}>
                {t('cancel')}
              </Button>
              <Button size="sm" onClick={addMemory} disabled={newContent.trim().length < 2} loading={adding}>
                {t('save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <p className="text-[12.5px] tabular-nums text-muted-foreground">
          {t('counts', { active: counts.active, pinned: counts.pinned })}
          {includeDismissed && counts.dismissed > 0 ? ` · ${t('counts_hidden', { count: counts.dismissed })}` : ''}
        </p>
      )}

      {/* Live region always mounted so the failure is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite" className="min-w-0">
        {loadError && (
          <AttnLine
            action={loadError.detail ? undefined : { label: t('retry'), onClick: () => setReloadKey((k) => k + 1) }}
          >
            {loadError.detail ? t('load_failed_detail', { detail: loadError.detail }) : t('load_failed')}
          </AttnLine>
        )}
      </div>

      {rows === null && !loadError && (
        <div aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 border-b border-border py-3.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      )}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Brain}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      )}

      {rows && rows.length > 0 && (
        <ul>
          {rows.map((row) => {
            const isEditing = editingId === row.id
            const isBusy = busyId === row.id
            const dimmed = !row.is_active
            return (
              <li key={row.id} className={cn('group flex items-start gap-3 border-b border-border py-3.5', dimmed && 'opacity-60')}>
                {canWrite && row.is_active ? (
                  <button
                    type="button"
                    onClick={() => patch(row.id, { is_pinned: !row.is_pinned })}
                    disabled={isBusy}
                    className={cn(
                      'mt-0.5 shrink-0 rounded-sm p-1 transition-colors duration-150',
                      row.is_pinned ? 'text-foreground' : 'text-muted-foreground/50 hover:text-foreground',
                    )}
                    aria-label={row.is_pinned ? t('unpin') : t('pin')}
                    title={row.is_pinned ? t('unpin') : t('pin_title')}
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
                        aria-label={t('edit_aria')}
                        className="w-full border-border"
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" onClick={() => saveEdit(row)} disabled={editDraft.trim().length < 2} loading={isBusy}>
                          {t('save')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setEditingId(null)} disabled={isBusy}>
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">{row.content}</p>
                  )}
                  <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                    {kindLabel(row.kind)} · {sourceLabel(row.source)} · {formatDateLong(row.created_at)}
                    {row.updated_at !== row.created_at && ` · ${t('updated_at', { date: formatDateLong(row.updated_at) })}`}
                    {dimmed && ` · ${t('hidden')}`}
                  </p>
                </div>
                {canWrite && !isEditing && (
                  <div className={cn('flex shrink-0 items-center gap-3 pt-0.5', HOVER_REVEAL_CLASS)}>
                    {row.is_active ? (
                      <>
                        <button type="button" onClick={() => startEdit(row)} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}>
                          {t('edit')}
                        </button>
                        <button type="button" onClick={() => patch(row.id, { is_active: false })} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}>
                          {t('hide')}
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => patch(row.id, { is_active: true })} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-[12.5px]')}>
                        {t('restore')}
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
