'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  Search,
  ChevronDown,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  CheckCircle2,
  BookOpen,
} from 'lucide-react'
import type { BASAccount } from '@/types'
import { BAS_REFERENCE, isStandardBASAccount, type BASReferenceAccount } from '@/lib/bookkeeping/bas-reference'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReferenceAccount extends BASReferenceAccount {
  is_activated: boolean
  is_active: boolean
  is_system_account: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ChartOfAccountsManager() {
  const { toast } = useToast()
  const t = useTranslations('chart_of_accounts')
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

  // View state
  const [view, setView] = useState<'my-accounts' | 'bas-catalog'>('my-accounts')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedClasses, setExpandedClasses] = useState<Set<number>>(new Set())
  const [hideK2Excluded, setHideK2Excluded] = useState<boolean | null>(null)

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

  const fetchAccounts = useCallback(async () => {
    const res = await fetch('/api/bookkeeping/accounts')
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
          try {
            const res = await fetch('/api/settings')
            if (res.ok) {
              const { data } = await res.json()
              // Default to hiding K2-excluded accounts if the company uses K2 (plan_type === 'k1')
              setHideK2Excluded(data?.plan_type === 'k1')
            } else {
              setHideK2Excluded(false)
            }
          } catch {
            setHideK2Excluded(false)
          }
        })(),
      ])
      setReferenceLoaded(true)
    } finally {
      setReferenceLoading(false)
    }
  }, [referenceLoaded, referenceLoading, fetchReference, hideK2Excluded])

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
        const data = await res.json()
        throw new Error(data.error || t('toast_delete_failed'))
      }
      toast({ title: t('toast_account_deleted'), description: `${account.account_number} ${account.account_name}` })
      await refreshAll()
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t('toast_delete_failed'),
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
      const { activated } = await res.json()
      if (activated > 0) {
        toast({ title: t('toast_activated_title'), description: t('toast_activated_description', { number: accountNumber }) })
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
  // Toggle class expansion
  // -------------------------------------------

  function toggleClass(cls: number) {
    setExpandedClasses((prev) => {
      const next = new Set(prev)
      if (next.has(cls)) {
        next.delete(cls)
      } else {
        next.add(cls)
      }
      return next
    })
  }

  // -------------------------------------------
  // Filtered & grouped data
  // -------------------------------------------

  const filteredAccounts = useMemo(() => {
    if (!searchQuery) return accounts
    const q = searchQuery.toLowerCase()
    return accounts.filter(
      (a) => a.account_number.includes(q) || a.account_name.toLowerCase().includes(q)
    )
  }, [accounts, searchQuery])

  const groupedAccounts = useMemo(() => {
    const grouped: Record<number, BASAccount[]> = {}
    for (const a of filteredAccounts) {
      const cls = a.account_class
      if (!grouped[cls]) grouped[cls] = []
      grouped[cls].push(a)
    }
    return grouped
  }, [filteredAccounts])

  const filteredReference = useMemo(() => {
    let filtered = referenceAccounts
    if (hideK2Excluded) {
      filtered = filtered.filter((a) => !a.k2_excluded)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(
        (a) => a.account_number.includes(q) || a.account_name.toLowerCase().includes(q)
      )
    }
    return filtered
  }, [referenceAccounts, searchQuery, hideK2Excluded])

  const groupedReference = useMemo(() => {
    const grouped: Record<number, ReferenceAccount[]> = {}
    for (const a of filteredReference) {
      const cls = a.account_class
      if (!grouped[cls]) grouped[cls] = []
      grouped[cls].push(a)
    }
    return grouped
  }, [filteredReference])

  // -------------------------------------------
  // Render
  // -------------------------------------------

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          {t('loading')}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs
          value={view}
          onValueChange={(v) => {
            const next = v as 'my-accounts' | 'bas-catalog'
            setView(next)
            setExpandedClasses(new Set())
            if (next === 'bas-catalog') void ensureReferenceLoaded()
          }}
        >
          <TabsList>
            <TabsTrigger value="my-accounts">
              {t('tab_my_accounts')}
              <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                ({accounts.length})
              </span>
            </TabsTrigger>
            <TabsTrigger value="bas-catalog">
              <BookOpen className="mr-1.5 h-3.5 w-3.5" />
              {t('tab_bas_catalog')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {view === 'my-accounts' && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setPruneDialogOpen(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('prune_button')}
            </Button>
            <Button size="sm" onClick={() => setAddDialogOpen(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('add_own')}
            </Button>
          </div>
        )}

        {view === 'bas-catalog' && (
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={hideK2Excluded ?? false}
              onCheckedChange={setHideK2Excluded}
              className="scale-75"
            />
            <span className="text-muted-foreground">{t('hide_k2_excluded')}</span>
          </label>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('search_placeholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* My Accounts view */}
      {view === 'my-accounts' && (
        <div className="space-y-2">
          {Object.entries(groupedAccounts)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([cls, classAccounts]) => {
              const classNum = Number(cls)
              const isExpanded = expandedClasses.has(classNum) || !!searchQuery
              const activeCount = classAccounts.filter((a) => a.is_active).length

              return (
                <Card key={cls}>
                  <button
                    onClick={() => toggleClass(classNum)}
                    className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      <span className="font-semibold text-left">
                        {t('class_heading', { cls, label: classLabel(classNum) })}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t('active_count_label', { active: activeCount, total: classAccounts.length })}
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <CardContent className="pt-0 pb-4">
                      <table className="w-full text-sm">
                        <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                          <tr className="border-b text-left">
                            <th className="py-2 w-24">{t('col_account')}</th>
                            <th className="py-2">{t('col_name')}</th>
                            <th className="py-2 w-20 text-center">{t('col_sru')}</th>
                            <th className="py-2 w-24 text-center">{t('col_type')}</th>
                            <th className="py-2 w-20 text-right">{t('col_usage')}</th>
                            <th className="py-2 w-16 text-center">{t('col_active')}</th>
                            <th className="py-2 w-20 text-right"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {classAccounts.map((account) => (
                            <tr
                              key={account.id}
                              className={`border-b last:border-0 transition-opacity ${
                                !account.is_active ? 'opacity-50' : ''
                              }`}
                            >
                              <td className="py-2">
                                <AccountNumber number={account.account_number} name={account.account_name} />
                              </td>
                              <td className="py-2">
                                <span className="flex items-center gap-1.5">
                                  {account.account_name}
                                  {account.is_system_account && (
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                      {t('system_badge')}
                                    </span>
                                  )}
                                  {!isStandardBASAccount(account.account_number) && (
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                      {t('own_badge')}
                                    </span>
                                  )}
                                </span>
                              </td>
                              <td className="py-2 text-center">
                                <span className="text-xs font-mono text-muted-foreground">
                                  {account.sru_code || '\u2014'}
                                </span>
                              </td>
                              <td className="py-2 text-center">
                                <span className="text-xs text-muted-foreground">
                                  {typeLabel(account.account_type)}
                                </span>
                              </td>
                              <td className="py-2 text-right">
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {usageCounts.get(account.account_number) ?? '\u2014'}
                                </span>
                              </td>
                              <td className="py-2 text-center">
                                <Switch
                                  checked={account.is_active}
                                  onCheckedChange={() => toggleActive(account)}
                                  disabled={togglingAccount === account.account_number}
                                  className="scale-75"
                                />
                              </td>
                              <td className="py-2 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-10 w-10"
                                    onClick={() => setEditAccount(account)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  {!account.is_system_account && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-10 w-10 text-destructive hover:text-destructive"
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
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  )}
                </Card>
              )
            })}

          {filteredAccounts.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                {searchQuery ? t('no_matches') : t('no_accounts')}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* BAS Catalog view */}
      {view === 'bas-catalog' && (
        <div className="space-y-2">
          {referenceLoading && referenceAccounts.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                {t('loading')}
              </CardContent>
            </Card>
          )}
          {Object.entries(groupedReference)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([cls, classAccounts]) => {
              const classNum = Number(cls)
              const isExpanded = expandedClasses.has(classNum) || !!searchQuery
              const activatedCount = classAccounts.filter((a) => a.is_activated).length

              return (
                <Card key={cls}>
                  <button
                    onClick={() => toggleClass(classNum)}
                    className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      <span className="font-semibold text-left">
                        {t('class_heading', { cls, label: classLabel(classNum) })}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t('active_count_label', { active: activatedCount, total: classAccounts.length })}
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <CardContent className="pt-0 pb-4">
                      <table className="w-full text-sm">
                        <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                          <tr className="border-b text-left">
                            <th className="py-2 w-24">{t('col_account')}</th>
                            <th className="py-2">{t('col_name')}</th>
                            <th className="py-2 w-20 text-center">{t('col_sru')}</th>
                            <th className="py-2 w-24 text-center">{t('col_type')}</th>
                            <th className="py-2 w-28 text-right">{t('col_status')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {classAccounts.map((account) => (
                            <tr
                              key={account.account_number}
                              className={`border-b last:border-0 ${
                                account.is_activated ? 'bg-muted/30' : ''
                              }`}
                            >
                              <td className="py-2">
                                <AccountNumber number={account.account_number} name={account.account_name} />
                              </td>
                              <td className="py-2">
                                <div>
                                  <span>{account.account_name}</span>
                                  {account.description && (
                                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                      {account.description}
                                    </p>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 text-center">
                                <span className="text-xs font-mono text-muted-foreground">
                                  {account.sru_code || '\u2014'}
                                </span>
                              </td>
                              <td className="py-2 text-center">
                                <span className="text-xs text-muted-foreground">
                                  {typeLabel(account.account_type)}
                                </span>
                              </td>
                              <td className="py-2 text-right">
                                {account.is_activated ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-success">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    {t('activated')}
                                  </span>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9 text-xs"
                                    onClick={() => activateBASAccount(account.account_number)}
                                    disabled={activatingAccounts.has(account.account_number)}
                                  >
                                    {activatingAccounts.has(account.account_number) ? (
                                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    ) : (
                                      <Plus className="mr-1 h-3 w-3" />
                                    )}
                                    {t('add')}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </CardContent>
                  )}
                </Card>
              )
            })}

          {!referenceLoading && filteredReference.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                {t('no_matches')}
              </CardContent>
            </Card>
          )}
        </div>
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
