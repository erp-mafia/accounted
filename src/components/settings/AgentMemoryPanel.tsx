'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BookmarkIcon, LightBulbIcon, PlusIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { SettingsSeg, SettingsSelect, SettingsTextarea } from '@/components/settings/SettingsRows'
import { memoryLineWordsFrom, memoryRowLine, memoryRowText } from '@/components/settings/agent-memory-row'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { Creator } from '@/lib/attribution/person-names'
import type { AnsweredQuestionOfFact } from '@/lib/questions/fact-questions'

import type { FactKind as Kind, FactSource as Source } from '@/lib/agent-context/agent-competence'

export interface AgentMemoryRow {
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
  /** Who saved it (GET and POST only): the name or that the account is deleted, never the e-mail. */
  created_by?: Creator | null
  /** The MCP client label that wrote it; null outside MCP. */
  client: string | null
  /** The question the row answered, with the answer as the person gave it (GET only). */
  answered_question?: AnsweredQuestionOfFact | null
}

/** The kinds a memory can have, in the order the add form offers them. */
const KINDS: readonly Kind[] = ['fact', 'preference', 'pattern', 'correction']

type KindFilter = 'all' | Kind

/**
 * What the assistant remembers about the company, to read, add to, edit, pin
 * and hide. `plain` is the same panel as one list, newest first, with no
 * kind filter, no help and no count line. Everything that changes a memory
 * stays: adding one, each row's pin, edit and hide, and showing the hidden
 * rows so one can be brought back.
 *
 * Every text is read from the message files (settings.memory_*, the kind
 * names from agentKnowledge), so the panel follows the reader's language.
 */
export function AgentMemoryPanel({ plain = false }: { plain?: boolean } = {}) {
  const memory = useAgentMemory()
  return <AgentMemoryView plain={plain} memory={memory} />
}

/**
 * The panel's state and its requests: the memory list as read, what the
 * person has open, and the calls that add, change, pin, hide and restore a
 * memory. AgentMemoryView draws it.
 */
function useAgentMemory() {
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const errorLocale = useLocale() as ErrorLocale
  const t = useTranslations('settings')

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
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
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
          title: t('memory_update_failed'),
          description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      const json = await res.json()
      // The PATCH answer has no created_by: keep the one the list read.
      setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, ...(json.data as Partial<AgentMemoryRow>) } : r)) ?? null)
    } catch (err) {
      // A rejected fetch (offline, DNS failure) or a 200 whose body will not
      // parse never reaches the !res.ok arm above: without this toast the
      // click looks like a dead control rather than a save that did not land.
      // One toast per failed click, never two: TOAST_LIMIT is 1
      // (components/ui/use-toast.tsx) and a second would evict the first.
      toast({
        title: t('memory_update_failed'),
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
          title: t('memory_save_failed'),
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
      toast({ title: t('memory_saved') })
    } catch (err) {
      // A rejected fetch or a 200 whose body will not parse never reaches the
      // !res.ok arm above: the draft stays in the form and one toast says the
      // save did not land. One toast per outcome, never two: TOAST_LIMIT is 1
      // (components/ui/use-toast.tsx) and a second would evict the first.
      toast({
        title: t('memory_save_failed'),
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

  return {
    canWrite,
    errorLocale,
    rows,
    loadError,
    retry: () => setReloadKey((k) => k + 1),
    includeDismissed,
    setIncludeDismissed,
    kindFilter,
    setKindFilter,
    busyId,
    editingId,
    setEditingId,
    editDraft,
    setEditDraft,
    showAdd,
    setShowAdd,
    newContent,
    setNewContent,
    newKind,
    setNewKind,
    adding,
    patch,
    addMemory,
    startEdit,
    saveEdit,
  }
}

/** What AgentMemoryView draws: the state useAgentMemory holds. */
export type AgentMemoryState = ReturnType<typeof useAgentMemory>

/** The panel drawn from its state, with no request of its own. Exported for its render test. */
export function AgentMemoryView({ plain = false, memory }: { plain?: boolean; memory: AgentMemoryState }) {
  const {
    canWrite,
    errorLocale,
    rows,
    loadError,
    retry,
    includeDismissed,
    setIncludeDismissed,
    kindFilter,
    setKindFilter,
    busyId,
    editingId,
    setEditingId,
    editDraft,
    setEditDraft,
    showAdd,
    setShowAdd,
    newContent,
    setNewContent,
    newKind,
    setNewKind,
    adding,
    patch,
    addMemory,
    startEdit,
    saveEdit,
  } = memory
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const tKnowledge = useTranslations('agentKnowledge')
  const tAttribution = useTranslations('attribution')
  // The words of the line under a row (who saved it and when): agent-memory-row.ts builds the line.
  const lineWords = useMemo(
    () =>
      memoryLineWordsFrom({
        settings: (key, values) => t(key, values),
        knowledge: (key, values) => tKnowledge(key, values),
        attribution: (key, values) => tAttribution(key, values),
      }),
    [t, tKnowledge, tAttribution],
  )
  const kindLabel = (kind: Kind): string =>
    kind === 'fact'
      ? tKnowledge('kind_fact')
      : kind === 'preference'
        ? tKnowledge('kind_preference')
        : kind === 'pattern'
          ? tKnowledge('kind_pattern')
          : tKnowledge('kind_correction')
  const kindFilters: Array<{ value: KindFilter; label: string }> = [
    { value: 'all', label: t('memory_filter_all') },
    { value: 'fact', label: t('memory_filter_fact') },
    { value: 'preference', label: t('memory_filter_preference') },
    { value: 'pattern', label: t('memory_filter_pattern') },
    { value: 'correction', label: t('memory_filter_correction') },
  ]

  const counts = useMemo(() => {
    const active = rows?.filter((r) => r.is_active).length ?? 0
    const pinned = rows?.filter((r) => r.is_active && r.is_pinned).length ?? 0
    const dismissed = rows?.filter((r) => !r.is_active).length ?? 0
    return { active, pinned, dismissed }
  }, [rows])

  // The plain list reads newest first, whatever order the read came in.
  const shownRows = plain && rows ? [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)) : rows

  // One clean list, the way every other v2 register reads: a toolbar (the
  // kind filter, the hidden toggle, the add button), a count line, then rows
  // of content with their meta beneath and quiet actions that show on hover.
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!plain && (
          // The segments scroll sideways on a phone instead of pushing the page wide.
          <div className="max-w-full overflow-x-auto rounded-lg">
            <SettingsSeg value={kindFilter} onChange={setKindFilter} options={kindFilters} aria-label={t('memory_filter_label')} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setIncludeDismissed((v) => !v)}
          aria-pressed={includeDismissed}
          className={cn(QUIET_LINK_CLASS, plain ? 'text-xs' : 'ml-1 text-xs')}
        >
          {includeDismissed ? t('memory_hide_hidden') : t('memory_show_hidden')}
        </button>
        {!plain && (
          <HelpPopover className="shrink-0">{t('memory_help')}</HelpPopover>
        )}
        {canWrite && (
          <Button className="ml-auto" onClick={() => setShowAdd((v) => !v)} disabled={adding}>
            <PlusIcon className="h-3.5 w-3.5" aria-hidden />
            {t('memory_add')}
          </Button>
        )}
      </div>

      {canWrite && showAdd && (
        <div className="space-y-3 border-b-hairline pb-4">
          <SettingsTextarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder={t('memory_new_placeholder')}
            rows={3}
            maxLength={2000}
            autoFocus
            aria-label={t('memory_new_label')}
            className="w-full border-border"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('memory_kind_label')}</span>
              <SettingsSelect value={newKind} onChange={(e) => setNewKind(e.target.value as Kind)} aria-label={t('memory_kind_label')}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{kindLabel(k)}</option>
                ))}
              </SettingsSelect>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => { setShowAdd(false); setNewContent('') }}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={addMemory} disabled={newContent.trim().length < 2} loading={adding}>
                {tCommon('save')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!plain && rows && rows.length > 0 && (
        <p className="text-xs tabular-nums text-muted-foreground">
          {includeDismissed && counts.dismissed > 0
            ? t('memory_counts_with_hidden', { active: counts.active, pinned: counts.pinned, hidden: counts.dismissed })
            : t('memory_counts', { active: counts.active, pinned: counts.pinned })}
        </p>
      )}

      {/* Live region always mounted so the failure is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite" className="min-w-0">
        {loadError && (
          <AttnLine
            action={loadError.detail ? undefined : { label: tCommon('retry'), onClick: retry }}
          >
            {loadError.detail ? `${t('memory_load_failed')} ${loadError.detail}` : t('memory_load_failed')}
          </AttnLine>
        )}
      </div>

      {rows === null && !loadError && (
        <div aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 border-b-hairline py-3.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      )}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={LightBulbIcon}
          title={t('memory_empty_title')}
          description={t('memory_empty_description')}
        />
      )}

      {shownRows && shownRows.length > 0 && (
        <ul>
          {shownRows.map((row) => {
            const isEditing = editingId === row.id
            const isBusy = busyId === row.id
            const dimmed = !row.is_active
            const text = memoryRowText(row)
            return (
              <li key={row.id} className={cn('group flex items-start gap-3 border-b-hairline py-3.5', dimmed && 'opacity-60')}>
                {canWrite && row.is_active ? (
                  <button
                    type="button"
                    onClick={() => patch(row.id, { is_pinned: !row.is_pinned })}
                    disabled={isBusy}
                    className={cn(
                      'mt-0.5 shrink-0 rounded-sm p-1 transition-colors duration-150',
                      row.is_pinned ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                    aria-label={row.is_pinned ? t('memory_unpin') : t('memory_pin')}
                    title={row.is_pinned ? t('memory_unpin') : t('memory_pin_title')}
                  >
                    <BookmarkIcon className={cn('h-3.5 w-3.5', row.is_pinned && 'fill-current')} />
                  </button>
                ) : (
                  <span className="mt-0.5 shrink-0 p-1">
                    {row.is_pinned && <BookmarkIcon className="h-3.5 w-3.5 fill-current text-foreground" />}
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
                        aria-label={t('memory_edit_label')}
                        className="w-full border-border"
                      />
                      <div className="flex items-center gap-2">
                        <Button onClick={() => saveEdit(row)} disabled={editDraft.trim().length < 2} loading={isBusy}>
                          {tCommon('save')}
                        </Button>
                        <Button variant="outline" onClick={() => setEditingId(null)} disabled={isBusy}>
                          {tCommon('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {text.quiet && <p className="break-words text-[13px] leading-6 text-muted-foreground">{text.quiet}</p>}
                      <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">{text.main}</p>
                    </>
                  )}
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">{memoryRowLine(row, lineWords, errorLocale)}</p>
                </div>
                {canWrite && !isEditing && (
                  <div className={cn('flex shrink-0 items-center gap-3 pt-0.5', HOVER_REVEAL_CLASS)}>
                    {row.is_active ? (
                      <>
                        <button type="button" onClick={() => startEdit(row)} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-xs')}>
                          {tCommon('edit')}
                        </button>
                        <button type="button" onClick={() => patch(row.id, { is_active: false })} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-xs')}>
                          {t('memory_hide')}
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => patch(row.id, { is_active: true })} disabled={isBusy} className={cn(QUIET_LINK_CLASS, 'text-xs')}>
                        {t('memory_restore')}
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
