'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { EllipsisHorizontalIcon, PlusIcon } from '@/components/icons'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { Button } from '@/components/ui/button'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TOOLBAR_FIELD_CLASS } from '@/components/ui/toolbar-search'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import DimensionCombobox from '@/components/dimensions/DimensionCombobox'
import { useAccounts, useDimensions } from '@/lib/reference-data/hooks'
import { useReportData } from '@/lib/hooks/use-report-data'
import { cn } from '@/lib/utils'
import { cellKey, changedCells, toResultSign, withEdits } from '@/lib/budgets/grid'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { BudgetGrid } from './BudgetGrid'
import { CopyActualsDialog, NewBudgetDialog, SpreadDialog } from './BudgetDialogs'
import { BudgetImportDialog } from './BudgetImportDialog'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { budgetCall, type BudgetGridData, type BudgetSaveCounts, type BudgetSummary } from './budget-api'

/** Which lines the grid shows: the untagged ones, one dimension value, or all summed. */
type View = { mode: 'untagged' } | { mode: 'sum' } | { mode: 'tag'; dimNo: string; code: string | null }

const NO_TAG: Record<string, string> = {}

/**
 * /budget (accounted#134): the year's budget as an account x month grid,
 * typed into directly, with the year's named versions, a dimension view
 * (one home or cost centre at a time, or every one summed), and the actions
 * that fill it: spread a yearly amount, copy last year's actuals, import a
 * file. Following it up is the resultatrapport's Budget column.
 */
export function BudgetPage() {
  const t = useTranslations('budget')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { confirm, dialogProps } = useDestructiveConfirm()
  // The fiscal year is app-wide context (the sidebar); a budget belongs to
  // one year, a coming one included.
  const { periodId } = useFiscalScope({ allowAll: false })
  // The budget the user picked; budgetId below is the one shown.
  const [pickedBudgetId, setPickedBudgetId] = useState<string | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [edits, setEdits] = useState<Map<string, number>>(new Map())
  const [added, setAdded] = useState<{ account_number: string; account_name: string | null }[]>([])
  // Another year starts from its own budgets, with nothing half-edited
  // carried over (adjusting state during render, not in an effect).
  const [shownPeriodId, setShownPeriodId] = useState(periodId)
  if (periodId !== shownPeriodId) {
    setShownPeriodId(periodId)
    setPickedBudgetId(null)
    setView(null)
    setEdits(new Map())
    setAdded([])
  }
  const [newAccount, setNewAccount] = useState('')
  const [saving, setSaving] = useState(false)
  const { canWrite, lockedTitle } = useViewerLock()
  const [dialog, setDialog] = useState<'new' | 'spread' | 'copy' | 'import' | null>(null)

  const { accounts } = useAccounts()
  // A budget covers the resultatkonton (classes 3-8): the chart says which.
  const resultAccounts = useMemo(() => accounts.filter((a) => a.account_class >= 3 && a.account_class <= 8), [accounts])
  const { dimensions } = useDimensions()

  const budgets = useReportData<{ budgets: BudgetSummary[] }>(
    periodId ? `/api/budgets?fiscal_period_id=${periodId}` : null,
    t('load_failed'),
  )
  const list = useMemo(() => budgets.data?.budgets ?? [], [budgets.data])

  // The picked budget while the year has it, else the year's default, else
  // its first: a deleted or another year's budget gives way by itself.
  const budgetId =
    pickedBudgetId && list.some((b) => b.budget_id === pickedBudgetId)
      ? pickedBudgetId
      : (list.find((b) => b.is_default)?.budget_id ?? list[0]?.budget_id ?? null)

  const gridQuery = useMemo(() => {
    const q = new URLSearchParams()
    if (view?.mode === 'sum') q.set('mode', 'sum')
    else if (view?.mode === 'untagged') q.set('mode', 'untagged')
    else if (view?.mode === 'tag' && view.code) {
      q.set('dim_no', view.dimNo)
      q.set('dim_code', view.code)
    }
    return q.toString()
  }, [view])
  const pickingValue = view?.mode === 'tag' && !view.code
  const grid = useReportData<BudgetGridData>(
    budgetId && !pickingValue ? `/api/budgets/${budgetId}/grid?${gridQuery}` : null,
    t('load_failed'),
  )
  const data = grid.data

  // Until the user picks a view, the server's is shown (summed when the
  // budget has tags, else the untagged lines).
  const shownView: View | null = view ?? (data && data.mode !== 'tag' ? { mode: data.mode } : null)

  const shownRows = useMemo(() => (data ? toResultSign(data.rows) : []), [data])
  const rows = useMemo(
    () => (data ? withEdits(shownRows, edits, added, data.months.length) : []),
    [data, shownRows, edits, added],
  )
  const tag = data?.dimensions ?? NO_TAG
  const changes = useMemo(() => (data ? changedCells(shownRows, edits, data.months, tag) : []), [data, shownRows, edits, tag])
  const dirty = changes.length > 0 || added.length > 0
  const budget = list.find((b) => b.budget_id === budgetId) ?? null

  const resetEdits = () => {
    setEdits(new Map())
    setAdded([])
  }

  const save = async () => {
    if (!budgetId || changes.length === 0) {
      resetEdits()
      return
    }
    setSaving(true)
    const res = await budgetCall<BudgetSaveCounts>(`/api/budgets/${budgetId}/lines`, { method: 'POST', json: { lines: changes } }, locale)
    setSaving(false)
    if (!res.ok) return toast({ title: t('save_failed'), description: res.message, variant: 'destructive' })
    toast({ title: t('saved', { cells: changes.length }) })
    resetEdits()
    grid.refetch()
  }

  const setDefault = async () => {
    if (!budgetId) return
    const res = await budgetCall(`/api/budgets/${budgetId}`, { method: 'PATCH', json: { is_default: true } }, locale)
    if (!res.ok) return toast({ title: t('action_failed'), description: res.message, variant: 'destructive' })
    toast({ title: t('default_set') })
    budgets.refetch()
  }

  const remove = async () => {
    if (!budget) return
    let deleted = false
    await confirm(
      { title: t('delete_title', { name: budget.name }), description: t('delete_description'), confirmLabel: t('delete_confirm') },
      async () => {
        const res = await budgetCall(`/api/budgets/${budget.budget_id}`, { method: 'DELETE' }, locale)
        if (!res.ok) toast({ title: t('action_failed'), description: res.message, variant: 'destructive' })
        deleted = res.ok
      },
    )
    if (!deleted) return
    resetEdits()
    setPickedBudgetId(null)
    budgets.refetch()
  }

  const afterWrite = () => {
    resetEdits()
    grid.refetch()
  }

  const viewValue = shownView?.mode === 'tag' ? `dim:${shownView.dimNo}` : (shownView?.mode ?? 'untagged')
  const showDimensionPicker = dimensions.length > 0 || data?.has_tagged_lines === true

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        help={
          <HelpPopover>
            <div className="space-y-2 text-[13px]">
              <p>{t('help_grid')}</p>
              <p>{t('help_sign')}</p>
              <p>{t('help_dimensions')}</p>
            </div>
          </HelpPopover>
        }
        action={
          <div className="flex items-center gap-2">
            <Button size="toolbar" onClick={() => setDialog('new')} disabled={!canWrite || !periodId} title={lockedTitle}>
              <PlusIcon className="h-4 w-4" />
              {t('new')}
            </Button>
          </div>
        }
      />

      {periodId && !budgets.loading && budgets.error && list.length === 0 ? (
        <LoadError title={budgets.error} onRetry={budgets.refetch} />
      ) : periodId && !budgets.loading && list.length === 0 ? (
        <EmptyState
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new') : undefined}
          onAction={canWrite ? () => setDialog('new') : undefined}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={budgetId ?? ''}
              onValueChange={(id) => {
                setPickedBudgetId(id)
                setView(null)
                resetEdits()
              }}
              disabled={dirty || list.length === 0}
            >
              <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-[220px]')} aria-label={t('budget_label')}>
                <SelectValue placeholder={t('budget_label')} />
              </SelectTrigger>
              <SelectContent>
                {list.map((b) => (
                  <SelectItem key={b.budget_id} value={b.budget_id}>
                    <span data-ph-mask="">{b.name}</span>
                    {b.is_default ? ` · ${t('default_marker')}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {showDimensionPicker && (
              <Select
                value={viewValue}
                onValueChange={(v) => {
                  resetEdits()
                  if (v === 'sum' || v === 'untagged') setView({ mode: v })
                  else setView({ mode: 'tag', dimNo: v.slice(4), code: null })
                }}
                disabled={dirty}
              >
                <SelectTrigger className={cn(TOOLBAR_FIELD_CLASS, 'w-[200px]')} aria-label={t('view_label')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="untagged">{t('view_untagged')}</SelectItem>
                  <SelectItem value="sum">{t('view_sum')}</SelectItem>
                  {dimensions.map((d) => (
                    <SelectItem key={d.sie_dim_no} value={`dim:${d.sie_dim_no}`}>
                      {t('view_per', { dimension: d.name })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {view?.mode === 'tag' && (
              <div className="w-[200px]">
                <DimensionCombobox
                  sieDimNo={view.dimNo}
                  value={view.code}
                  onChange={(code) => {
                    resetEdits()
                    setView({ mode: 'tag', dimNo: view.dimNo, code })
                  }}
                  className={TOOLBAR_FIELD_CLASS}
                  allowCreate={false}
                  disabled={dirty}
                />
              </div>
            )}

            <div className="ml-auto flex items-center gap-2">
              {dirty && (
                <Button variant="ghost" onClick={resetEdits} disabled={saving}>
                  {t('discard')}
                </Button>
              )}
              <Button onClick={save} disabled={!dirty} loading={saving}>
                {t('save')}
              </Button>
              <Button variant="outline" onClick={() => setDialog('import')} disabled={!canWrite || !budget || budget.archived || dirty} title={lockedTitle}>
                {t('import')}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" aria-label={t('more_actions')} disabled={!budget}>
                    <EllipsisHorizontalIcon className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog('spread')} disabled={!canWrite || !data?.editable || dirty}>
                    {t('spread')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog('copy')} disabled={!canWrite || !data?.editable || dirty}>
                    {t('copy')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={setDefault} disabled={!canWrite || !budget || budget.is_default || budget.archived}>
                    {t('set_default')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={remove} disabled={!canWrite} className="text-destructive">
                    {t('delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {data && !data.editable && data.mode === 'sum' && data.has_tagged_lines && <AttnLine>{t('sum_read_only')}</AttnLine>}
          {budget?.archived && <AttnLine>{t('archived')}</AttnLine>}

          {pickingValue ? (
            <p className="text-[13px] text-muted-foreground">{t('pick_value')}</p>
          ) : grid.loading || !data ? (
            grid.error ? (
              <LoadError title={grid.error} onRetry={grid.refetch} />
            ) : (
              <LateReveal>
                <Skeleton className="h-64 w-full" />
              </LateReveal>
            )
          ) : (
            <>
              {rows.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">{t('grid_empty')}</p>
              ) : (
                <BudgetGrid
                  months={data.months}
                  rows={rows}
                  editable={data.editable && canWrite}
                  onCellChange={(account, i, amount) =>
                    setEdits((prev) => new Map(prev).set(cellKey(account, i), amount))
                  }
                />
              )}
              {data.editable && canWrite && (
                <div className="flex items-center gap-2 max-w-sm">
                  <AccountCombobox
                    value={newAccount}
                    accounts={resultAccounts}
                    onChange={setNewAccount}
                    onCommit={(account) => {
                      const found = resultAccounts.find((a) => a.account_number === account)
                      if (found && !rows.some((r) => r.account_number === account)) {
                        setAdded((prev) => [...prev, { account_number: account, account_name: found.account_name }])
                      }
                      setNewAccount('')
                    }}
                    placeholder={t('add_account')}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Each dialog mounts when opened, so its form starts empty every time. */}
      {periodId && dialog === 'new' && (
        <NewBudgetDialog
          open={dialog === 'new'}
          onOpenChange={(open) => setDialog(open ? 'new' : null)}
          fiscalPeriodId={periodId}
          onCreated={(created) => {
            setPickedBudgetId(created.budget_id)
            setView(null)
            resetEdits()
            budgets.refetch()
          }}
        />
      )}
      {budget && dialog === 'spread' && (
        <SpreadDialog
          open={dialog === 'spread'}
          onOpenChange={(open) => setDialog(open ? 'spread' : null)}
          budgetId={budget.budget_id}
          dimensions={tag}
          accounts={resultAccounts}
          onDone={afterWrite}
        />
      )}
      {budget && dialog === 'copy' && (
        <CopyActualsDialog
          open={dialog === 'copy'}
          onOpenChange={(open) => setDialog(open ? 'copy' : null)}
          budgetId={budget.budget_id}
          dimensions={tag}
          onDone={afterWrite}
        />
      )}
      {budget && dialog === 'import' && (
        <BudgetImportDialog
          open={dialog === 'import'}
          onOpenChange={(open) => setDialog(open ? 'import' : null)}
          budgetId={budget.budget_id}
          budgetName={budget.name}
          onDone={afterWrite}
        />
      )}
      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
