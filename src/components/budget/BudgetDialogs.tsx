'use client'

import { useEffect, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { useToast } from '@/components/ui/use-toast'
import { parseAmountInput } from '@/lib/money'
import { flipSign } from '@/lib/budgets/grid'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import type { BASAccount } from '@/types'
import { budgetCall, type BudgetSaveCounts, type BudgetSummary } from './budget-api'

interface BaseProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The tag a write lands on: the grid's, left out when untagged. */
const tagBody = (dimensions: Record<string, string>) => (Object.keys(dimensions).length > 0 ? { dimensions } : {})

// ── Ny budget ──────────────────────────────────────────────────────────

export function NewBudgetDialog({
  open,
  onOpenChange,
  fiscalPeriodId,
  onCreated,
}: BaseProps & { fiscalPeriodId: string; onCreated: (budget: BudgetSummary) => void }) {
  const t = useTranslations('budget')
  const locale = useLocale() as ErrorLocale
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const res = await budgetCall<{ budget: BudgetSummary }>(
      '/api/budgets',
      { method: 'POST', json: { fiscal_period_id: fiscalPeriodId, name: name.trim() } },
      locale,
    )
    setBusy(false)
    if (!res.ok) return setError(res.message)
    onCreated(res.data.budget)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('new_title')}</DialogTitle>
          <DialogDescription>{t('new_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="budget-name">{t('name_label')}</Label>
          <Input id="budget-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={t('name_placeholder')} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={name.trim() === ''} loading={busy}>
            {t('new_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Fördela ett årsbelopp ──────────────────────────────────────────────

export function SpreadDialog({
  open,
  onOpenChange,
  budgetId,
  dimensions,
  accounts,
  onDone,
}: BaseProps & {
  budgetId: string
  dimensions: Record<string, string>
  accounts: BASAccount[]
  onDone: () => void
}) {
  const t = useTranslations('budget')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [account, setAccount] = useState('')
  const [amountText, setAmountText] = useState('')
  const [method, setMethod] = useState<'even' | 'last_year'>('even')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amount = parseAmountInput(amountText)
  // The picker offers the budget's accounts only (the page's resultatkonton).
  const valid = accounts.some((a) => a.account_number === account) && amount !== null

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    const res = await budgetCall<BudgetSaveCounts & { fell_back_to_even: boolean }>(
      `/api/budgets/${budgetId}/spread`,
      // The page's sign is the resultatrapport's; the API keeps the SIE sign.
      { method: 'POST', json: { account_number: account, amount: flipSign(amount!), method, ...tagBody(dimensions) } },
      locale,
    )
    setBusy(false)
    if (!res.ok) return setError(res.message)
    toast({
      title: t('spread_done'),
      description: res.data.fell_back_to_even ? t('spread_fell_back') : undefined,
    })
    onDone()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('spread_title')}</DialogTitle>
          <DialogDescription>{t('spread_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="spread-account">{t('account_label')}</Label>
            <AccountCombobox id="spread-account" value={account} accounts={accounts} onChange={setAccount} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="spread-amount">{t('spread_amount_label')}</Label>
            <Input
              id="spread-amount"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder="1 200 000"
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">{t('sign_hint')}</p>
          </div>
          <div className="space-y-2">
            <Label>{t('spread_method_label')}</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as 'even' | 'last_year')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="even">{t('spread_method_even')}</SelectItem>
                <SelectItem value="last_year">{t('spread_method_last_year')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!valid} loading={busy}>
            {t('spread_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Kopiera förra årets utfall ─────────────────────────────────────────

export function CopyActualsDialog({
  open,
  onOpenChange,
  budgetId,
  dimensions,
  onDone,
}: BaseProps & { budgetId: string; dimensions: Record<string, string>; onDone: () => void }) {
  const t = useTranslations('budget')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [percentText, setPercentText] = useState('0')
  const [preview, setPreview] = useState<(BudgetSaveCounts & { accounts: string[] }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Confirm up front: the dry run says how many accounts the copy writes.
  useEffect(() => {
    if (!open) return
    let live = true
    void budgetCall<BudgetSaveCounts & { accounts: string[] }>(
      `/api/budgets/${budgetId}/copy-actuals?dry_run=true`,
      { method: 'POST', json: { ...tagBody(dimensions) } },
      locale,
    ).then((res) => {
      if (!live) return
      if (res.ok) setPreview(res.data)
      else setError(res.message)
    })
    return () => {
      live = false
    }
  }, [open, budgetId, dimensions, locale])

  const percent = parseAmountInput(percentText)
  const valid = percent !== null && percent >= -100 && percent <= 1000 && preview !== null && preview.accounts.length > 0

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    const res = await budgetCall<BudgetSaveCounts>(
      `/api/budgets/${budgetId}/copy-actuals`,
      { method: 'POST', json: { percent_change: percent, ...tagBody(dimensions) } },
      locale,
    )
    setBusy(false)
    if (!res.ok) return setError(res.message)
    toast({ title: t('copy_done') })
    onDone()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('copy_title')}</DialogTitle>
          <DialogDescription>
            {preview
              ? preview.accounts.length > 0
                ? t('copy_preview', { accounts: preview.accounts.length })
                : t('copy_nothing')
              : t('copy_loading')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="copy-percent">{t('copy_percent_label')}</Label>
          <Input
            id="copy-percent"
            inputMode="decimal"
            value={percentText}
            onChange={(e) => setPercentText(e.target.value)}
            className="w-32 tabular-nums"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!valid} loading={busy}>
            {t('copy_submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
