'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { formatCurrency } from '@/lib/utils'
import { formatAmountInput, parseAmountInput, sumOre } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  accrualFrameworkOf,
  accrualHintKey,
  accrualThresholdSek,
  shouldShowK2AccrualHint,
} from './accrual-k2-hint'
import { DEFAULT_PREPAID_EXPENSE_ACCOUNT, isInterimBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { isBasResultAccount } from '@/lib/bookkeeping/result-account-ranges'

export interface ManualAccrualPrefill {
  direction?: 'expense' | 'revenue'
  balance_account?: string
  target_account?: string
  description?: string
  /** The verifikat the line was picked on; its label shows in the dialog. */
  origin_journal_entry_id?: string
  origin_label?: string
}

interface Preview {
  installments: Array<{ period_month: string; amount: number }>
}

/** What remains on the account (GET /api/bookkeeping/accruals/available). */
interface Room {
  deferral: boolean
  available_sek: number | null
}

/**
 * "Ny periodisering": a periodisering set up by hand, from a verifikat's line
 * ("Periodisera" on the verifikat page) or from the ingående balans
 * (Periodiseringar). The amount prefills with what remains on the balance
 * account, which the dialog shows; the user enters the first month not yet
 * released, previews the months and confirms.
 */
export function ManualAccrualDialog({
  open,
  onOpenChange,
  onCreated,
  prefill,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  prefill?: ManualAccrualPrefill
}) {
  const t = useTranslations('accruals')
  const locale: ErrorLocale = useLocale().startsWith('sv') ? 'sv' : 'en'
  const { toast } = useToast()
  const company = useCompanyOptional()?.company ?? null
  const { periods } = useFiscalPeriods()
  const [direction, setDirection] = useState<'expense' | 'revenue'>('expense')
  const [amount, setAmount] = useState('')
  // Once the user types an amount, the room no longer overwrites it.
  const amountTouched = useRef(false)
  const [balanceAccount, setBalanceAccount] = useState(DEFAULT_PREPAID_EXPENSE_ACCOUNT)
  const [targetAccount, setTargetAccount] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [months, setMonths] = useState('12')
  const [description, setDescription] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [room, setRoom] = useState<Room | null>(null)
  const [roomError, setRoomError] = useState<string | null>(null)
  const [roomLoading, setRoomLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const originId = prefill?.origin_journal_entry_id

  useEffect(() => {
    if (!open) return
    setDirection(prefill?.direction ?? 'expense')
    setAmount('')
    amountTouched.current = false
    setBalanceAccount(prefill?.balance_account ?? DEFAULT_PREPAID_EXPENSE_ACCOUNT)
    setTargetAccount(prefill?.target_account ?? '')
    setPeriodStart('')
    setMonths('12')
    setDescription(prefill?.description ?? '')
    setPreview(null)
  }, [open, prefill])

  // What remains on the account, read again when the account, the direction
  // or the first month (which picks the ingående balans) changes. Until the
  // user types an amount, the amount follows it.
  useEffect(() => {
    if (!open || !isInterimBalanceAccount(balanceAccount)) {
      setRoom(null)
      setRoomError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setRoomLoading(true)
      try {
        const params = new URLSearchParams({ direction, balance_account: balanceAccount })
        if (originId) params.set('origin_journal_entry_id', originId)
        if (periodStart) params.set('period_start', periodStart)
        const res = await fetch(`/api/bookkeeping/accruals/available?${params.toString()}`)
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setRoom(null)
          setRoomError(getErrorMessage(json, { locale, context: 'journal_entry' }))
          return
        }
        const next = json.data as Room
        setRoom(next)
        setRoomError(null)
        if (!amountTouched.current && next.deferral && next.available_sek !== null && next.available_sek > 0) {
          setAmount(formatAmountInput(next.available_sek, locale === 'sv' ? ',' : '.'))
        }
      } catch (error) {
        if (!cancelled) {
          setRoom(null)
          setRoomError(getErrorMessage(error, { locale, context: 'journal_entry' }))
        }
      } finally {
        if (!cancelled) setRoomLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, direction, balanceAccount, originId, periodStart, locale])

  const amountNumber = parseAmountInput(amount) ?? 0
  const monthsNumber = Number(months)

  function body(dryRun: boolean) {
    return {
      direction,
      amount_sek: amountNumber,
      balance_account: balanceAccount,
      target_account: targetAccount,
      period_start: periodStart,
      months: monthsNumber,
      description: description.trim(),
      ...(originId ? { origin_journal_entry_id: originId } : {}),
      dry_run: dryRun,
    }
  }

  async function previewPlan() {
    setBusy(true)
    try {
      const res = await fetch('/api/bookkeeping/accruals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(true)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { locale, context: 'journal_entry' }))
      setPreview(json.data as Preview)
    } catch (error) {
      toast({ title: t('manual_failed'), description: getErrorMessage(error, { locale, context: 'journal_entry' }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function confirm() {
    try {
      const res = await fetch('/api/bookkeeping/accruals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(false)),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(getErrorMessage(json, { locale, context: 'journal_entry' }))
      toast({ title: t('manual_created') })
      onCreated()
    } catch (error) {
      toast({ title: t('manual_failed'), description: getErrorMessage(error, { locale, context: 'journal_entry' }), variant: 'destructive' })
    }
  }

  const valid = amountNumber > 0 && isInterimBalanceAccount(balanceAccount) && isBasResultAccount(targetAccount)
    && !!periodStart && Number.isInteger(monthsNumber) && monthsNumber >= 1 && monthsNumber <= 120
    && description.trim().length > 0

  // The materiality limit of the year the plan starts in (K1 5 000 kr, K2
  // 5 000 or 7 000 kr by the year, K3 none): advice, never a block.
  const fiscalYear = periodStart ? periods.find((p) => periodStart >= p.period_start && periodStart <= p.period_end) : undefined
  const thresholdSek = accrualThresholdSek({
    entityType: company?.entity_type ?? null,
    framework: accrualFrameworkOf(company),
    fiscalYearStart: fiscalYear?.period_start ?? null,
    fiscalYearEnd: fiscalYear?.period_end ?? null,
  })
  const showMaterialityHint = thresholdSek !== null && shouldShowK2AccrualHint({ amount: amountNumber, thresholdSek })

  const edit = (apply: () => void) => {
    apply()
    setPreview(null)
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('manual_title')}
      description={t('manual_description')}
      confirmLabel={t('manual_confirm')}
      confirmDisabled={!preview || busy}
      onConfirm={confirm}
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {prefill?.origin_label ? t('manual_source_origin', { label: prefill.origin_label }) : t('manual_source_opening_balance')}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('manual_direction')}</Label>
            <Select value={direction} onValueChange={(value) => edit(() => setDirection(value as 'expense' | 'revenue'))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">{t('manual_expense')}</SelectItem>
                <SelectItem value="revenue">{t('manual_revenue')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-accrual-balance">{t('manual_balance_account')}</Label>
            <Input id="manual-accrual-balance" inputMode="numeric" maxLength={4} value={balanceAccount} onChange={(event) => edit(() => setBalanceAccount(event.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-accrual-amount">{t('manual_amount')}</Label>
            <Input
              id="manual-accrual-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => edit(() => { setAmount(event.target.value); amountTouched.current = true })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-accrual-target">{t('manual_target_account')}</Label>
            <Input id="manual-accrual-target" inputMode="numeric" maxLength={4} value={targetAccount} onChange={(event) => edit(() => setTargetAccount(event.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-accrual-start">{t('manual_period_start')}</Label>
            <Input id="manual-accrual-start" type="date" value={periodStart} onChange={(event) => edit(() => setPeriodStart(event.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manual-accrual-months">{t('manual_months')}</Label>
            <Input id="manual-accrual-months" type="number" min="1" max="120" step="1" value={months} onChange={(event) => edit(() => setMonths(event.target.value))} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="manual-accrual-description">{t('manual_description_label')}</Label>
          <Input id="manual-accrual-description" value={description} onChange={(event) => edit(() => setDescription(event.target.value))} />
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          {roomLoading && !room ? (
            <p>{t('manual_room_loading')}</p>
          ) : roomError ? (
            <p className="text-destructive">{roomError}</p>
          ) : room && room.deferral && room.available_sek !== null ? (
            <>
              <p className="font-medium text-foreground tabular-nums">
                {t('manual_room', { account: balanceAccount, amount: formatCurrency(room.available_sek) })}
              </p>
              <p>{t('manual_room_hint')}</p>
            </>
          ) : room && !room.deferral ? (
            <p>{t('manual_room_accrued')}</p>
          ) : null}
          {showMaterialityHint && (
            <p>
              {t(accrualHintKey(company?.entity_type ?? null), {
                amount: new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'sv-SE').format(thresholdSek ?? 0),
              })}
            </p>
          )}
        </div>
        {preview ? (
          <div className="space-y-2">
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {preview.installments.map((installment) => (
                    <tr key={installment.period_month} className="border-t-hairline">
                      <td className="py-1.5 tabular-nums">{installment.period_month.slice(0, 7)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatCurrency(installment.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('manual_preview_total', {
                amount: formatCurrency(sumOre(preview.installments.map((i) => i.amount))),
                months: preview.installments.length,
              })}
            </p>
          </div>
        ) : (
          <Button variant="outline" disabled={!valid || busy} loading={busy} onClick={previewPlan}>
            {t('manual_preview')}
          </Button>
        )}
      </div>
    </ConfirmDialog>
  )
}
