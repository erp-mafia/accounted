'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
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
import { useToast } from '@/components/ui/use-toast'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { ExpenseClaimantFields } from '@/components/expenses/ExpenseClaimantFields'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useAccounts, useCompanySettings } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { roundOre, parseAmountInput, formatAmountInput } from '@/lib/money'
import { ACCOUNT_NUMBER_RE, ISO_DATE_RE } from '@/lib/invariants'
import { ownerFallbackName, resolveExpenseLiabilityAccount, type ExpensePayer } from '@/lib/expenses/payer'
import {
  expenseClaimReverseChargeLines,
  expenseVatCasesForReceipt,
  reverseChargeForVatCase,
  vatCaseFromReceipt,
  type ExpenseVatCase,
} from '@/lib/expenses/expense-claim-vat'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import type { InvoiceExtractionResult } from '@/types'

// Who paid for the underlag out of their own pocket. The account rule (2893
// AB owner / 2018 EF owner / 2820 employee) lives in lib/expenses/payer.ts,
// shared with the supplier-invoice form.
export type { ExpensePayer }

interface InboxItemLike {
  id: string
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: InboxItemLike
  payer: ExpensePayer
  /** Re-read the item after the claim posted its verifikat. */
  onSuccess: () => void | Promise<void>
}

function todayIso(): string {
  // Local calendar date: toISOString() is UTC and would date a receipt booked
  // after midnight CEST to the previous day (wrong period, wrong FX rate).
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function parseAmount(raw: string): number {
  return parseAmountInput(raw) ?? 0
}

/**
 * RegisterExpenseDialog: the confirm step behind "Vem betalade? Jag, privat /
 * En anställd" in the Underlag pane. One screen, prefilled from the
 * extraction: who, where the seller is, cost account, amount and VAT, then
 * the outcome spelled out before anything posts (design convention 10).
 * Posts through POST /api/expense-claims, which books cost + moms (or, for a
 * service bought abroad without VAT, omvänd skattskyldighet) against the
 * person's liability account and stamps the inbox item as booked.
 */
export default function RegisterExpenseDialog({ open, onOpenChange, item, payer, onSuccess }: Props) {
  const t = useTranslations('inbox_workspace')
  const { toast } = useToast()
  const { accounts } = useAccounts()
  const entityType = useCompanyOptional()?.company?.entity_type ?? null
  const liabilityAccount = resolveExpenseLiabilityAccount(entityType, payer)

  const data = item.extracted_data
  const [description, setDescription] = useState('')
  const [expenseDate, setExpenseDate] = useState(todayIso())
  const [amountInput, setAmountInput] = useState('')
  const [vatInput, setVatInput] = useState('')
  // Where the seller is and what the receipt shows (lib/expenses/
  // expense-claim-vat.ts); null until the receipt or the user answers.
  const [vatCase, setVatCase] = useState<ExpenseVatCase | null>(null)
  const [expenseAccount, setExpenseAccount] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [employeeName, setEmployeeName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Kostnadsställe/projekt for the cost line (the claim-level bag); the
  // pickers render only when company_settings.dimensions_enabled.
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const [dimensions, setDimensions] = useState<Record<string, string>>({})
  const currency = (data?.invoice?.currency ?? 'SEK').toUpperCase()
  const vatCaseOptions = expenseVatCasesForReceipt({ merchantCategory: data?.merchantCategory })
  // A form whose org number is the owner's personnummer has no separate
  // legal person to owe the owner: the money is an egen insättning, not a
  // debt, so the help and the outcome line say so instead of naming a
  // liability.
  const ownerIsTheCompany = isEntityType(entityType) && usesPersonnummerAsOrgNumber(entityType)

  // Reset per open so a previous underlag's numbers never carry over.
  useEffect(() => {
    if (!open) return
    setDescription(data?.supplier?.name?.trim() || '')
    setExpenseDate(data?.invoice?.invoiceDate || todayIso())
    const total = data?.totals?.total
    const vat = data?.totals?.vatAmount
    setAmountInput(total != null && total > 0 ? formatAmountInput(total) : '')
    // VAT the extraction did not read stays empty: a Swedish receipt's moms
    // is typed, never assumed to be 0.
    setVatInput(vat != null && vat > 0 ? formatAmountInput(vat) : vat === 0 ? '0' : '')
    // Prefilled only from VAT the receipt shows; otherwise the user answers.
    setVatCase(vatCaseFromReceipt({ currency, vatAmount: vat, sellerVatNumber: data?.supplier?.vatNumber }))
    setExpenseAccount('')
    setEmployeeId('')
    setEmployeeName('')
    setDimensions({})
  }, [open, item.id, data, currency])

  function setDimension(dimNo: string, code: string | null) {
    setDimensions((prev) => {
      const next = { ...prev }
      const trimmed = code?.trim()
      if (trimmed) next[dimNo] = trimmed
      else delete next[dimNo]
      return next
    })
  }

  const amount = parseAmount(amountInput)
  // Only a Swedish seller's moms is deductible. Abroad the field is locked
  // and 0 is what gets submitted, whatever the extraction said: foreign VAT
  // is cost, and a receipt under omvänd skattskyldighet carries none.
  const vatDeductible = vatCase === 'domestic'
  const vatLocked = vatCase !== null && !vatDeductible
  const vatAmount = vatDeductible ? parseAmount(vatInput) : 0
  const reverseCharge = vatCase ? reverseChargeForVatCase(vatCase) : undefined
  const net = roundOre(amount - vatAmount)
  const claimantName = payer === 'owner' ? ownerName.trim() || ownerFallbackName(entityType) : employeeName

  const accountRow = useMemo(
    () => accounts.find((a) => a.account_number === expenseAccount) ?? null,
    [accounts, expenseAccount],
  )
  const accountName = accountRow?.account_name ?? ''

  // The reverse-charge lines from the function the service books them with,
  // so the preview cannot drift; null when the cost account reports a box of
  // its own that the answer cannot join, which the service refuses too.
  const reverseChargeLines = useMemo(
    () => (reverseCharge ? expenseClaimReverseChargeLines(amount, reverseCharge, expenseAccount, accountRow) : []),
    [reverseCharge, amount, expenseAccount, accountRow],
  )

  const canSubmit =
    !isSubmitting &&
    vatCase !== null &&
    reverseChargeLines !== null &&
    description.trim().length > 0 &&
    ISO_DATE_RE.test(expenseDate) &&
    amount > 0 &&
    (!vatDeductible || vatInput.trim().length > 0) &&
    vatAmount >= 0 &&
    vatAmount < amount &&
    ACCOUNT_NUMBER_RE.test(expenseAccount) &&
    /^[4-8]/.test(expenseAccount) &&
    (payer === 'owner' || !!employeeId)

  // The verifikat the answer books, in the receipt's currency (the service
  // converts at the date's rate).
  const previewLines = useMemo(() => {
    if (vatCase === null || reverseChargeLines === null || !(amount > 0) || vatAmount >= amount) return []
    const lines: Array<{ account: string; side: 'D' | 'K'; amount: number }> = [
      { account: expenseAccount || '____', side: 'D', amount: net },
    ]
    if (vatAmount > 0) lines.push({ account: '2641', side: 'D', amount: vatAmount })
    for (const line of reverseChargeLines) {
      lines.push(
        line.debit_amount > 0
          ? { account: line.account_number, side: 'D', amount: line.debit_amount }
          : { account: line.account_number, side: 'K', amount: line.credit_amount },
      )
    }
    lines.push({ account: liabilityAccount, side: 'K', amount })
    return lines
  }, [vatCase, reverseChargeLines, amount, vatAmount, net, expenseAccount, liabilityAccount])

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
      if (reverseCharge) body.reverse_charge = reverseCharge
      if (payer === 'owner') body.claimant_name = claimantName
      else body.employee_id = employeeId
      if (dimensionsEnabled && Object.keys(dimensions).length > 0) body.dimensions = dimensions
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
    reverseCharge,
    payer,
    claimantName,
    employeeId,
    dimensionsEnabled,
    dimensions,
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
              ? ownerIsTheCompany
                ? t('expense_dialog_help_owner_ef')
                : t('expense_dialog_help_owner', { account: liabilityAccount })
              : t('expense_dialog_help_employee')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ExpenseClaimantFields
            payer={payer}
            ownerName={ownerName}
            onOwnerNameChange={setOwnerName}
            employeeId={employeeId}
            onEmployeeChange={(id, name) => {
              setEmployeeId(id)
              setEmployeeName(name)
            }}
            disabled={isSubmitting}
            idPrefix="re"
          />

          <div className="space-y-1.5">
            <Label htmlFor="re-description">{t('expense_description')}</Label>
            <Input
              id="re-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          {/* Where the seller is and what was bought decide the moms, not the
              currency (crm#1028). Asked before the amounts so the Moms field
              follows the answer; unanswered blocks Bokför, each option
              carries its consequence. */}
          <div className="space-y-1.5">
            <Label htmlFor="re-vat-case">{t('expense_vat_case')}</Label>
            <Select
              value={vatCase ?? ''}
              onValueChange={(next) => setVatCase(next as ExpenseVatCase)}
              disabled={isSubmitting}
            >
              <SelectTrigger id="re-vat-case">
                {/* Explicit children: the items render label + help, and the
                    trigger shows the label alone. */}
                <SelectValue placeholder={t('expense_vat_case_placeholder')}>
                  {vatCase ? t(`expense_vat_case_${vatCase}`) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start" className="w-[var(--radix-select-trigger-width)]">
                {vatCaseOptions.map((option) => (
                  <SelectItem key={option} value={option} className="py-2">
                    <span className="block">{t(`expense_vat_case_${option}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`expense_vat_case_help_${option}`)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {vatCase ? t(`expense_vat_case_help_${vatCase}`) : t('expense_vat_case_required')}
            </p>
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
                value={vatLocked ? '0' : vatInput}
                onChange={(e) => setVatInput(e.target.value)}
                disabled={isSubmitting || vatLocked}
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
            {reverseChargeLines === null && (
              <p className="attn text-[12.5px]">{t('expense_reverse_charge_account', { account: expenseAccount })}</p>
            )}
          </div>

          {/* Kostnadsställe/projekt on the cost line (VAT and the liability
              leg stay untagged). */}
          {dimensionsEnabled && (
            <LineDimensionFields dimensions={dimensions} onChange={setDimension} disabled={isSubmitting} />
          )}

          {previewLines.length > 0 && (
            <div className="rounded-lg border border-border px-4 py-3 text-xs text-muted-foreground space-y-1">
              <p className="tabular-nums">
                {previewLines
                  .map((line) => `${line.account} ${line.side} ${formatCurrency(line.amount, currency)}`)
                  .join(' · ')}
              </p>
              {payer === 'owner' && ownerIsTheCompany ? (
                <p>{t('expense_outcome_ef')}</p>
              ) : (
                claimantName && <p>{t('expense_outcome_att_gora', { name: claimantName })}</p>
              )}
              {currency !== 'SEK' && <p>{t('expense_fx_note')}</p>}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('expense_cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} loading={isSubmitting}>
            {t('expense_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
