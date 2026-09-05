'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useAccounts } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import { ACCOUNT_NUMBER_RE, ISO_DATE_RE } from '@/lib/invariants'
import type { InvoiceExtractionResult } from '@/types'

/**
 * Who paid for the underlag out of their own pocket. The owner's liability
 * account follows the entity type (2893 skuld till ägare in an AB, 2018 egen
 * insättning in an enskild firma); an employee is always 2820.
 */
export type ExpensePayer = 'owner' | 'employee'

interface InboxItemLike {
  id: string
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
}

interface EmployeeOption {
  id: string
  first_name: string
  last_name: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: InboxItemLike
  payer: ExpensePayer
  /** Re-read the item after the claim posted its verifikat. */
  onSuccess: () => void | Promise<void>
}

const OWNER_FALLBACK_NAME = 'Ägare'

function todayIso(): string {
  // Local calendar date: toISOString() is UTC and would date a receipt booked
  // after midnight CEST to the previous day (wrong period, wrong FX rate).
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function parseAmount(raw: string): number {
  const n = parseFloat(raw.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/**
 * RegisterExpenseDialog: the confirm step behind "Vem betalade? Jag, privat /
 * En anställd" in the Underlag pane. One screen, prefilled from the
 * extraction: who, cost account, amount and VAT, then the outcome spelled out
 * before anything posts (design convention 10). Posts through
 * POST /api/expense-claims, which books cost + moms against the person's
 * liability account and stamps the inbox item as booked.
 */
export default function RegisterExpenseDialog({ open, onOpenChange, item, payer, onSuccess }: Props) {
  const t = useTranslations('inbox_workspace')
  const { toast } = useToast()
  const { accounts } = useAccounts()
  const entityType = useCompanyOptional()?.company?.entity_type ?? null
  const ownerLiability = entityType === 'enskild_firma' ? '2018' : '2893'
  const liabilityAccount = payer === 'owner' ? ownerLiability : '2820'

  const data = item.extracted_data
  const [description, setDescription] = useState('')
  const [expenseDate, setExpenseDate] = useState(todayIso())
  const [amountInput, setAmountInput] = useState('')
  const [vatInput, setVatInput] = useState('')
  const [expenseAccount, setExpenseAccount] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [employeesLoaded, setEmployeesLoaded] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const currency = (data?.invoice?.currency ?? 'SEK').toUpperCase()

  // Reset per open so a previous underlag's numbers never carry over.
  useEffect(() => {
    if (!open) return
    setDescription(data?.supplier?.name?.trim() || '')
    setExpenseDate(data?.invoice?.invoiceDate || todayIso())
    const total = data?.totals?.total
    const vat = data?.totals?.vatAmount
    setAmountInput(total != null && total > 0 ? String(roundOre(total)).replace('.', ',') : '')
    setVatInput(vat != null && vat > 0 ? String(roundOre(vat)).replace('.', ',') : '0')
    setExpenseAccount('')
    setEmployeeId('')
  }, [open, item.id, data])

  useEffect(() => {
    if (!open || payer !== 'employee' || employeesLoaded) return
    fetch('/api/salary/employees')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setEmployees((json?.data ?? []) as EmployeeOption[]))
      .catch(() => setEmployees([]))
      .finally(() => setEmployeesLoaded(true))
  }, [open, payer, employeesLoaded])

  const amount = parseAmount(amountInput)
  const vatAmount = parseAmount(vatInput)
  const net = roundOre(amount - vatAmount)
  const employee = employees.find((e) => e.id === employeeId) ?? null
  const claimantName =
    payer === 'owner'
      ? ownerName.trim() || OWNER_FALLBACK_NAME
      : employee
        ? `${employee.first_name} ${employee.last_name}`.trim()
        : ''

  const canSubmit =
    !isSubmitting &&
    description.trim().length > 0 &&
    ISO_DATE_RE.test(expenseDate) &&
    amount > 0 &&
    vatAmount >= 0 &&
    vatAmount < amount &&
    ACCOUNT_NUMBER_RE.test(expenseAccount) &&
    /^[4-8]/.test(expenseAccount) &&
    (payer === 'owner' || !!employeeId)

  const accountName = useMemo(
    () => accounts.find((a) => a.account_number === expenseAccount)?.account_name ?? '',
    [accounts, expenseAccount],
  )

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        description: description.trim(),
        expense_date: expenseDate,
        amount,
        vat_amount: vatAmount,
        currency,
        expense_account: expenseAccount,
        inbox_item_id: item.id,
        document_id: item.document_id ?? undefined,
      }
      if (payer === 'owner') body.claimant_name = claimantName
      else body.employee_id = employeeId
      const res = await fetch('/api/expense-claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as {
        data?: { journal_entry_id?: string | null }
        error?: unknown
      }
      if (!res.ok) {
        toast({
          title: t('expense_failed_title'),
          description: getErrorMessage(json, { context: 'journal_entry', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: t('expense_booked_title'),
        description: t('expense_booked_description', { name: claimantName }),
      })
      await onSuccess()
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    canSubmit,
    description,
    expenseDate,
    amount,
    vatAmount,
    currency,
    expenseAccount,
    item.id,
    item.document_id,
    payer,
    claimantName,
    employeeId,
    toast,
    t,
    onSuccess,
    onOpenChange,
  ])

  return (
    <Dialog open={open} onOpenChange={(next) => !isSubmitting && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('expense_dialog_title')}</DialogTitle>
          <DialogDescription>
            {payer === 'owner'
              ? t('expense_dialog_help_owner', { account: liabilityAccount })
              : t('expense_dialog_help_employee')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {payer === 'owner' ? (
            <div className="space-y-1.5">
              <Label htmlFor="re-owner">{t('expense_owner_name')}</Label>
              <Input
                id="re-owner"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder={OWNER_FALLBACK_NAME}
                disabled={isSubmitting}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="re-employee">{t('expense_employee')}</Label>
              <Select value={employeeId} onValueChange={setEmployeeId} disabled={isSubmitting}>
                <SelectTrigger id="re-employee">
                  <SelectValue
                    placeholder={employeesLoaded && employees.length === 0 ? t('expense_no_employees') : t('expense_pick_employee')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.first_name} {e.last_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="re-description">{t('expense_description')}</Label>
            <Input
              id="re-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="re-date">{t('expense_date')}</Label>
              <Input
                id="re-date"
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="re-amount">{t('expense_amount', { currency })}</Label>
              <Input
                id="re-amount"
                inputMode="decimal"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                disabled={isSubmitting}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="re-vat">{t('expense_vat')}</Label>
              <Input
                id="re-vat"
                inputMode="decimal"
                value={vatInput}
                onChange={(e) => setVatInput(e.target.value)}
                disabled={isSubmitting}
                className="tabular-nums"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('expense_account')}</Label>
            <AccountCombobox
              value={expenseAccount}
              accounts={accounts}
              onChange={setExpenseAccount}
              disabled={isSubmitting}
              selectedName={accountName}
            />
          </div>

          {amount > 0 && vatAmount < amount && (
            <div className="rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground space-y-1">
              <p className="tabular-nums">
                {expenseAccount || '____'} D {formatCurrency(net, currency)}
                {vatAmount > 0 ? ` · 2641 D ${formatCurrency(vatAmount, currency)}` : ''}
                {` · ${liabilityAccount} K ${formatCurrency(amount, currency)}`}
              </p>
              {claimantName && (
                <p>{t('expense_outcome_att_gora', { name: claimantName })}</p>
              )}
              {currency !== 'SEK' && <p>{t('expense_fx_note')}</p>}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('expense_cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('expense_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
