'use client'

import { useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDownIcon } from '@/components/icons'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  ALL_WEEKDAYS,
  premiumRuleExample,
  validatePremiumRuleDraft,
  type PremiumOverlapChoice,
  type PremiumRuleDraft,
  type PremiumRuleDraftField,
} from '@/lib/salary/premium-rule-draft'
import { cn, formatCurrency } from '@/lib/utils'
import type { ShiftPremiumAmountForm, ShiftPremiumItemType } from '@/types'

export interface PremiumRuleEmployeeOption {
  id: string
  name: string
}

const ITEM_TYPES: ShiftPremiumItemType[] = [
  'ob_weekday_evening',
  'ob_night',
  'ob_weekend',
  'ob_holiday',
  'overtime_50',
  'overtime_100',
]

const FORMS: ShiftPremiumAmountForm[] = ['percent_of_hourly', 'monthly_divisor', 'sek_per_hour']

const OVERLAP_CHOICES: PremiumOverlapChoice[] = ['highest', 'first', 'last']

/**
 * The words around each form's single amount field, so the field reads as
 * the same sentence the rule list shows: "50 % av timlönen", "Månadslönen /
 * 480 per timme", "27,59 kr per timme".
 */
const AMOUNT_PREFIX: Record<ShiftPremiumAmountForm, boolean> = {
  percent_of_hourly: false,
  monthly_divisor: true,
  sek_per_hour: false,
}

/** A pill toggle in the compact chip rows (weekdays, employees). */
function ChipToggle({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'h-8 rounded-full border px-3 text-[12.5px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        pressed
          ? 'border-foreground bg-foreground text-background'
          : 'border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null
  return (
    <p id={id} className="text-[12.5px] text-destructive">
      {message}
    </p>
  )
}

interface ShiftPremiumRuleDialogProps {
  open: boolean
  /** False for a new rule. */
  editing: boolean
  draft: PremiumRuleDraft
  onDraftChange: (draft: PremiumRuleDraft) => void
  employees: PremiumRuleEmployeeOption[]
  /** Today's date (YYYY-MM-DD): where the example looks for its first day. */
  today: string
  saving?: boolean
  /** Shows the field errors without a save attempt (sandbox previews). */
  showErrors?: boolean
  /** A refusal from the server, as one sentence. */
  serverError?: string | null
  /** Opens the Avancerat part from the start (sandbox previews). */
  advancedOpen?: boolean
  onSave: () => void
  onClose: () => void
}

/**
 * The premium-rule editor (convention 13: centered modal). One question per
 * line: name and kind, the days as a chip row, the window, the amount in one
 * of three plain forms, the validity and who it applies to. How overlapping
 * rules are settled waits behind Avancerat. The example line under it is the
 * engine's own figure for a made-up shift (lib/salary/premium-rule-draft.ts).
 */
export function ShiftPremiumRuleDialog({
  open,
  editing,
  draft,
  onDraftChange,
  employees,
  today,
  saving = false,
  showErrors = false,
  serverError = null,
  advancedOpen = false,
  onSave,
  onClose,
}: ShiftPremiumRuleDialogProps) {
  const t = useTranslations('premium_rules')
  const idBase = useId()
  const id = (field: string) => `${idBase}-${field}`
  const [attempted, setAttempted] = useState(false)
  const [advanced, setAdvanced] = useState(advancedOpen)

  const errors = validatePremiumRuleDraft(draft)
  const visible = showErrors || attempted
  const errorFor = (field: PremiumRuleDraftField) =>
    visible && errors[field] ? t(`error_${errors[field]}`) : null

  const example = useMemo(() => premiumRuleExample(draft, today), [draft, today])
  const holiday = draft.item_type === 'ob_holiday'

  function patch(next: Partial<PremiumRuleDraft>) {
    onDraftChange({ ...draft, ...next })
  }

  function setItemType(itemType: ShiftPremiumItemType) {
    // Leaving the holiday kind restores a weekday set to edit.
    const leavingHoliday = draft.item_type === 'ob_holiday' && itemType !== 'ob_holiday'
    patch({
      item_type: itemType,
      day_of_week: leavingHoliday && draft.day_of_week.length === 7 ? [1, 2, 3, 4, 5] : draft.day_of_week,
    })
  }

  function toggleWeekday(day: number) {
    if (holiday) {
      // A weekday chip ends the holiday mode: the rule becomes a weekend OB on that day.
      patch({ item_type: 'ob_weekend', day_of_week: [day] })
      return
    }
    const on = draft.day_of_week.includes(day)
    patch({ day_of_week: on ? draft.day_of_week.filter((d) => d !== day) : [...draft.day_of_week, day] })
  }

  function toggleHolidays() {
    if (holiday) setItemType('ob_weekend')
    else patch({ item_type: 'ob_holiday' })
  }

  function toggleEmployee(employeeId: string) {
    const on = draft.applies_to_employee_ids.includes(employeeId)
    patch({
      applies_to_employee_ids: on
        ? draft.applies_to_employee_ids.filter((x) => x !== employeeId)
        : [...draft.applies_to_employee_ids, employeeId],
    })
  }

  function handleSave() {
    setAttempted(true)
    if (Object.keys(errors).length > 0) return
    onSave()
  }

  const amountError = errorFor('amount')
  const hasPrefix = AMOUNT_PREFIX[draft.amount_form]
  // Equal start and end is a whole day (the engine and the rule list read it so).
  const wholeDay = draft.start_time !== '' && draft.start_time === draft.end_time

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) {
          setAttempted(false)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t('edit_title') : t('new_title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={id('name')}>{t('field_name')}</Label>
              <Input
                id={id('name')}
                value={draft.name}
                maxLength={100}
                placeholder={t('name_placeholder')}
                aria-invalid={Boolean(errorFor('name'))}
                aria-describedby={errorFor('name') ? id('name-error') : undefined}
                onChange={(e) => patch({ name: e.target.value })}
              />
              <FieldError id={id('name-error')} message={errorFor('name')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('type')}>{t('field_type')}</Label>
              <Select value={draft.item_type} onValueChange={(v) => setItemType(v as ShiftPremiumItemType)}>
                <SelectTrigger id={id('type')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`type_${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label id={id('days-label')}>{t('field_days')}</Label>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby={id('days-label')}>
              {ALL_WEEKDAYS.map((day) => (
                <ChipToggle
                  key={day}
                  pressed={!holiday && draft.day_of_week.includes(day)}
                  onClick={() => toggleWeekday(day)}
                >
                  {t(`wd_${day}`)}
                </ChipToggle>
              ))}
              <ChipToggle pressed={holiday} onClick={toggleHolidays}>
                {t('days_holidays')}
              </ChipToggle>
            </div>
            <FieldError id={id('days-error')} message={errorFor('day_of_week')} />
          </div>

          <div className="flex items-center gap-3">
            <Switch
              id={id('whole-day')}
              checked={wholeDay}
              onCheckedChange={(on) =>
                patch(on ? { start_time: '00:00', end_time: '00:00' } : { start_time: '', end_time: '' })
              }
            />
            <Label htmlFor={id('whole-day')}>{t('whole_day')}</Label>
          </div>

          <div className={cn('grid grid-cols-2 gap-4', wholeDay && 'hidden')}>
            <div className="space-y-2">
              <Label htmlFor={id('start')}>{t('field_start')}</Label>
              <Input
                id={id('start')}
                type="time"
                step={60}
                value={draft.start_time}
                aria-invalid={Boolean(errorFor('start_time'))}
                onChange={(e) => patch({ start_time: e.target.value.slice(0, 5) })}
                className="tabular-nums"
              />
              <FieldError id={id('start-error')} message={errorFor('start_time')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('end')}>{t('field_end')}</Label>
              <Input
                id={id('end')}
                type="time"
                step={60}
                value={draft.end_time}
                aria-invalid={Boolean(errorFor('end_time'))}
                onChange={(e) => patch({ end_time: e.target.value.slice(0, 5) })}
                className="tabular-nums"
              />
              <FieldError id={id('end-error')} message={errorFor('end_time')} />
            </div>
          </div>

          <div className="space-y-2">
            <Label id={id('form-label')}>{t('field_amount')}</Label>
            <div>
              <SegmentedControl<ShiftPremiumAmountForm>
                aria-label={t('field_amount')}
                value={draft.amount_form}
                onChange={(form) => patch({ amount_form: form })}
                options={FORMS.map((form) => ({ value: form, label: t(`form_${form}`) }))}
              />
            </div>
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {hasPrefix ? <span className="shrink-0">{t('amount_prefix_monthly_divisor')}</span> : null}
              <Input
                id={id('amount')}
                inputMode="decimal"
                aria-labelledby={id('form-label')}
                aria-invalid={Boolean(amountError)}
                aria-describedby={amountError ? id('amount-error') : undefined}
                placeholder={t(`amount_placeholder_${draft.amount_form}`)}
                value={draft.amounts[draft.amount_form]}
                onChange={(e) => patch({ amounts: { ...draft.amounts, [draft.amount_form]: e.target.value } })}
                className="w-28 tabular-nums text-foreground"
              />
              <span className="shrink-0">{t(`amount_suffix_${draft.amount_form}`)}</span>
            </div>
            <FieldError id={id('amount-error')} message={amountError} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={id('from')}>{t('field_valid_from')}</Label>
              <Input
                id={id('from')}
                type="date"
                value={draft.valid_from}
                aria-invalid={Boolean(errorFor('valid_from'))}
                onChange={(e) => patch({ valid_from: e.target.value })}
                className="tabular-nums"
              />
              <FieldError id={id('from-error')} message={errorFor('valid_from')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('to')}>{t('field_valid_to')}</Label>
              <Input
                id={id('to')}
                type="date"
                value={draft.valid_to}
                aria-invalid={Boolean(errorFor('valid_to'))}
                onChange={(e) => patch({ valid_to: e.target.value })}
                className="tabular-nums"
              />
              <FieldError id={id('to-error')} message={errorFor('valid_to')} />
            </div>
          </div>

          <div className="space-y-2">
            <Label id={id('employees-label')}>{t('field_employees')}</Label>
            <div>
              <SegmentedControl<'all' | 'named'>
                aria-label={t('field_employees')}
                value={draft.applies_to_all_employees ? 'all' : 'named'}
                onChange={(scope) => patch({ applies_to_all_employees: scope === 'all' })}
                options={[
                  { value: 'all', label: t('employees_all') },
                  { value: 'named', label: t('employees_named') },
                ]}
              />
            </div>
            {!draft.applies_to_all_employees ? (
              employees.length === 0 ? (
                <p className="text-[12.5px] text-muted-foreground">{t('employees_none')}</p>
              ) : (
                <div className="flex flex-wrap gap-2" role="group" aria-labelledby={id('employees-label')} data-ph-mask="">
                  {employees.map((employee) => (
                    <ChipToggle
                      key={employee.id}
                      pressed={draft.applies_to_employee_ids.includes(employee.id)}
                      onClick={() => toggleEmployee(employee.id)}
                    >
                      {employee.name}
                    </ChipToggle>
                  ))}
                </div>
              )
            ) : null}
            <FieldError id={id('employees-error')} message={errorFor('applies_to_employee_ids')} />
          </div>

          <div>
            <button
              type="button"
              aria-expanded={advanced}
              aria-controls={id('advanced')}
              onClick={() => setAdvanced((v) => !v)}
              className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              <ChevronDownIcon
                className={cn('h-3.5 w-3.5 transition-transform duration-150', !advanced && '-rotate-90')}
                aria-hidden="true"
              />
              {t('advanced')}
            </button>
            {advanced ? (
              <div id={id('advanced')} className="mt-3 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor={id('overlap')}>{t('field_overlap')}</Label>
                  <Select value={draft.overlap} onValueChange={(v) => patch({ overlap: v as PremiumOverlapChoice })}>
                    <SelectTrigger id={id('overlap')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OVERLAP_CHOICES.map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          {t(`overlap_${choice}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {draft.amount_form === 'percent_of_hourly' ? (
                  <div className="space-y-2">
                    <Label htmlFor={id('hourly-divisor')}>{t('field_hourly_divisor')}</Label>
                    <Input
                      id={id('hourly-divisor')}
                      inputMode="decimal"
                      placeholder={t('hourly_divisor_placeholder')}
                      value={draft.hourly_divisor}
                      aria-invalid={Boolean(errorFor('hourly_divisor'))}
                      onChange={(e) => patch({ hourly_divisor: e.target.value })}
                      className="max-w-48 tabular-nums"
                    />
                    <FieldError id={id('hourly-divisor-error')} message={errorFor('hourly_divisor')} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {example ? (
            <p className="text-[12.5px] text-muted-foreground tabular-nums">
              {example.monthlySalary === null
                ? t('example_fixed', {
                    hours: example.hours,
                    start: example.start,
                    end: example.end,
                    amount: formatCurrency(example.amount),
                  })
                : t('example', {
                    hours: example.hours,
                    start: example.start,
                    end: example.end,
                    salary: formatCurrency(example.monthlySalary),
                    amount: formatCurrency(example.amount),
                  })}
            </p>
          ) : null}

          {serverError ? <AttnLine>{serverError}</AttnLine> : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setAttempted(false)
              onClose()
            }}
          >
            {t('cancel')}
          </Button>
          <Button type="button" onClick={handleSave} loading={saving}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
