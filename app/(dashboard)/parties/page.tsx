'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Lock } from 'lucide-react'
import { ContextPicker, type ContextPickerItem } from '@/components/common/ContextPicker'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { PageHeader } from '@/components/ui/page-header'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Skeleton } from '@/components/ui/skeleton'
import { ToastAction } from '@/components/ui/toast'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { useToast } from '@/components/ui/use-toast'
import { MergeDialog, type MergeCandidate } from '@/components/parties/MergeDialog'
import { ObservedTable } from '@/components/parties/ObservedTable'
import { PartyDossier } from '@/components/parties/PartyDossier'
import { RegisterTable } from '@/components/parties/RegisterTable'
import { SuggestionQueue } from '@/components/parties/SuggestionQueue'
import { hasHardKey } from '@/components/parties/format'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Register, RegisterPeriod, RegisterRow, RegisterView } from '@/lib/parties/register'

const VIEWS: RegisterView[] = ['all', 'customers', 'suppliers', 'suggested', 'observed']

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(String(res.status))
  const json = (await res.json()) as { data: T }
  return json.data
}

export default function PartiesPage() {
  const t = useTranslations('parties')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [view, setView] = useState<RegisterView>('all')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [period, setPeriod] = useState<RegisterPeriod>('12m')
  const [register, setRegister] = useState<Register | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dossierId, setDossierId] = useState<string | null>(null)
  const [dossierReload, setDossierReload] = useState(0)
  const [merge, setMerge] = useState<{ subject: MergeCandidate; suggested: MergeCandidate[] } | null>(null)
  const preselected = useRef<string | null>(null)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(id)
  }, [query])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ view, period })
    if (debounced) params.set('q', debounced)
    fetch(`/api/parties?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data: Register }
        if (cancelled) return
        setRegister(json.data)
        setFailed(false)
        // Only rows with a hard key arrive pre-ticked, once per queue load.
        if (view === 'suggested' && preselected.current !== `${reloadKey}:${debounced}`) {
          preselected.current = `${reloadKey}:${debounced}`
          setSelected(new Set(json.data.rows.filter(hasHardKey).map((r) => r.id)))
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view, debounced, period, reloadKey])

  const reload = useCallback(() => {
    setReloadKey((k) => k + 1)
    setDossierReload((k) => k + 1)
  }, [])

  const counts = register?.counts
  const viewOptions = useMemo(
    () =>
      VIEWS.map((v) => ({
        value: v,
        label: t(`view_${v}`),
        count: counts ? counts[v] : undefined,
      })),
    [counts, t],
  )
  const periodItems: ContextPickerItem[] = useMemo(
    () => [
      { id: '12m', label: t('period_12m') },
      { id: 'all', label: t('period_all') },
    ],
    [t],
  )

  const fail = useCallback(() => toast({ title: t('action_failed'), variant: 'destructive' }), [toast, t])

  async function refreshSuggestions() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const summary = await post<{ created: number; attached: number }>('/api/parties/suggest')
      toast({ title: t('refreshed_title'), description: t('refreshed_description', { created: summary.created, attached: summary.attached }) })
      reload()
    } catch {
      fail()
    } finally {
      setRefreshing(false)
    }
  }

  async function decide(ids: string[], kind: 'confirm' | 'dismiss') {
    if (ids.length === 0) return
    setBusy(true)
    try {
      const { count } = await post<{ count: number }>('/api/parties/decide', { partyIds: ids, kind })
      toast({
        title: kind === 'confirm' ? t('confirmed_title', { count }) : t('dismissed_title', { count }),
        action: (
          <ToastAction
            altText={t('undo')}
            onClick={() => {
              post('/api/parties/decide/undo', { partyIds: ids })
                .then(() => {
                  toast({ title: t('undone_title') })
                  reload()
                })
                .catch(fail)
            }}
          >
            {t('undo')}
          </ToastAction>
        ),
      })
      setSelected((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  async function runMerge(survivorId: string, mergedIds: string[]) {
    setBusy(true)
    try {
      const { decisionId } = await post<{ decisionId: string }>('/api/parties/merge', { survivorId, mergedIds })
      toast({
        title: t('merged_title'),
        action: (
          <ToastAction
            altText={t('undo')}
            onClick={() => {
              post('/api/parties/merge/undo', { decisionId })
                .then(() => {
                  toast({ title: t('merge_undone_title') })
                  reload()
                })
                .catch(fail)
            }}
          >
            {t('undo')}
          </ToastAction>
        ),
      })
      setMerge(null)
      if (dossierId && mergedIds.includes(dossierId)) setDossierId(survivorId)
      reload()
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  const rows = register?.rows ?? []
  const suggestedRows: RegisterRow[] = view === 'suggested' ? rows : []
  const searching = debounced.length > 0

  let attn: React.ReactNode = null
  if (counts && counts.suggested > 0 && view !== 'suggested') {
    attn = (
      <AttnLine action={{ label: t('attn_review'), onClick: () => setView('suggested') }}>
        {t('attn_suggestions', { count: counts.suggested })}
      </AttnLine>
    )
  } else if (counts && counts.all + counts.suggested === 0 && counts.observed > 0 && canWrite) {
    attn = <AttnLine action={{ label: t('refresh'), onClick: () => void refreshSuggestions() }}>{t('attn_observed', { count: counts.observed })}</AttnLine>
  }

  function empty() {
    if (searching) return <EmptyState title={t('empty_search_title')} description={t('empty_search_description')} />
    if (view === 'suggested')
      return (
        <EmptyState
          title={t('empty_suggested_title')}
          description={t('empty_suggested_description')}
          actionLabel={canWrite ? t('refresh') : undefined}
          onAction={canWrite ? () => void refreshSuggestions() : undefined}
        />
      )
    if (view === 'observed') return <EmptyState title={t('empty_observed_title')} description={t('empty_observed_description')} />
    return <EmptyState title={t('empty_all_title')} description={t('empty_all_description')} />
  }

  function content() {
    if (failed) return <EmptyState title={t('load_failed')} description={t('action_failed')} actionLabel={t('attn_review')} onAction={reload} />
    if (loading && !register)
      return (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )
    if (!register) return null
    if (view === 'observed') {
      if (register.observed.length === 0 && register.generic.count === 0) return empty()
      return <ObservedTable rows={register.observed} generic={register.generic} />
    }
    if (rows.length === 0) return empty()
    if (view === 'suggested') {
      return (
        <SuggestionQueue
          rows={suggestedRows}
          selected={selected}
          canWrite={canWrite}
          busy={busy}
          onToggle={(id) =>
            setSelected((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }
          onSelectAll={() => setSelected(new Set(suggestedRows.map((r) => r.id)))}
          onClear={() => setSelected(new Set())}
          onConfirmSelected={() => setConfirmOpen(true)}
          onDismiss={(row) => void decide([row.id], 'dismiss')}
          onOpen={setDossierId}
        />
      )
    }
    return <RegisterTable rows={rows} onOpen={setDossierId} />
  }

  const selectedCount = [...selected].filter((id) => suggestedRows.some((r) => r.id === id)).length

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={counts ? t('summary', { all: counts.all, suggested: counts.suggested, observed: counts.observed }) : undefined}
        help={
          <HelpPopover>
            <p>{t('help')}</p>
          </HelpPopover>
        }
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => void refreshSuggestions()}
            disabled={!canWrite || refreshing}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {!canWrite ? <Lock className="mr-2 h-4 w-4" aria-hidden="true" /> : null}
            {refreshing ? t('refreshing') : t('refresh')}
          </Button>
        }
      />

      {attn}

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<RegisterView> value={view} onChange={setView} options={viewOptions} />
        <ToolbarSearch value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('search_placeholder')} aria-label={t('search_placeholder')} />
        <div className="ml-auto flex items-center gap-2">
          <ContextPicker
            items={periodItems}
            value={period}
            onChange={(id) => setPeriod(id as RegisterPeriod)}
            triggerLabel={periodItems.find((i) => i.id === period)?.label ?? t('period_12m')}
            ariaLabel={t('period_label')}
          />
        </div>
      </div>

      {content()}

      {register && view !== 'observed' && rows.length > 0 ? (
        <p className="px-1 text-xs text-muted-foreground tabular-nums">{t('count_summary', { count: rows.length })}</p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('confirm_dialog_title', { count: selectedCount })}
        description={t('confirm_dialog_body')}
        confirmLabel={t('confirm_n', { count: selectedCount })}
        onConfirm={async () => {
          setConfirmOpen(false)
          await decide([...selected].filter((id) => suggestedRows.some((r) => r.id === id)), 'confirm')
        }}
      />

      <PartyDossier
        partyId={dossierId}
        period={period}
        canWrite={canWrite}
        busy={busy}
        reloadKey={dossierReload}
        onClose={() => setDossierId(null)}
        onConfirm={(id) => void decide([id], 'confirm')}
        onDismiss={(id) => {
          void decide([id], 'dismiss')
          setDossierId(null)
        }}
        onMerge={(subject, suggested) => setMerge({ subject, suggested })}
      />

      {merge ? (
        <MergeDialog
          open
          onOpenChange={(open) => (!open ? setMerge(null) : undefined)}
          subject={merge.subject}
          suggested={merge.suggested}
          busy={busy}
          onMerge={runMerge}
        />
      ) : null}
    </div>
  )
}
