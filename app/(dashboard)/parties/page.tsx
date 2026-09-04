'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { ScbPickerDialog } from '@/components/parties/ScbPickerDialog'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import { SuggestionQueue, isForeign } from '@/components/parties/SuggestionQueue'
import { hasHardKey } from '@/components/parties/format'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { PartyRole, Register, RegisterPeriod, RegisterRow, RegisterView } from '@/lib/parties/register'

const VIEWS: RegisterView[] = ['suggested', 'observed']

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

function roleSummary(t: (k: string, v?: Record<string, string | number>) => string, items: Array<{ roles: PartyRole[] }>): string {
  const suppliers = items.filter((i) => i.roles.includes('supplier')).length
  const customers = items.filter((i) => i.roles.includes('customer')).length
  const parts: string[] = []
  if (suppliers) parts.push(t('summary_suppliers', { count: suppliers }))
  if (customers) parts.push(t('summary_customers', { count: customers }))
  return parts.join(' · ')
}

/**
 * Förslag från bokföringen: the queue in front of Leverantörer and Kunder.
 * Nothing here is a register of its own; confirming creates the supplier or
 * customer row, and "Bara i bokföringen" shows what the vouchers name that
 * nothing owns yet.
 */
function SuggestionsPage() {
  const t = useTranslations('parties')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()

  const initialView: RegisterView = searchParams.get('view') === 'observed' ? 'observed' : 'suggested'
  const [view, setView] = useState<RegisterView>(initialView)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [period, setPeriod] = useState<RegisterPeriod>('12m')
  const [register, setRegister] = useState<Register | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [roleOverrides, setRoleOverrides] = useState<Record<string, PartyRole[]>>({})
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchingRegistry, setFetchingRegistry] = useState(false)
  const [picker, setPicker] = useState<{ partyId: string; name: string } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [dossierId, setDossierId] = useState<string | null>(null)
  const [dossierReload, setDossierReload] = useState(0)
  const [merge, setMerge] = useState<{ subject: MergeCandidate; suggested: MergeCandidate[] } | null>(null)
  const preselected = useRef<string | null>(null)
  const autoRan = useRef(false)

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

  // The books name counterparts the queue has not seen yet: build the
  // suggestions right away instead of asking for a click whose effect nobody
  // could guess. Once per visit, suggestions only, reversible.
  useEffect(() => {
    if (!register || autoRan.current || !canWrite || debounced) return
    if (register.counts.observed > 0) {
      autoRan.current = true
      void refreshSuggestions(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs at most once per mount, guarded by autoRan
  }, [register, canWrite, debounced])

  const counts = register?.counts
  const scbEnabled = Boolean(register?.scbConfigured)
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
  const rolesFor = useCallback((row: RegisterRow): PartyRole[] => roleOverrides[row.id] ?? row.defaultRoles, [roleOverrides])

  async function refreshSuggestions(auto = false) {
    if (refreshing) return
    setRefreshing(true)
    try {
      const summary = await post<{ created: number; attached: number }>('/api/parties/suggest')
      if (auto) {
        if (summary.created > 0) toast({ title: t('auto_created_title', { count: summary.created }), description: t('auto_created_description') })
      }
      else toast({ title: t('refreshed_title'), description: t('refreshed_description', { created: summary.created, attached: summary.attached }) })
      reload()
    } catch {
      fail()
    } finally {
      setRefreshing(false)
    }
  }

  function undoToast(title: string, undoUrl: string, ids: string[], undoneTitle: string) {
    toast({
      title,
      action: (
        <ToastAction
          altText={t('undo')}
          onClick={() => {
            post(undoUrl, { partyIds: ids })
              .then(() => {
                toast({ title: undoneTitle })
                reload()
              })
              .catch(fail)
          }}
        >
          {t('undo')}
        </ToastAction>
      ),
    })
  }

  /**
   * After Lägg upp: fetch the registry facts for every new supplier or
   * customer that carries a legal person's org number, one call at a time
   * (SCB allows ten per ten seconds). Best effort: a failed fetch leaves the
   * row as it was and the dossier still offers Hämta uppgifter.
   */
  async function enrichAfterPromotion(partyIds: string[]) {
    const targets = rows.filter((r) => partyIds.includes(r.id) && isLegalPersonOrgNumber(r.orgNumber)).map((r) => r.id)
    if (targets.length === 0) return
    setFetchingRegistry(true)
    toast({ title: t('promoted_enriching', { count: targets.length }) })
    let done = 0
    try {
      for (const [i, id] of targets.entries()) {
        try {
          const res = await fetch(`/api/parties/${id}/enrich`, { method: 'POST' })
          if (res.ok) done += 1
        } catch {
          // counted as not fetched
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 1100))
      }
    } finally {
      setFetchingRegistry(false)
      toast({ title: t('promoted_enriched_title', { done, total: targets.length }) })
      reload()
    }
  }

  async function promote(items: Array<{ partyId: string; roles: PartyRole[] }>) {
    if (items.length === 0) return
    setBusy(true)
    try {
      const r = await post<{ parties: number; suppliers: number; customers: number }>('/api/parties/promote', { items })
      undoToast(t('promoted_title', { count: r.parties, detail: roleSummary(t, items) }), '/api/parties/promote/undo', items.map((i) => i.partyId), t('undone_title'))
      setSelected((prev) => {
        const next = new Set(prev)
        for (const i of items) next.delete(i.partyId)
        return next
      })
      reload()
      if (scbEnabled) void enrichAfterPromotion(items.map((i) => i.partyId))
    } catch {
      fail()
    } finally {
      setBusy(false)
    }
  }

  async function dismiss(ids: string[]) {
    if (ids.length === 0) return
    setBusy(true)
    try {
      const { count } = await post<{ count: number }>('/api/parties/decide', { partyIds: ids, kind: 'dismiss' })
      undoToast(t('dismissed_title', { count }), '/api/parties/decide/undo', ids, t('undone_title'))
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

  async function fetchRegistry(id: string, orgNumber?: string) {
    setFetchingRegistry(true)
    try {
      const res = await fetch(`/api/parties/${id}/enrich`, {
        method: 'POST',
        headers: orgNumber ? { 'Content-Type': 'application/json' } : undefined,
        body: orgNumber ? JSON.stringify({ orgNumber }) : undefined,
      })
      const json = (await res.json()) as { data?: { found: boolean; orgNumber: string; inserted: number; superseded: number; refreshed: number }; error?: { code: string } }
      if (!res.ok || !json.data) {
        const details = (json as { error?: { details?: { reason?: string; displayName?: string } } }).error?.details
        if (details?.reason === 'org_number_taken') {
          toast({ title: t('picker_taken_title', { name: details.displayName ?? '' }), description: t('picker_taken_description') })
          return
        }
        toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
        return
      }
      setPicker(null)
      if (!json.data.found) {
        toast({ title: t('registry_not_found_title'), description: t('registry_not_found_description', { org: json.data.orgNumber }) })
        return
      }
      toast({ title: t('registry_fetched_title'), description: t('registry_fetched_description', { inserted: json.data.inserted, superseded: json.data.superseded, refreshed: json.data.refreshed }) })
      setDossierReload((k) => k + 1)
    } catch {
      toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
    } finally {
      setFetchingRegistry(false)
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
  const searching = debounced.length > 0
  const selectedItems = rows.filter((r) => selected.has(r.id)).map((r) => ({ partyId: r.id, roles: rolesFor(r) }))
  // Rows SCB could complete but cannot yet (no org number), and rows it can
  // never hold (the text places them abroad): two different sentences.
  const foreignCount = rows.filter((r) => selected.has(r.id) && isForeign(r)).length
  const missingOrg = rows.filter((r) => selected.has(r.id) && !r.orgNumber && r.kind !== 'person' && !isForeign(r)).length

  let attn: React.ReactNode = null
  if (counts && counts.suggested === 0 && counts.observed > 0 && canWrite && view === 'observed') {
    attn = <AttnLine action={{ label: t('attn_create'), onClick: () => void refreshSuggestions() }}>{t('attn_observed', { count: counts.observed })}</AttnLine>
  }

  function empty() {
    if (searching) return <EmptyState title={t('empty_search_title')} description={t('empty_search_description')} />
    if (view === 'observed') return <EmptyState title={t('empty_observed_title')} description={t('empty_observed_description')} />
    return (
      <EmptyState
        title={t('empty_suggested_title')}
        description={t('empty_suggested_description')}
        actionLabel={canWrite ? t('refresh') : undefined}
        onAction={canWrite ? () => void refreshSuggestions() : undefined}
        secondaryActionLabel={t('go_suppliers')}
        secondaryActionHref="/suppliers"
      />
    )
  }

  function content() {
    if (failed) return <EmptyState title={t('load_failed')} description={t('action_failed')} actionLabel={tCommon('retry')} onAction={reload} />
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
    return (
      <SuggestionQueue
        rows={rows}
        selected={selected}
        roles={rolesFor}
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
        onSelectAll={() => setSelected(new Set(rows.map((r) => r.id)))}
        onClear={() => setSelected(new Set())}
        onRoles={(id, roles) => setRoleOverrides((prev) => ({ ...prev, [id]: roles }))}
        onConfirmSelected={() => setConfirmOpen(true)}
        onDismiss={(row) => void dismiss([row.id])}
        onOpen={setDossierId}
        onFind={scbEnabled ? (row) => setPicker({ partyId: row.id, name: row.displayName }) : undefined}
      />
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={counts ? t('summary', { suggested: counts.suggested, observed: counts.observed }) : undefined}
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
        <SegmentedControl<RegisterView>
          value={view}
          onChange={(v) => {
            setView(v)
            router.replace(v === 'observed' ? '/parties?view=observed' : '/parties', { scroll: false })
          }}
          options={viewOptions}
        />
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

      {register && view === 'suggested' && rows.length > 0 ? (
        <p className="px-1 text-xs text-muted-foreground tabular-nums">{t('count_summary', { count: rows.length })}</p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('promote_dialog_title', { count: selectedItems.length })}
        description={
          missingOrg > 0 || foreignCount > 0
            ? [
                t('promote_dialog_body', { detail: roleSummary(t, selectedItems) }),
                missingOrg > 0 ? t('promote_dialog_missing_org', { missing: missingOrg, count: selectedItems.length }) : null,
                foreignCount > 0 ? t('promote_dialog_foreign', { foreign: foreignCount, count: selectedItems.length }) : null,
              ]
                .filter(Boolean)
                .join(' ')
            : t('promote_dialog_body', { detail: roleSummary(t, selectedItems) })
        }
        confirmLabel={t('promote_n', { count: selectedItems.length })}
        onConfirm={async () => {
          setConfirmOpen(false)
          await promote(selectedItems)
        }}
      />

      <PartyDossier
        partyId={dossierId}
        period={period}
        canWrite={canWrite}
        busy={busy}
        reloadKey={dossierReload}
        onClose={() => setDossierId(null)}
        onPromote={(id, roles) => void promote([{ partyId: id, roles }])}
        onDismiss={(id) => {
          void dismiss([id])
          setDossierId(null)
        }}
        onMerge={(subject, suggested) => setMerge({ subject, suggested })}
        onFetchRegistry={scbEnabled ? (id) => void fetchRegistry(id) : undefined}
        onPickRegistry={scbEnabled ? (id, name) => setPicker({ partyId: id, name }) : undefined}
        fetching={fetchingRegistry}
      />

      {picker ? (
        <ScbPickerDialog
          open
          onOpenChange={(open) => (!open ? setPicker(null) : undefined)}
          partyId={picker.partyId}
          partyName={picker.name}
          busy={fetchingRegistry}
          onPick={async (c: ScbCandidate) => {
            await fetchRegistry(picker.partyId, c.orgNumber)
          }}
        />
      ) : null}

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

export default function PartiesPage() {
  return (
    <Suspense fallback={null}>
      <SuggestionsPage />
    </Suspense>
  )
}
