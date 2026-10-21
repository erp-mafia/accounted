'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import { roundOre, parseDecimalInput } from '@/lib/money'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  MANUAL_PAYSLIP_LINE_SPECS,
  MANUAL_PAYSLIP_LINE_TYPES,
  buildManualPayslipLine,
  type ManualLineCaps,
  type ManualPayslipLineType,
} from '@/lib/salary/manual-payslip-lines'
import { TEXT_ROW_MAX_LENGTH, isTextRow } from '@/lib/salary/text-rows'
import { isBenefitItemType } from '@/lib/salary/benefit-payments'
import { isAllowedOverrideAccount, lineAccountOverride } from '@/lib/salary/line-account-override'
import { LineAccountField } from '@/components/salary/LineAccountField'

const DEFAULT_TYPE: ManualPayslipLineType = 'mileage_taxfree'

// Quantity, unit price and amount keep what was typed; the line amount is
// rounded where it is computed.
const parseNumber = (s: string): number | undefined => parseDecimalInput(s) ?? undefined

/**
 * One-off payslip line ("Lägg till rad"): milersättning, traktamente, bonus,
 * övertid, OB, kostförmån, a deduction, or a Textrad (words only, no amount). Convention
 * 13: centered modal for create. The catalogue and the flags each type
 * carries live in lib/salary/manual-payslip-lines.ts; this dialog only
 * collects the numbers, or the text, and, on rows that post on their own
 * account, an optional account override (empty = the default the booking
 * resolves for this employee).
 */
export function AddPayslipLineDialog({
  open,
  onOpenChange,
  runId,
  salaryRunEmployeeId,
  taxFreeCaps,
  employmentType,
  personnelCategory,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  runId: string
  salaryRunEmployeeId: string
  /** The employee's employment type and personnel category: they decide the default account shown. */
  employmentType: string
  personnelCategory: string | null | undefined
  /** Schablon per mil / per day for the run's year; a tax-free line above it is refused. */
  taxFreeCaps?: ManualLineCaps
  onAdded: () => void | Promise<void>
}) {
  const t = useTranslations('salary_run_employee')
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [type, setType] = useState<ManualPayslipLineType>(DEFAULT_TYPE)
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [account, setAccount] = useState('')
  const [accountInvalid, setAccountInvalid] = useState(false)

  const spec = MANUAL_PAYSLIP_LINE_SPECS[type]
  // A Textrad is words only: no quantity, no à-pris, no amount.
  const isText = isTextRow({ item_type: type })
  const quantityN = parseNumber(quantity)
  const unitPriceN = parseNumber(unitPrice)
  // Quantity x unit price wins over a typed amount, same rule as the body
  // builder, so the preview is what will be stored.
  const product = quantityN !== undefined && unitPriceN !== undefined ? roundOre(quantityN * unitPriceN) : undefined
  const computed = product !== undefined
  const built = buildManualPayslipLine(
    {
      item_type: type,
      description,
      quantity: quantityN,
      unit_price: unitPriceN,
      amount: parseNumber(amount),
    },
    taxFreeCaps,
  )
  const preview = built.ok ? built.body : null
  const aboveCap = !built.ok && built.reason === 'above_tax_free_cap' ? built : null
  const noText = !built.ok && built.reason === 'no_text'

  function reset() {
    setType(DEFAULT_TYPE)
    setDescription('')
    setQuantity('')
    setUnitPrice('')
    setAmount('')
    setInvalid(false)
    setAccount('')
    setAccountInvalid(false)
    onOpenChange(false)
  }

  async function handleAdd() {
    if (!preview) {
      setInvalid(true)
      return
    }
    // An override only: empty sends no account_number.
    const accountNumber = lineAccountOverride(type) === 'none' ? '' : account.trim()
    if (accountNumber && !isAllowedOverrideAccount(type, accountNumber)) {
      setAccountInvalid(true)
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/salary/runs/${runId}/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          salary_run_employee_id: salaryRunEmployeeId,
          ...preview,
          ...(accountNumber ? { account_number: accountNumber } : {}),
        }),
      })
      if (res.ok) {
        toast({ title: t('line_added') })
        reset()
        await onAdded()
      } else {
        const result = await res.json().catch(() => null)
        toast({
          title: t('line_add_failed'),
          description: getErrorMessage(result, { statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('line_add_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  // A benefit is added to the tax base, not to the payout.
  const hintKey =
    spec.sign === 'none'
      ? 'add_line_hint_text'
      : isBenefitItemType(type)
        ? 'add_line_hint_benefit'
        : spec.sign === 'deduction'
        ? 'add_line_hint_deduction'
        : spec.sign === 'signed'
          ? 'add_line_hint_signed'
          : 'add_line_hint_addition'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) reset()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('add_line')}</DialogTitle>
          <DialogDescription>{t('add_line_help')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="payslip_line_type">{t('add_line_type')}</Label>
              <Select
                value={type}
                onValueChange={(v) => {
                  setType(v as ManualPayslipLineType)
                  setInvalid(false)
                  // An override picked for the old type need not fit the new one.
                  setAccount('')
                  setAccountInvalid(false)
                }}
              >
                <SelectTrigger id="payslip_line_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_PAYSLIP_LINE_TYPES.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`li_${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!isText && (
              <div className="space-y-2">
                <Label htmlFor="payslip_line_description">{t('add_line_description')}</Label>
                <Input
                  id="payslip_line_description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t(`li_${type}`)}
                  maxLength={500}
                />
              </div>
            )}
          </div>

          {isText ? (
            <div className="space-y-2">
              <Label htmlFor="payslip_line_text">{t('add_line_text')}</Label>
              <Textarea
                id="payslip_line_text"
                value={description}
                onChange={(e) => { setDescription(e.target.value); setInvalid(false) }}
                placeholder={t('add_line_text_placeholder')}
                maxLength={TEXT_ROW_MAX_LENGTH}
                required
                aria-invalid={(invalid && noText) || undefined}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="payslip_line_quantity">
                  {t('add_line_quantity')}
                  {spec.unit && (
                    <span className="text-muted-foreground"> ({t(`add_line_unit_${spec.unit}`)})</span>
                  )}
                </Label>
                <Input
                  id="payslip_line_quantity"
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(e) => { setQuantity(e.target.value); setInvalid(false) }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payslip_line_unit_price">{t('add_line_unit_price')}</Label>
                <Input
                  id="payslip_line_unit_price"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={unitPrice}
                  onChange={(e) => { setUnitPrice(e.target.value); setInvalid(false) }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="payslip_line_amount">{t('add_line_amount')}</Label>
                <Input
                  id="payslip_line_amount"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={product !== undefined ? String(product) : amount}
                  onChange={(e) => { setAmount(e.target.value); setInvalid(false) }}
                  disabled={computed}
                  aria-invalid={invalid || !!aboveCap || undefined}
                />
              </div>
            </div>
          )}
          <p className={invalid || aboveCap ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} aria-live="polite">
            {aboveCap
              ? t('add_line_above_cap', {
                  cap: formatCurrency(aboveCap.cap),
                  unit: t(`add_line_unit_${aboveCap.unit}`),
                  taxable: t(`li_${type === 'mileage_taxfree' ? 'mileage_taxable' : 'traktamente_taxable'}`),
                })
              : invalid
                ? noText
                  ? t('add_line_invalid_text', { max: TEXT_ROW_MAX_LENGTH })
                  : t('add_line_invalid')
                : computed && preview && !isText
                  ? `${t('add_line_computed')} = ${formatCurrency(preview.amount)}`
                  : t(hintKey)}
          </p>

          <LineAccountField
            id="payslip_line_account"
            itemType={type}
            employmentType={employmentType}
            personnelCategory={personnelCategory}
            value={account}
            onChange={(next) => { setAccount(next); setAccountInvalid(false) }}
            invalid={accountInvalid}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={reset} disabled={submitting}>
            {t('add_line_cancel')}
          </Button>
          <Button type="button" onClick={handleAdd} loading={submitting}>
            {t('add_line_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
