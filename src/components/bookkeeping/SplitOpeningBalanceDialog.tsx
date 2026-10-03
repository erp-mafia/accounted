'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type {
  OpeningBalanceSplitPreview,
  OpeningBalanceSplitResult,
  SplitAccountPlan,
} from '@/lib/import/opening-balance/split-per-project'

interface Props {
  /** The year whose IB verifikat is split. */
  fiscalPeriodId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onApplied: () => void
}

type Bag = Record<string, string>

function bagKey(bag: Bag): string {
  return Object.keys(bag)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => `${key}=${bag[key]}`)
    .join('|')
}

/** Net per bag, so current and proposed lines line up row by row. */
function netsByBag(lines: SplitAccountPlan['current_lines'] | SplitAccountPlan['proposed_lines']) {
  const nets = new Map<string, { bag: Bag; amount: number }>()
  for (const line of lines) {
    const key = bagKey(line.dimensions)
    const entry = nets.get(key) ?? { bag: line.dimensions, amount: 0 }
    entry.amount = roundOre(entry.amount + line.amount)
    nets.set(key, entry)
  }
  return nets
}

/**
 * "Dela upp IB per projekt" (#3313): previews how the year's IB verifikat
 * would be split per project from the previous year's tagged closing
 * balances, and applies it as an inline rättelse of the same verifikat.
 * The dialog is the confirmation: it says what is corrected and where the
 * struck lines end up before anything is written. The server is the
 * authority on whether the year allows it (blocked carries its message).
 */
export default function SplitOpeningBalanceDialog({ fiscalPeriodId, open, onOpenChange, onApplied }: Props) {
  const t = useTranslations('opening_balance_split')
  const locale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const [preview, setPreview] = useState<OpeningBalanceSplitPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const load = useCallback(async () => {
    setPreview(null)
    setLoadError(null)
    try {
      const res = await fetch(
        `/api/import/opening-balance/split-per-project?fiscal_period_id=${encodeURIComponent(fiscalPeriodId)}`,
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw body
      setPreview(body.data as OpeningBalanceSplitPreview)
    } catch (err) {
      setLoadError(getErrorMessage(err, { locale }) || t('load_error'))
    }
  }, [fiscalPeriodId, t, locale])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function apply() {
    if (!preview) return
    setApplying(true)
    try {
      const res = await fetch('/api/import/opening-balance/split-per-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiscal_period_id: fiscalPeriodId, expected_fingerprint: preview.fingerprint }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw body
      const result = body.data as OpeningBalanceSplitResult
      toast({ title: result.applied ? t('applied') : t('applied_noop') })
      onApplied()
    } catch (err) {
      toast({ title: t('apply_error'), description: getErrorMessage(err, { locale }), variant: 'destructive' })
      // The split may have changed under the user (or a part was applied):
      // show the server's current view instead of the stale one.
      void load()
    } finally {
      setApplying(false)
    }
  }

  const source = preview?.source_fiscal_period_name ?? ''
  const valueName = (dimNo: string, code: string) => {
    const value = preview?.dimension_values.find((v) => v.sie_dim_no === dimNo && v.code === code)
    if (!value) return code
    const name = value.name && value.name !== code ? `${code} ${value.name}` : code
    return value.is_active ? name : `${name} (${t('archived')})`
  }
  const bagLabel = (bag: Bag) => {
    const keys = Object.keys(bag).sort((a, b) => Number(a) - Number(b))
    return keys.length === 0 ? t('untagged') : keys.map((key) => valueName(key, bag[key])).join(' · ')
  }

  const shown = preview?.accounts.filter((account) => account.status !== 'unchanged') ?? []
  // Without an IB or a previous year there is nothing to compare; otherwise
  // a blocked year only matters when something would change (a split already
  // in place is a no-op whatever the year's state).
  const hardBlocked = !!preview && (preview.journal_entry_id === null || preview.source_fiscal_period_id === null)
  const blockedMessage =
    preview?.blocked && (hardBlocked || preview.accounts_to_change > 0)
      ? locale === 'en'
        ? preview.blocked.message_en
        : preview.blocked.message_sv
      : null
  const attention =
    blockedMessage ??
    (preview && preview.accounts_to_change > 0 && preview.source_period_closed === false
      ? t('source_open', { source })
      : null)

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!applying) onOpenChange(value) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {source ? t('description', { source }) : t('description_generic')}
          </DialogDescription>
        </DialogHeader>

        {!preview && !loadError && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        )}

        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}

        {preview && (
          <div className="space-y-4 animate-fade-in">
            {attention && <p className="attn text-[12.5px]">{attention}</p>}

            {shown.length === 0 && !hardBlocked && (
              <p className="text-sm text-muted-foreground">
                {preview.accounts_unchanged > 0 ? t('nothing_to_do') : t('no_project_balances', { source })}
              </p>
            )}

            {shown.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col_project')}</TableHead>
                    <TableHead className="text-right">{t('col_current')}</TableHead>
                    <TableHead className="text-right">{t('col_proposed')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((account) => {
                    const current = netsByBag(account.current_lines)
                    const proposed = netsByBag(account.proposed_lines)
                    const keys = [...new Set([...current.keys(), ...proposed.keys()])].sort((a, b) =>
                      a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'sv'),
                    )
                    return (
                      <Fragment key={account.account_number}>
                        <TableRow className="bg-muted/30">
                          <TableCell colSpan={3} className="py-2 text-[12.5px] font-semibold text-muted-foreground">
                            <span className="tabular-nums">{account.account_number}</span>
                            {account.account_name ? ` ${account.account_name}` : ''}
                            <span className="ml-2 font-normal tabular-nums">{formatCurrency(account.total)}</span>
                            {account.skip_reason && (
                              <span className="ml-2 font-normal">
                                {account.skip_reason === 'foreign_currency'
                                  ? t('skipped_foreign_currency')
                                  : t('skipped_line_document')}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                        {keys.map((key) => {
                          const bag = (proposed.get(key) ?? current.get(key))!.bag
                          const before = current.get(key)?.amount ?? 0
                          const after = proposed.get(key)?.amount ?? 0
                          return (
                            <TableRow key={key || 'untagged'}>
                              <TableCell className="py-2">{bagLabel(bag)}</TableCell>
                              <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                                {before !== 0 ? formatCurrency(before) : '-'}
                              </TableCell>
                              <TableCell className="py-2 text-right tabular-nums">
                                {account.status === 'skipped' ? '-' : after !== 0 ? formatCurrency(after) : '-'}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}

            {shown.length > 0 && preview.accounts_unchanged > 0 && (
              <p className="text-[12.5px] text-muted-foreground">
                {t('unchanged_count', { count: preview.accounts_unchanged })}
              </p>
            )}

            {preview.can_apply && (
              <p className="text-[12.5px] text-muted-foreground">
                {preview.voucher ? t('outcome', { voucher: preview.voucher }) : t('outcome_no_voucher')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={applying} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={!preview?.can_apply} loading={applying} onClick={apply}>
            {t('apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
