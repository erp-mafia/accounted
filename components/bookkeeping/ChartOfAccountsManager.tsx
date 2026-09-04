'use client'

import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { AccountNumber } from '@/components/ui/account-number'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { AddAccountDialog } from './AddAccountDialog'
import { EditAccountDialog } from './EditAccountDialog'
import { PruneAccountsDialog } from './PruneAccountsDialog'
import {
  ChevronRight,
  ListFilter,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BASAccount } from '@/types'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import type { BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'
import { isStandardBASAccountNumber } from '@/lib/bookkeeping/bas-account-numbers'
import { ensureBasLoaded } from '@/lib/bookkeeping/bas-lazy'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReferenceAccount extends BASReferenceAccount {
  is_activated: boolean
  is_active: boolean
  is_system_account: boolean
}

/**
 * Column-header filter on "Verifikat" (#2186). "unused" means the account is
 * absent from get_account_usage_counts, i.e. never posted to: the set a
 * migrated chart wants pruned, since a short kontoplan is what keeps manual
 * bookings off the wrong account.
 */
type UsageFilter = 'all' | 'unused' | 'used'

const USAGE_FILTER_KEY = {
  all: 'usage_filter_all',
  unused: 'usage_filter_unused',
  used: 'usage_filter_used',
} as const

/**
 * Rows per BAS class in an unnarrowed list: the "total" a band row is
 * measured against once search or the Verifikat filter narrows it (#2263).
 */
function countByClass(list: ReadonlyArray<{ account_class: number }>): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const a of list) counts[a.account_class] = (counts[a.account_class] ?? 0) + 1
  return counts
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChartOfAccountsManager() {
  const { toast } = useToast()
  const t = useTranslations('chart_of_accounts')
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()

  const classLabel = (cls: number): string => {
    if (cls < 1 || cls > 8) return ''
    return t(`class_${cls}` as const)
  }

  const typeLabel = (type: string): string => {
    const key = `type_${type}` as const
    try {
      return t(key)
    } catch {
      return type
    }
  }

  // View state. Mina konton renders flat (concept scene 30), so its band
  // rows track the classes the user has explicitly FOLDED AWAY; the BAS
  // catalog (~1300 rows) keeps the inverse default and tracks the classes
  // the user has opened.
  const [view, setView] = useState<'my-accounts' | 'bas-catalog'>('my-accounts')
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedMyClasses, setCollapsedMyClasses] = useState<Set<number>>(new Set())
  const [expandedCatalogClasses, setExpandedCatalogClasses] = useState<Set<number>>(new Set())
  const [hideK2Excluded, setHideK2Excluded] = useState<boolean | null>(null)
  const { settings: companySettings } = useCompanySettings()
  // Off by default: the list endpoint's `?active=false` means "no filter", so
  // leaving it off keeps first paint on the smaller active-only payload.
  // A deactivated account is otherwise invisible everywhere and unrecoverable.
  const [showInactive, setShowInactive] = useState(false)
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all')
  // Row selection for the bulk inactivate (#2186), keyed by account number
  // (the PUT/deactivate routes key on it too). Cleared on view switch.
  const [selectedNumbers, setSelectedNumbers] = useState<Set<string>>(new Set())
  const [bulkDeactivating, setBulkDeactivating] = useState(false)
  // The usage map loads after first paint; until it has, "utan verifikat"
  // would match every account, so the filter stays disabled.
  const [usageLoaded, setUsageLoaded] = useState(false)

  // Data state
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [referenceAccounts, setReferenceAccounts] = useState<ReferenceAccount[]>([])
  const [usageCounts, setUsageCounts] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  // The BAS catalog + K2 default are fetched lazily the first time the user
  // opens that tab, so they never block the default "Mina konton" view.
  const [referenceLoaded, setReferenceLoaded] = useState(false)
  const [referenceLoading, setReferenceLoading] = useState(false)

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [editAccount, setEditAccount] = useState<BASAccount | null>(null)
  const [pruneDialogOpen, setPruneDialogOpen] = useState(false)

  // Action states
  const [togglingAccount, setTogglingAccount] = useState<string | null>(null)
  const [deletingAccount, setDeletingAccount] = useState<string | null>(null)
  const [activatingAccounts, setActivatingAccounts] = useState<Set<string>>(new Set())

  // -------------------------------------------
  // Data fetching
  // -------------------------------------------

  // Read through a ref, not the state value: making fetchAccounts depend on
  // showInactive would put it in the mount effect's dep list and re-run the
  // whole blocking load on every toggle (the same double-fetch the comment
  // below warns about for hideK2Excluded).
  const showInactiveRef = useRef(showInactive)
  showInactiveRef.current = showInactive

  const fetchAccounts = useCallback(async () => {
    // `?active=false` disables the filter entirely (active + inactive), it does
    // not select inactive rows only — see list_company_accounts.
    const res = await fetch(
      showInactiveRef.current ? '/api/bookkeeping/accounts?active=false' : '/api/bookkeeping/accounts',
    )
    const { data } = await res.json()
    setAccounts(data || [])
  }, [])

  // The server sends only the company's per-account activation status; the BAS
  // catalog is static and already bundled here, so we merge client-side rather
  // than re-download ~1,300 catalog rows on every load.
  const fetchReference = useCallback(async () => {
    const res = await fetch('/api/bookkeeping/accounts/reference')
    const { data } = await res.json()
    const userMap = new Map<string, { account_number: string; is_active: boolean; is_system_account: boolean }>(
      (data || []).map(
        (a: { account_number: string; is_active: boolean; is_system_account: boolean }) => [a.account_number, a],
      ),
    )
    // The full chart is a lazily loaded chunk: only the BAS-katalog tab pays
    // for it, not every route that renders this component's parent.
    const BAS_REFERENCE = await ensureBasLoaded()
    const merged: ReferenceAccount[] = BAS_REFERENCE.map((ref) => {
      const userAccount = userMap.get(ref.account_number)
      return {
        ...ref,
        is_activated: !!userAccount,
        is_active: userAccount?.is_active ?? false,
        is_system_account: userAccount?.is_system_account ?? false,
      }
    })
    setReferenceAccounts(merged)
  }, [])

  // Per-account posting counts — drives the "Verifikat" column. Non-fatal:
  // the page works without it, cells just show a dash.
  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch('/api/bookkeeping/accounts/usage')
      if (!res.ok) return
      const { data } = await res.json()
      setUsageCounts(
        new Map(
          (data || []).map((u: { account_number: string; usage_count: number }) => [
            u.account_number,
            Number(u.usage_count),
          ]),
        ),
      )
      setUsageLoaded(true)
    } catch {
      // Leave the map empty — usage display is informational only.
    }
  }, [])

  // First paint blocks only on the user's own chart (the default view). Usage
  // counts drive the informational "Verifikat" column and load in the
  // background; the BAS catalog + K2 setting are deferred to tab open. This
  // must NOT depend on hideK2Excluded: doing so re-ran the whole load a second
  // time once the K2 default was set, doubling every fetch on each visit.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      await fetchAccounts()
      if (!cancelled) setLoading(false)
    }
    load()
    void fetchUsage()
    return () => {
      cancelled = true
    }
  }, [fetchAccounts, fetchUsage])

  // Refetch when the inactive filter flips. Skips the first run (the mount
  // effect above already fetched) and deliberately does not raise `loading`:
  // swapping a filter should not blank the table back to the skeleton.
  const showInactiveInitial = useRef(true)
  useEffect(() => {
    if (showInactiveInitial.current) {
      showInactiveInitial.current = false
      return
    }
    void fetchAccounts()
  }, [showInactive, fetchAccounts])

  // Loads the BAS catalog and the K2 default on demand, once, the first time
  // the user opens the "BAS-katalog" tab.
  const ensureReferenceLoaded = useCallback(async () => {
    if (referenceLoaded || referenceLoading) return
    setReferenceLoading(true)
    try {
      await Promise.all([
        fetchReference(),
        (async () => {
          if (hideK2Excluded !== null) return
          // Default to hiding K2-excluded accounts if the company uses K2
          // (plan_type === 'k1'). Settings come from the session cache.
          setHideK2Excluded(
            (companySettings as { plan_type?: string } | null)?.plan_type === 'k1',
          )
        })(),
      ])
      setReferenceLoaded(true)
    } finally {
      setReferenceLoading(false)
    }
  }, [referenceLoaded, referenceLoading, fetchReference, hideK2Excluded, companySettings])

  const refreshAll = useCallback(async () => {
    await Promise.all([
      fetchAccounts(),
      fetchUsage(),
      // Only refresh the catalog if the user has actually opened that tab.
      ...(referenceLoaded ? [fetchReference()] : []),
    ])
  }, [fetchAccounts, fetchUsage, fetchReference, referenceLoaded])

  // -------------------------------------------
  // Actions
  // -------------------------------------------

  async function toggleActive(account: BASAccount) {
    // Deactivating an account that carries postings hides it from the
    // kontoplan and from new verifikat while its balances stay in the books.
    // That is legal and reversible, but it should never happen silently: it is
    // what made a used account unreachable in the first place. The count is
    // already in memory from fetchUsage, so no extra request.
    const usage = usageCounts.get(account.account_number) ?? 0
    if (account.is_active && usage > 0) {
      const confirmed = await confirm({
        title: t('deactivate_confirm_title', { number: account.account_number }),
        description: t('deactivate_confirm', { count: usage }),
        confirmLabel: t('deactivate_confirm_action'),
        variant: 'warning',
      })
      if (!confirmed) return
    }

    setTogglingAccount(account.account_number)
    try {
      const res = await fetch(`/api/bookkeeping/accounts/${account.account_number}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !account.is_active }),
      })
      if (!res.ok) throw new Error(t('toast_update_failed'))
      await refreshAll()
    } catch {
      toast({ title: t('toast_update_failed'), variant: 'destructive' })
    } finally {
      setTogglingAccount(null)
    }
  }

  // Bulk inactivate of the selection (#2186). Only never-used, non-system,
  // active accounts go: a used account hides its balances from the kontoplan,
  // so it keeps the per-row toggle with its own confirm. The route enforces
  // the same partition server-side; the client partitions first so the
  // confirm can say exactly what will and will not happen (convention 10).
  async function bulkDeactivate() {
    const byNumber = new Map(accounts.map((a) => [a.account_number, a]))
    const unused: string[] = []
    let used = 0
    let system = 0
    for (const number of selectedNumbers) {
      const account = byNumber.get(number)
      if (!account || !account.is_active) continue
      if (account.is_system_account) {
        system += 1
        continue
      }
      if (usageCounts.has(number)) {
        used += 1
        continue
      }
      unused.push(number)
    }
    if (unused.length === 0) {
      toast({ title: t('bulk_deactivate_none_unused') })
      return
    }
    const skippedNote = [
      used > 0 ? t('bulk_deactivate_skipped_used', { count: used }) : null,
      system > 0 ? t('bulk_deactivate_skipped_system', { count: system }) : null,
    ]
      .filter(Boolean)
      .join(' ')
    const confirmed = await confirm({
      title: t('bulk_deactivate_confirm_title', { count: unused.length }),
      description: [t('bulk_deactivate_confirm', { count: unused.length }), skippedNote]
        .filter(Boolean)
        .join(' '),
      confirmLabel: t('deactivate_confirm_action'),
      variant: 'warning',
    })
    if (!confirmed) return

    setBulkDeactivating(true)
    try {
      const res = await fetch('/api/bookkeeping/accounts/deactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_numbers: unused }),
      })
      if (!res.ok) throw new Error(t('toast_update_failed'))
      const body = (await res.json().catch(() => ({}))) as { deactivated?: number }
      toast({ title: t('bulk_deactivate_done', { count: Number(body.deactivated ?? 0) }) })
      setSelectedNumbers(new Set())
      await refreshAll()
    } catch {
      toast({ title: t('toast_update_failed'), variant: 'destructive' })
    } finally {
      setBulkDeactivating(false)
    }
  }

  async function deleteAccount(account: BASAccount) {
    const confirmed = await confirm({
      title: t('delete_confirm_title'),
      description: t('delete_confirm', { number: account.account_number, name: account.account_name }),
      confirmLabel: t('delete_confirm_action'),
      cancelLabel: tCommon('cancel'),
    })
    if (!confirmed) return
    setDeletingAccount(account.account_number)
    try {
      const res = await fetch(`/api/bookkeeping/accounts/${account.account_number}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        // The route answers thrown errors with the canonical envelope
        // `{ error: { code, message } }`. `new Error(data.error)` would
        // stringify that object to "[object Object]" and the reason would be
        // lost; hand getErrorMessage the parsed body plus the status instead.
        const body = await res.json().catch(() => null)
        toast({
          title: getUserErrorMessage(body, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('toast_account_deleted'), description: `${account.account_number} ${account.account_name}` })
      await refreshAll()
    } catch (err) {
      toast({
        title: err instanceof Error ? getUserErrorMessage(err) : t('toast_delete_failed'),
        variant: 'destructive',
      })
    } finally {
      setDeletingAccount(null)
    }
  }

  async function activateBASAccount(accountNumber: string) {
    setActivatingAccounts((prev) => new Set(prev).add(accountNumber))
    try {
      const res = await fetch('/api/bookkeeping/accounts/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_numbers: [accountNumber] }),
      })
      if (!res.ok) throw new Error(t('toast_activate_failed'))
      // `reactivated` covers an account the company already had but had turned
      // off. Without it the catalog tab flipped the row back on in silence.
      const { activated, reactivated } = await res.json()
      if (activated > 0) {
        toast({ title: t('toast_activated_title'), description: t('toast_activated_description', { number: accountNumber }) })
      } else if (reactivated > 0) {
        toast({ title: t('toast_reactivated_title'), description: t('toast_reactivated_description', { number: accountNumber }) })
      }
      await refreshAll()
    } catch {
      toast({ title: t('toast_activate_failed'), variant: 'destructive' })
    } finally {
      setActivatingAccounts((prev) => {
        const next = new Set(prev)
        next.delete(accountNumber)
        return next
      })
    }
  }

  // -------------------------------------------
  // Toggle class expansion (band rows)
  // -------------------------------------------

  function toggleMyClass(cls: number) {
    setCollapsedMyClasses((prev) => {
      const next = new Set(prev)
      if (next.has(cls)) next.delete(cls)
      else next.add(cls)
      return next
    })
  }

  function toggleCatalogClass(cls: number) {
    setExpandedCatalogClasses((prev) => {
      const next = new Set(prev)
      if (next.has(cls)) next.delete(cls)
      else next.add(cls)
      return next
    })
  }

  // -------------------------------------------
  // Filtered & grouped data
  // -------------------------------------------

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.toLowerCase()
    return accounts.filter((a) => {
      if (q && !(a.account_number.includes(q) || a.account_name.toLowerCase().includes(q))) {
        return false
      }
      // Absence from the usage map means never posted to (see /usage).
      if (usageFilter === 'unused' && usageCounts.has(a.account_number)) return false
      if (usageFilter === 'used' && !usageCounts.has(a.account_number)) return false
      return true
    })
  }, [accounts, searchQuery, usageFilter, usageCounts])

  const visibleNumbers = useMemo(
    () => filteredAccounts.map((a) => a.account_number),
    [filteredAccounts],
  )
  const allVisibleSelected =
    visibleNumbers.length > 0 && visibleNumbers.every((n) => selectedNumbers.has(n))
  const toggleSelect = (number: string) =>
    setSelectedNumbers((prev) => {
      const next = new Set(prev)
      if (next.has(number)) next.delete(number)
      else next.add(number)
      return next
    })
  const toggleSelectAllVisible = () =>
    setSelectedNumbers(allVisibleSelected ? new Set() : new Set(visibleNumbers))

  const groupedAccounts = useMemo(() => {
    const grouped: Record<number, BASAccount[]> = {}
    for (const a of filteredAccounts) {
      const cls = a.account_class
      if (!grouped[cls]) grouped[cls] = []
      grouped[cls].push(a)
    }
    return grouped
  }, [filteredAccounts])

  // The K2 toggle is scope, not a filter: it defaults from the company's
  // regelverk (ensureReferenceLoaded), so a K2 company sees it on without
  // touching anything. The band counters treat this scoped set as the whole.
  const scopedReference = useMemo(
    () => (hideK2Excluded ? referenceAccounts.filter((a) => !a.k2_excluded) : referenceAccounts),
    [referenceAccounts, hideK2Excluded],
  )

  const filteredReference = useMemo(() => {
    if (!searchQuery) return scopedReference
    const q = searchQuery.toLowerCase()
    return scopedReference.filter(
      (a) => a.account_number.includes(q) || a.account_name.toLowerCase().includes(q)
    )
  }, [scopedReference, searchQuery])

  const groupedReference = useMemo(() => {
    const grouped: Record<number, ReferenceAccount[]> = {}
    for (const a of filteredReference) {
      const cls = a.account_class
      if (!grouped[cls]) grouped[cls] = []
      grouped[cls].push(a)
    }
    return grouped
  }, [filteredReference])

  // Band-row counters (#2263). "{active}/{total} aktiva" is only honest when
  // the band holds the whole class: once search or the Verifikat filter
  // narrows the list, "43/43 aktiva" reads as full coverage of a class that
  // is really a subset. A narrowed band counts what it shows against the
  // unnarrowed class instead; an unnarrowed band keeps the active ratio.
  const myListNarrowed = searchQuery !== '' || usageFilter !== 'all'
  const catalogNarrowed = searchQuery !== ''
  const myClassTotals = useMemo(() => countByClass(accounts), [accounts])
  const catalogClassTotals = useMemo(() => countByClass(scopedReference), [scopedReference])

  // -------------------------------------------
  // Render
  // -------------------------------------------

  const shownCount = view === 'my-accounts' ? filteredAccounts.length : filteredReference.length
  const totalCount = view === 'my-accounts' ? accounts.length : referenceAccounts.length

  // Page header + toolbar render even while loading so the chrome is stable.
  const header = (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="font-display text-2xl leading-8 tracking-tight">{tNav('chart_of_accounts')}</h1>
      <div className="flex items-center gap-4">
        <Badge variant="outline" className="font-normal">{t('bas_version_chip')}</Badge>
        <button type="button" className={QUIET_LINK_CLASS} onClick={() => setPruneDialogOpen(true)}>
          {t('prune_button')}
        </button>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('add_own')}
        </Button>
      </div>
    </div>
  )

  const switchView = (next: 'my-accounts' | 'bas-catalog') => {
    setView(next)
    setSelectedNumbers(new Set())
    setCollapsedMyClasses(new Set())
    setExpandedCatalogClasses(new Set())
    if (next === 'bas-catalog') void ensureReferenceLoaded()
  }

  // Concept band row (Klass N: label), clickable to fold the class away.
  const bandRow = (
    cls: number,
    open: boolean,
    onToggle: () => void,
    countLabel: string,
    colSpan: number,
  ) => (
    <tr key={`band-${cls}`}>
      <td colSpan={colSpan} className="border-b border-border p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 bg-muted/40 px-3 py-[7px] text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors duration-150 hover:bg-muted/60"
        >
          <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform duration-200', open && 'rotate-90')} />
          {t('class_heading', { cls, label: classLabel(cls) })}
          <span className="font-normal normal-case tabular-nums">{countLabel}</span>
        </button>
      </td>
    </tr>
  )

  return (
    <div className="space-y-8">
      {header}

      {/* Toolbar: seg + search; the K2 filter rides far right in catalog view */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={view}
          onChange={switchView}
          options={[
            { value: 'my-accounts', label: t('tab_my_accounts'), count: accounts.length },
            { value: 'bas-catalog', label: t('tab_bas_catalog') },
          ]}
        />
        <ToolbarSearch
          placeholder={t('search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          containerClassName="min-w-[190px] max-w-xs flex-1"
        />
        {view === 'my-accounts' && (
          <label className="ml-auto flex items-center gap-2 text-sm">
            <Switch
              checked={showInactive}
              onCheckedChange={setShowInactive}
              className="scale-75"
            />
            <span className="text-muted-foreground">{t('show_inactive')}</span>
          </label>
        )}
        {view === 'bas-catalog' && (
          <label className="ml-auto flex items-center gap-2 text-sm">
            <Switch
              checked={hideK2Excluded ?? false}
              onCheckedChange={setHideK2Excluded}
              className="scale-75"
            />
            <span className="text-muted-foreground">{t('hide_k2_excluded')}</span>
          </label>
        )}
      </div>

      {loading ? (
        <div className="space-y-2 py-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : view === 'my-accounts' ? (
        filteredAccounts.length === 0 ? (
          <p className="px-1 py-12 text-center text-sm text-muted-foreground">
            {searchQuery || usageFilter !== 'all' ? t('no_matches') : t('no_accounts')}
          </p>
        ) : (
          <div>
            {/* Bulk bar: appears with the first selection, carries the count
                and the one action the selection exists for. */}
            {selectedNumbers.size > 0 && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-1 py-2 text-[12.5px] animate-fade-in">
                <span className="whitespace-nowrap">
                  <strong className="font-semibold tabular-nums">{selectedNumbers.size}</strong>{' '}
                  {t('bulkbar_selected', { count: selectedNumbers.size })}
                </span>
                <Button size="sm" onClick={bulkDeactivate} disabled={bulkDeactivating}>
                  {bulkDeactivating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('deactivate_confirm_action')}
                </Button>
                {!allVisibleSelected && (
                  <button type="button" className={QUIET_LINK_CLASS} onClick={toggleSelectAllVisible}>
                    {t('bulk_select_all', { count: visibleNumbers.length })}
                  </button>
                )}
                <button
                  type="button"
                  className={QUIET_LINK_CLASS}
                  onClick={() => setSelectedNumbers(new Set())}
                  disabled={bulkDeactivating}
                >
                  {t('bulk_clear_selection')}
                </button>
              </div>
            )}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={cn(TH_CLASS, 'w-[36px] pr-0')}>
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleSelectAllVisible}
                      aria-label={t('select_all_aria')}
                      className="border-foreground"
                    />
                  </th>
                  <th className={cn(TH_CLASS, 'w-[96px]')}>{t('col_account')}</th>
                  <th className={cn(TH_CLASS, 'w-full')}>{t('col_name')}</th>
                  <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('col_sru')}</th>
                  <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('col_type')}</th>
                  <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>
                    {/* The header is the filter (#2186): pick all / never
                        posted to / posted to, the way the verifikat list
                        filters from its headers. */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          disabled={!usageLoaded}
                          aria-label={t('usage_filter_label')}
                          className={cn(
                            'inline-flex items-center gap-1 transition-colors duration-150 hover:text-foreground disabled:opacity-50',
                            usageFilter !== 'all' && 'text-foreground',
                          )}
                        >
                          {usageFilter === 'all' ? t('col_usage') : t(USAGE_FILTER_KEY[usageFilter])}
                          <ListFilter className="h-3 w-3" aria-hidden />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuRadioGroup
                          value={usageFilter}
                          onValueChange={(v) => setUsageFilter(v as UsageFilter)}
                        >
                          {(['all', 'unused', 'used'] as const).map((value) => (
                            <DropdownMenuRadioItem key={value} value={value}>
                              {t(USAGE_FILTER_KEY[value])}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </th>
                  <th className={TH_CLASS}>{t('col_active')}</th>
                  <th className={cn(TH_CLASS, 'w-[84px]')} aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {Object.entries(groupedAccounts)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([cls, classAccounts]) => {
                    const classNum = Number(cls)
                    const open = !collapsedMyClasses.has(classNum) || !!searchQuery
                    const activeCount = classAccounts.filter((a) => a.is_active).length
                    return (
                      <Fragment key={cls}>
                        {bandRow(
                          classNum,
                          open,
                          () => toggleMyClass(classNum),
                          myListNarrowed
                            ? t('shown_count_label', {
                                shown: classAccounts.length,
                                total: myClassTotals[classNum] ?? classAccounts.length,
                              })
                            : t('active_count_label', { active: activeCount, total: classAccounts.length }),
                          8,
                        )}
                        {open &&
                          classAccounts.map((account) => (
                            <tr
                              key={account.id}
                              className={cn(
                                'group transition-colors duration-150 hover:bg-secondary/35',
                                // Dim the text rather than the whole row: a
                                // row-level opacity would drag the "Inaktiv"
                                // chip below readable contrast with it.
                                !account.is_active && 'text-muted-foreground',
                              )}
                            >
                              <td className={cn(TD_CLASS, 'w-[36px] pr-0 py-[9px]')}>
                                <Checkbox
                                  checked={selectedNumbers.has(account.account_number)}
                                  onCheckedChange={() => toggleSelect(account.account_number)}
                                  aria-label={t('select_row_aria', { number: account.account_number })}
                                  className={cn(
                                    'border-foreground',
                                    CHECKBOX_REVEAL_CLASS,
                                    selectedNumbers.has(account.account_number) && 'opacity-100',
                                  )}
                                />
                              </td>
                              <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                                <AccountNumber number={account.account_number} name={account.account_name} />
                              </td>
                              <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate">{account.account_name}</span>
                                  {account.is_system_account && (
                                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                                      {t('system_badge')}
                                    </span>
                                  )}
                                  {!isStandardBASAccountNumber(account.account_number) && (
                                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                                      {t('own_badge')}
                                    </span>
                                  )}
                                  {/* Exception chip: only visible while the
                                      "Visa inaktiva" filter is on, so it never
                                      lands on every row. */}
                                  {!account.is_active && (
                                    <Badge variant="secondary" className="shrink-0">
                                      {t('prune_inactive_badge')}
                                    </Badge>
                                  )}
                                </span>
                              </td>
                              <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                                {account.sru_code || ''}
                              </td>
                              <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground md:table-cell')}>
                                {typeLabel(account.account_type)}
                              </td>
                              <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                                {usageCounts.get(account.account_number) ?? ''}
                              </td>
                              <td className={cn(TD_CLASS, 'whitespace-nowrap py-[9px]')}>
                                <Switch
                                  checked={account.is_active}
                                  onCheckedChange={() => toggleActive(account)}
                                  disabled={togglingAccount === account.account_number}
                                  aria-label={t('col_active') + ' ' + account.account_number}
                                  className="scale-75"
                                />
                              </td>
                              <td className={cn(TD_CLASS, 'whitespace-nowrap text-right py-[5px]')}>
                                <span
                                  className={cn(
                                    'inline-flex items-center justify-end gap-1 transition-opacity duration-150',
                                    'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
                                  )}
                                >
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    aria-label={tCommon('edit')}
                                    onClick={() => setEditAccount(account)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  {!account.is_system_account && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 text-destructive hover:text-destructive"
                                      aria-label={t('delete_confirm_action')}
                                      onClick={() => deleteAccount(account)}
                                      disabled={deletingAccount === account.account_number}
                                    >
                                      {deletingAccount === account.account_number ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <Trash2 className="h-3.5 w-3.5" />
                                      )}
                                    </Button>
                                  )}
                                </span>
                              </td>
                            </tr>
                          ))}
                      </Fragment>
                    )
                  })}
              </tbody>
            </table>
          </div>
          </div>
        )
      ) : (
        <div>
          {referenceLoading && referenceAccounts.length === 0 ? (
            <div className="space-y-2 py-2">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : filteredReference.length === 0 ? (
            <p className="px-1 py-12 text-center text-sm text-muted-foreground">{t('no_matches')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={cn(TH_CLASS, 'w-[96px]')}>{t('col_account')}</th>
                    <th className={cn(TH_CLASS, 'w-full')}>{t('col_name')}</th>
                    <th className={cn(TH_CLASS, 'hidden text-right sm:table-cell')}>{t('col_sru')}</th>
                    <th className={cn(TH_CLASS, 'hidden md:table-cell')}>{t('col_type')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_status')}</th>
                  </tr>
                </thead>
                <tbody className="stagger-enter">
                  {Object.entries(groupedReference)
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([cls, classAccounts]) => {
                      const classNum = Number(cls)
                      const open = expandedCatalogClasses.has(classNum) || !!searchQuery
                      // Row existence alone is not activation: a deactivated
                      // account is in the chart but not usable, so it must not
                      // count as active here either.
                      const activatedCount = classAccounts.filter((a) => a.is_activated && a.is_active).length
                      return (
                        <Fragment key={cls}>
                          {bandRow(
                            classNum,
                            open,
                            () => toggleCatalogClass(classNum),
                            catalogNarrowed
                              ? t('shown_count_label', {
                                  shown: classAccounts.length,
                                  total: catalogClassTotals[classNum] ?? classAccounts.length,
                                })
                              : t('active_count_label', { active: activatedCount, total: classAccounts.length }),
                            5,
                          )}
                          {open &&
                            classAccounts.map((account) => (
                              <tr
                                key={account.account_number}
                                className="group transition-colors duration-150 hover:bg-secondary/35"
                              >
                                <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                                  <AccountNumber number={account.account_number} name={account.account_name} />
                                </td>
                                <td
                                  className={cn(TD_CLASS, 'max-w-0 w-full')}
                                  title={account.description || undefined}
                                >
                                  <span className="block truncate">{account.account_name}</span>
                                </td>
                                <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                                  {account.sru_code || ''}
                                </td>
                                <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground md:table-cell')}>
                                  {typeLabel(account.account_type)}
                                </td>
                                <td className={cn(TD_CLASS, 'whitespace-nowrap text-right py-[9px]')}>
                                  {/* An account the company holds but has
                                      deactivated is NOT activated: it falls
                                      through to the button, relabelled so the
                                      user sees it is coming back, not new. */}
                                  {account.is_activated && account.is_active ? (
                                    <span className="inline-flex items-center gap-1 text-xs text-success">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      {t('activated')}
                                    </span>
                                  ) : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 px-3.5 text-xs"
                                      onClick={() => activateBASAccount(account.account_number)}
                                      disabled={activatingAccounts.has(account.account_number)}
                                    >
                                      {activatingAccounts.has(account.account_number) ? (
                                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                      ) : (
                                        <Plus className="mr-1 h-3 w-3" />
                                      )}
                                      {account.is_activated ? t('reactivate') : t('add')}
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </Fragment>
                      )
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Footer note (concept pgnote) */}
      {!loading && totalCount > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {t('footer_note', { shown: shownCount, total: totalCount })}
        </p>
      )}

      {/* Dialogs */}
      <DestructiveConfirmDialog {...confirmDialogProps} />

      <AddAccountDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onCreated={refreshAll}
      />

      <PruneAccountsDialog
        open={pruneDialogOpen}
        onOpenChange={setPruneDialogOpen}
        onPruned={refreshAll}
      />

      {editAccount && (
        <EditAccountDialog
          open={!!editAccount}
          onOpenChange={(open) => { if (!open) setEditAccount(null) }}
          account={editAccount}
          onSaved={refreshAll}
        />
      )}
    </div>
  )
}
