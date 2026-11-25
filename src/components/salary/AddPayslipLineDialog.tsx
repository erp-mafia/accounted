'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
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
import { VACATION_CATEGORIES, type VacationCategory } from '@/lib/salary/vacation-category'
import {
  MANUAL_PAYSLIP_LINE_SPECS,
  MANUAL_PAYSLIP_LINE_TYPES,
  MEAL_BENEFIT_KINDS,
  buildManualPayslipLine,
  mealBenefitUnit,
  storedLineItemType,
  taxableCounterpart,
  type ManualLineCaps,
  type ManualPayslipLineType,
  type MealBenefitKind,
  type MealBenefitSchablon,
} from '@/lib/salary/manual-payslip-lines'
import { TEXT_ROW_MAX_LENGTH, isTextRow } from '@/lib/salary/text-rows'
import { isBenefitItemType } from '@/lib/salary/benefit-payments'
import { isDeductionLineType, payslipLineFlags } from '@/lib/salary/line-item-roles'
import { isAllowedOverrideAccount, lineAccountOverride } from '@/lib/salary/line-account-override'
import { LineAccountField } from '@/components/salary/LineAccountField'

const DEFAULT_TYPE: ManualPayslipLineType = 'mileage_taxfree'
const DEFAULT_MEAL: MealBenefitKind = 'lunch_middag'

// Quantity, unit price and amount keep what was typed; the line amount is
// rounded where it is computed.
const parseNumber = (s: string): number | undefined => parseDecimalInput(s) ?? undefined

/**
 * One-off payslip line ("Lägg till rad"): milersättning, traktamente, bonus,
 * övertid, OB, kostförmån, övrig förmån, a deduction, or a Textrad (words only, no amount). Convention
 * 13: centered modal for create. The catalogue and the flags each type
 * carries live in lib/salary/manual-payslip-lines.ts; this dialog only
 * collects the numbers, or the text, and, on rows that post on their own
 * account, an optional account override (empty = the default the booking
 * resolves for this employee). Semester takes the days taken and which days
 * they are; its amount is optional (crm#1331). Kostförmån takes the meal and
 * the count, priced at Skatteverket's schablon for the run's year
 * (mealSchablon); the à-pris stays editable for a value Skatteverket has
 * adjusted (crm#1349). Utlandstraktamente takes the country and, on the
 * tax-free row, the country's normalbelopp per day, which caps the à-pris
 * (crm#1468); the row books on 7323 / 7324 unless an account is picked.
 * Semesterlön rörliga lönedelar is offered only for an employee on
 * sammalöneregeln, and saved only once the operator confirms the central
 * kollektivavtal that lets it be paid with the salary.
 */
export function AddPayslipLineDialog({
  open,
  onOpenChange,
  runId,
  salaryRunEmployeeId,
  taxFreeCaps,
  mealSchablon,
  employmentType,
  personnelCategory,
  vacationRule,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  runId: string
  salaryRunEmployeeId: string
  /** The employee's employment type and personnel category: they decide the default account shown. */
  employmentType: string
  personnelCategory: string | null | undefined
  /** The employee's semesterregel: Semesterlön rörliga lönedelar is offered under sammalöneregeln only. */
  vacationRule?: string | null
  /** Schablon per mil / per day for the run's year; a tax-free line above it is refused. */
  taxFreeCaps?: ManualLineCaps
  /** Kostförmån per meal for the run's year; empty before the first calculation. */
  mealSchablon?: MealBenefitSchablon
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
  const [vacationCategory, setVacationCategory] = useState<VacationCategory>('paid')
  const [mealKind, setMealKind] = useState<MealBenefitKind>(DEFAULT_MEAL)
  const [country, setCountry] = useState('')
  const [normalbelopp, setNormalbelopp] = useState('')
  const [kollektivavtalConfirmed, setKollektivavtalConfirmed] = useState(false)

  const lineTypes = MANUAL_PAYSLIP_LINE_TYPES.filter(
    (k) => vacationRule === 'sammaloneregeln' || !MANUAL_PAYSLIP_LINE_SPECS[k].settlesVariableVacationPay,
  )
  const spec = MANUAL_PAYSLIP_LINE_SPECS[type]
  // Semesterlön rörliga lönedelar paid with the salary under a kollektivavtal.
  const isVariableVacationPay = spec.settlesVariableVacationPay === true
  // The item type the row is stored as: an utlandstraktamente or a
  // nattraktamente is a traktamente row (manual-payslip-lines.ts).
  const storedType = storedLineItemType(type)
  const isForeign = spec.foreign === true
  const isForeignTaxFree = isForeign && !payslipLineFlags(storedType).is_taxable
  // A Textrad is words only: no quantity, no à-pris, no amount.
  const isText = isTextRow({ item_type: type })
  // Semester needs its days; the amount is optional.
  const isVacation = type === 'vacation'
  // Kostförmån is counted in meals (or days of helt fri kost) at the schablon.
  const isMeal = type === 'benefit_meals'
  const unit = isMeal ? mealBenefitUnit(mealKind) : spec.unit
  const mealValue = isMeal ? mealSchablon?.perKind[mealKind] : undefined
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
      vacation_category: isVacation ? vacationCategory : undefined,
      meal_kind: isMeal ? mealKind : undefined,
      country: isForeign ? country : undefined,
      normalbelopp: isForeignTaxFree ? parseNumber(normalbelopp) : undefined,
      kollektivavtal_confirmed: isVariableVacationPay ? kollektivavtalConfirmed : undefined,
    },
    taxFreeCaps,
  )
  const preview = built.ok ? built.body : null
  const aboveCap = !built.ok && built.reason === 'above_tax_free_cap' ? built : null
  const noText = !built.ok && built.reason === 'no_text'
  const noDays = !built.ok && built.reason === 'no_days'
  const noCountry = !built.ok && built.reason === 'no_country'
  const noNormalbelopp = !built.ok && built.reason === 'no_normalbelopp'
  const noKollektivavtal = !built.ok && built.reason === 'no_kollektivavtal'

  function reset() {
    setType(DEFAULT_TYPE)
    setDescription('')
    setQuantity('')
    setUnitPrice('')
    setAmount('')
    setInvalid(false)
    setAccount('')
    setAccountInvalid(false)
    setVacationCategory('paid')
    setMealKind(DEFAULT_MEAL)
    setCountry('')
    setNormalbelopp('')
    setKollektivavtalConfirmed(false)
    onOpenChange(false)
  }

  // Prices the meal at the year's schablon; a typed à-pris is replaced only
  // when the meal (or the type) changes, never while the operator types.
  function applyMealSchablon(kind: MealBenefitKind) {
    const value = mealSchablon?.perKind[kind]
    if (value !== undefined) setUnitPrice(String(value))
  }

  async function handleAdd() {
    if (!preview) {
      setInvalid(true)
      return
    }
    // An override only: empty sends no account_number.
    const accountNumber = lineAccountOverride(storedType) === 'none' ? '' : account.trim()
    if (accountNumber && !isAllowedOverrideAccount(storedType, accountNumber)) {
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
  const hintKey = isText
    ? 'add_line_hint_text'
    : isBenefitItemType(type)
      ? 'add_line_hint_benefit'
      : isDeductionLineType(storedType)
        ? 'add_line_hint_deduction'
        : spec.typedSign
          ? 'add_line_hint_signed'
          : 'add_line_hint_addition'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) reset()
      }}
    >
      <DialogContent size="form">
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
                  if (v === 'benefit_meals') applyMealSchablon(mealKind)
                  setInvalid(false)
                  // The confirmation is given for the row in front of the operator.
                  setKollektivavtalConfirmed(false)
                  // An override picked for the old type need not fit the new one.
                  setAccount('')
                  setAccountInvalid(false)
                }}
              >
                <SelectTrigger id="payslip_line_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {lineTypes.map((k) => (
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

          {isVacation && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="payslip_line_vacation_category">{t('add_line_vacation_category')}</Label>
                <Select value={vacationCategory} onValueChange={(v) => setVacationCategory(v as VacationCategory)}>
                  <SelectTrigger id="payslip_line_vacation_category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VACATION_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {t(`add_line_vacation_category_${category}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isMeal && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="payslip_line_meal_kind">{t('add_line_meal_kind')}</Label>
                <Select
                  value={mealKind}
                  onValueChange={(v) => {
                    const kind = v as MealBenefitKind
                    setMealKind(kind)
                    applyMealSchablon(kind)
                    setInvalid(false)
                  }}
                >
                  <SelectTrigger id="payslip_line_meal_kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEAL_BENEFIT_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {t(`add_line_meal_kind_${kind}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isForeign && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="payslip_line_country">{t('add_line_country')}</Label>
                <Input
                  id="payslip_line_country"
                  value={country}
                  onChange={(e) => { setCountry(e.target.value); setInvalid(false) }}
                  maxLength={100}
                  required
                  aria-invalid={(invalid && noCountry) || undefined}
                />
              </div>
              {isForeignTaxFree && (
                <div className="space-y-2">
                  <Label htmlFor="payslip_line_normalbelopp">{t('add_line_normalbelopp')}</Label>
                  <Input
                    id="payslip_line_normalbelopp"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    value={normalbelopp}
                    onChange={(e) => { setNormalbelopp(e.target.value); setInvalid(false) }}
                    required
                    aria-invalid={(invalid && noNormalbelopp) || undefined}
                  />
                </div>
              )}
            </div>
          )}

          {isVariableVacationPay && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                id="payslip_line_kollektivavtal"
                className="mt-0.5"
                checked={kollektivavtalConfirmed}
                onCheckedChange={(v) => { setKollektivavtalConfirmed(v === true); setInvalid(false) }}
                aria-invalid={(invalid && noKollektivavtal) || undefined}
              />
              {t('add_line_kollektivavtal_confirm')}
            </label>
          )}

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
                  {unit && (
                    <span className="text-muted-foreground"> ({t(`add_line_unit_${unit}`)})</span>
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
                  required={isVacation}
                  aria-invalid={(invalid && noDays) || undefined}
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
                  aria-invalid={(invalid && !noDays) || !!aboveCap || undefined}
                />
              </div>
            </div>
          )}
          <p className={invalid || aboveCap ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} aria-live="polite">
            {aboveCap && isForeign
              ? t('add_line_above_normalbelopp', {
                  cap: formatCurrency(aboveCap.cap),
                  taxable: t(`li_${taxableCounterpart(type)}`),
                })
              : aboveCap
              ? t('add_line_above_cap', {
                  cap: formatCurrency(aboveCap.cap),
                  unit: t(`add_line_unit_${aboveCap.unit}`),
                  taxable: t(`li_${taxableCounterpart(type)}`),
                })
              : invalid
                ? noText
                  ? t('add_line_invalid_text', { max: TEXT_ROW_MAX_LENGTH })
                  : noDays
                    ? t('add_line_invalid_vacation')
                    : noCountry
                      ? t('add_line_invalid_country')
                      : noNormalbelopp
                        ? t('add_line_invalid_normalbelopp')
                        : noKollektivavtal
                          ? t('add_line_invalid_kollektivavtal')
                          : t('add_line_invalid')
                : computed && preview && !isText
                  ? `${t('add_line_computed')} = ${formatCurrency(preview.amount)}`
                  : isMeal && mealValue !== undefined && mealSchablon?.year !== undefined
                    ? t('add_line_hint_meal', { year: mealSchablon.year, amount: formatCurrency(mealValue) })
                    : isForeignTaxFree
                      ? t('add_line_hint_foreign')
                      : isVariableVacationPay
                        ? t('add_line_hint_variable_vacation_pay')
                        : t(isVacation ? 'add_line_hint_vacation' : hintKey)}
          </p>

          <LineAccountField
            id="payslip_line_account"
            itemType={storedType}
            defaultAccount={spec.account}
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
