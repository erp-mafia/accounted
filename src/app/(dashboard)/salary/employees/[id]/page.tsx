'use client'

import { useState, useEffect, use } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { AttnLine } from '@/components/ui/attn-line'
import { ArrowDownOnSquareIcon } from '@/components/icons'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  semestertillaggRateFromPercentInput,
  semestertillaggRateToPercent,
  vacationDaysFromInput,
  vacationPayRateFromPercentInput,
  vacationPayRateToPercent,
} from '@/lib/salary/vacation-pay-rate'
import { daysOffPerYear } from '@/lib/salary/vacation-net-days'
import {
  validateEmployeeBankAccount,
  isValidClearing,
  normalizeBankNumber,
  lookupBankByClearing,
  checkEmployeeAccountChecksum,
} from '@/lib/payments/bank-account'
import type { EmployeeMasked } from '@/types'
import { EmployeeBenefitsPanel } from '@/components/salary/EmployeeBenefitsPanel'
import { EmployeeRecurringLinesPanel } from '@/components/salary/EmployeeRecurringLinesPanel'
import { OpeningBalancesPanel } from '@/components/salary/OpeningBalancesPanel'
import EmployeeTaxCard, { type EmployeeTaxValue } from '@/components/salary/EmployeeTaxCard'
import { jamkningPatch } from '@/lib/salary/jamkning-patch'
import { extraTaxPatch } from '@/lib/salary/extra-tax'
import { clearableField } from '@/lib/salary/clearable-field'
import { SAMMALONEREGELN_KOLLEKTIVAVTAL_KEY, sammaloneregelnDegreeChange } from '@/lib/salary/employee-update-rules'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'

const EMPLOYMENT_LABEL_KEYS: Record<string, string> = {
  employee: 'form_employment_type_employee',
  company_owner: 'form_employment_type_company_owner',
  board_member: 'form_employment_type_board_member',
}

const VACATION_RULE_KEYS: Record<string, string> = {
  procentregeln: 'form_vacation_rule_procentregeln',
  sammaloneregeln: 'form_vacation_rule_sammaloneregeln',
  semesterersattning: 'form_vacation_rule_semesterersattning',
  none: 'form_vacation_rule_none',
}

// Same literals as the Select in EmployeeTaxCard; not_verified falls back to
// its i18n label below.
const F_SKATT_LABELS: Record<string, string> = {
  a_skatt: 'A-skatt',
  f_skatt: 'F-skatt',
  fa_skatt: 'FA-skatt',
}

// Section headers inside the edit dialog (same idiom as NewEmployeeDialog:
// borderless sections split by hairline dividers, no per-section cards).
const SECTION_HEADER = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground'

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('salary_employee')
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { dialogProps, confirm: confirmAction } = useDestructiveConfirm()
  const [employee, setEmployee] = useState<EmployeeMasked | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deactivating, setDeactivating] = useState(false)
  const [reactivating, setReactivating] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [employmentType, setEmploymentType] = useState('employee')
  const [personnelCategory, setPersonnelCategory] = useState('tjansteman')
  const [salaryType, setSalaryType] = useState('monthly')
  const [vacationRule, setVacationRule] = useState('procentregeln')
  // The typed sysselsättningsgrad, watched so a change on a sammalöneregeln
  // employee offers its two ways out before the save (semesterlagen 16 §).
  const [degreeInput, setDegreeInput] = useState('')
  const [kollektivavtalConfirmed, setKollektivavtalConfirmed] = useState(false)
  const [clearing, setClearing] = useState('')
  const [account, setAccount] = useState('')
  // Suppress the soft check-digit warning while the bank fields are focused.
  const [bankFocused, setBankFocused] = useState(false)
  const [tax, setTax] = useState<EmployeeTaxValue | null>(null)
  // Default dimensions bag ({sie_dim_no: object_code}) proposed on the
  // employee's salary-cost lines at booking. The fields render only when
  // company_settings.dimensions_enabled: same UI gate as the voucher form.
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const [dimensions, setDimensions] = useState<Record<string, string>>({})

  // The controlled form fields mirror the saved row. Called on load and again
  // every time the edit dialog opens, so a cancelled edit never leaks into the
  // next one (the uncontrolled inputs reset by themselves: the dialog unmounts
  // its children on close).
  function syncFormState(data: EmployeeMasked) {
    setEmploymentType(data.employment_type)
    setPersonnelCategory(data.personnel_category || 'tjansteman')
    setSalaryType(data.salary_type || 'monthly')
    setVacationRule(data.vacation_rule || 'procentregeln')
    setDegreeInput(String(data.employment_degree ?? 100))
    setKollektivavtalConfirmed(false)
    setClearing(data.clearing_number || '')
    setAccount(data.bank_account_number || '')
    setDimensions(data.default_dimensions ?? {})
  }

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/salary/employees/${id}`)
      if (res.ok) {
        const { data } = await res.json()
        setEmployee(data)
        syncFormState(data)
      }
      setLoading(false)
    }
    load()
  }, [id])

  function setDimension(dimNo: string, code: string | null) {
    setDimensions((prev) => {
      const next = { ...prev }
      const value = code?.trim()
      if (value) next[dimNo] = value
      else delete next[dimNo]
      return next
    })
  }

  // The server's rule (lib/salary/employee-update-rules.ts) on the form's
  // state: non-null while the save would change the sysselsättningsgrad of an
  // employee who stays on sammalöneregeln.
  function pendingSammaloneregelnChange() {
    const typed = parseFloat(degreeInput)
    if (!employee || !Number.isFinite(typed)) return null
    return sammaloneregelnDegreeChange(
      employee as unknown as Record<string, unknown>,
      { employment_degree: typed, vacation_rule: vacationRule },
    )
  }

  function openEdit() {
    if (employee) syncFormState(employee)
    setIsEditOpen(true)
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    // Block invalid bank details, but only when they actually changed: a legacy
    // employee with incomplete free-text bank data must stay editable in other
    // ways (mirrors the server's changed-only check).
    const clearingChanged = normalizeBankNumber(clearing) !== normalizeBankNumber(employee?.clearing_number)
    const accountChanged = normalizeBankNumber(account) !== normalizeBankNumber(employee?.bank_account_number)
    if (clearingChanged || accountChanged) {
      const bankIssues = validateEmployeeBankAccount(clearing, account)
      if (bankIssues.length > 0) {
        toast({
          title: t('detail_update_failed'),
          description: bankIssues.map((i) => t(`bank_error_${i.code}`)).join('. '),
          variant: 'destructive',
        })
        return
      }
    }

    // Semesterlagen 16 § andra stycket 3-4: the server refuses this save
    // unless the rule moves to procentregeln or a kollektivavtal is confirmed.
    const sammaloneregelnChange = pendingSammaloneregelnChange()
    if (sammaloneregelnChange && !kollektivavtalConfirmed) {
      toast({
        title: t('detail_update_failed'),
        description: t('form_sammaloneregeln_degree_choice_required'),
        variant: 'destructive',
      })
      return
    }

    setSaving(true)

    const form = new FormData(e.currentTarget)
    // Fora code (lib/salary/fora/markup.ts): edited for employees only, seeded
    // from the row like the contact fields. Leaving 'employee' clears it:
    // owners and board members are never marked up at Fora, and a code they
    // cannot see would refuse the save.
    const foraFields =
      employmentType === 'employee'
        ? {
            fora_fok_id: clearableField(form.get('fora_fok_id'), employee?.fora_fok_id),
            fora_fok_start_date: clearableField(form.get('fora_fok_start_date'), employee?.fora_fok_start_date),
          }
        : employee?.fora_fok_id
          ? { fora_fok_id: null, fora_fok_start_date: null }
          : {}
    const body: Record<string, unknown> = {
      first_name: form.get('first_name') as string,
      last_name: form.get('last_name') as string,
      employment_type: employmentType,
      // Shown (and sent) for employees only: owners and board members book on
      // their own accounts whatever it says, so a hidden field changes nothing.
      personnel_category: employmentType === 'employee' ? personnelCategory : undefined,
      ...foraFields,
      employment_start: form.get('employment_start') as string || undefined,
      // Optional fields seeded from the row: emptying one sends null, which
      // clears the column (#3008). Before, the emptied value was omitted and
      // the stored slutdatum came back after save.
      employment_end: clearableField(form.get('employment_end'), employee?.employment_end),
      // Sparse patch for required columns: an empty field is OMITTED
      // (undefined keys are dropped by JSON.stringify) so the server's patch
      // schema leaves the column unchanged. Hardcoded fallbacks here would
      // silently reset real DB values on submit.
      employment_degree: parseFloat(form.get('employment_degree') as string) || undefined,
      hours_per_week: parseFloat(form.get('hours_per_week') as string) || undefined,
      workdays_per_week: parseFloat(form.get('workdays_per_week') as string) || undefined,
      salary_type: salaryType,
      f_skatt_status: tax?.f_skatt_status,
      is_sidoinkomst: tax?.is_sidoinkomst,
      tax_table_number: tax?.tax_table_number ?? undefined,
      tax_column: tax?.tax_column ?? undefined,
      tax_municipality: tax?.tax_municipality || undefined,
      // Jämkning: the three keys are sent with explicit values (null = clear
      // the beslut; the route spreads the body so null reaches the UPDATE)
      // only when the inputs were visible (A-skatt, not sidoinkomst) and the
      // user edited them. Hidden or untouched, the keys are omitted like any
      // other sparse field, so toggling sidoinkomst / FA-skatt or fixing a
      // phone number never wipes a stored beslut. Guarded on `tax` so a card
      // that has not reported yet sends nothing.
      ...(tax ? jamkningPatch(tax) : {}),
      // Förhöjt skatteavdrag: same rule, sent only when visible and edited.
      ...(tax ? extraTaxPatch(tax) : {}),
      // Contact and bank inputs are always rendered and seeded from the row,
      // so emptying one clears it (null), like the slutdatum above. The tax
      // card's municipality/table stay sparse: they are hidden outside
      // A-skatt, and a hidden field must never be wiped by a save.
      email: clearableField(form.get('email'), employee?.email),
      phone: clearableField(form.get('phone'), employee?.phone),
      address_line1: clearableField(form.get('address_line1'), employee?.address_line1),
      postal_code: clearableField(form.get('postal_code'), employee?.postal_code),
      city: clearableField(form.get('city'), employee?.city),
      clearing_number: clearableField(normalizeBankNumber(clearing), employee?.clearing_number),
      bank_account_number: clearableField(normalizeBankNumber(account), employee?.bank_account_number),
      vacation_rule: vacationRule,
      // 0 is a real value (vacation_rule none); only an empty field is "unchanged".
      vacation_days_per_year: vacationDaysFromInput(form.get('vacation_days_per_year')) ?? undefined,
      // Always sent: an empty field (or a rule that hides it) clears the
      // kollektivavtal rate back to the statutory one.
      vacation_pay_rate: vacationPayRateFromPercentInput(form.get('vacation_pay_rate')),
      // Sent only while the field is visible (sammalöneregeln, the one rule
      // that reads it); an empty field is the statutory 0,43 %. Hidden, the
      // stored rate is kept. crm#1529
      semestertillagg_rate: vacationRule === 'sammaloneregeln'
        ? semestertillaggRateFromPercentInput(form.get('semestertillagg_rate'))
        : undefined,
      // Always sent: {} clears the employee's default dimensions.
      default_dimensions: dimensions,
      // Only with a changed degree on sammalöneregeln: recorded in audit_log.
      [SAMMALONEREGELN_KOLLEKTIVAVTAL_KEY]: sammaloneregelnChange && kollektivavtalConfirmed ? true : undefined,
    }

    // Include salary field matching the current salary_type
    if (salaryType === 'monthly') {
      body.monthly_salary = parseFloat(form.get('monthly_salary') as string) || undefined
    } else {
      body.hourly_rate = parseFloat(form.get('hourly_rate') as string) || undefined
    }

    const res = await fetch(`/api/salary/employees/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      const { data } = await res.json()
      setEmployee(data)
      syncFormState(data)
      setIsEditOpen(false)
      // A renamed or re-rated employee shows in every roster picker at once.
      void invalidateReferenceData('ref:employees')
      toast({ title: t('detail_updated') })
    } else {
      const result = await res.json()
      toast({
        title: t('detail_update_failed'),
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }

    setSaving(false)
  }

  async function handleDeactivate() {
    // In-flight guard: the confirm dialog closes before the DELETE settles,
    // so a second click would fire a duplicate request.
    if (deactivating) return
    const ok = await confirmAction({
      title: t('detail_deactivate_confirm_title'),
      description: t('detail_deactivate_confirm'),
      confirmLabel: t('detail_deactivate'),
      variant: 'destructive',
    })
    if (!ok) return

    setDeactivating(true)
    try {
      const res = await fetch(`/api/salary/employees/${id}`, { method: 'DELETE' })
      if (res.ok) {
        void invalidateReferenceData('ref:employees')
        toast({ title: t('detail_deactivated') })
        router.push('/salary/employees')
      } else {
        // The server says why (a legacy jämkning beslut that must be completed
        // or cleared first, a missing row, a database refusal): show it, the
        // way handleSave does. Closing the dialog silently read as "the button
        // does nothing". #2697
        const result = await res.json().catch(() => null)
        toast({
          title: t('detail_deactivate_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } finally {
      setDeactivating(false)
    }
  }

  // The way back from "Inaktivera": the same PATCH the edit form uses, with
  // only the flag. Nothing else was changed by the deactivation, so nothing
  // else needs restoring. Stays on the page: the employee is visible again.
  async function handleReactivate() {
    if (reactivating) return
    setReactivating(true)
    try {
      const res = await fetch(`/api/salary/employees/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true }),
      })
      if (res.ok) {
        const { data } = await res.json()
        setEmployee(data)
        syncFormState(data)
        void invalidateReferenceData('ref:employees')
        toast({ title: t('detail_reactivated'), description: t('detail_reactivated_description') })
      } else {
        const result = await res.json().catch(() => null)
        toast({
          title: t('detail_reactivate_failed'),
          description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } finally {
      setReactivating(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-60" />
        <Skeleton className="rounded-lg h-64" />
      </div>
    )
  }

  if (!employee) {
    return <p className="text-muted-foreground">{t('detail_not_found')}</p>
  }

  const bankName = lookupBankByClearing(clearing)
  // One verdict for the pair, from the definition the payment files use: an
  // account is judged together with its clearing, never on its own.
  const bankIssues = validateEmployeeBankAccount(clearing, account)
  const accountFormatIssue = bankIssues.some((i) => i.code === 'account_format')
  const showChecksumWarning =
    !bankFocused &&
    bankIssues.length === 0 &&
    checkEmployeeAccountChecksum(clearing, account) === 'invalid'

  // Saved (not in-progress) values for the read view.
  const savedBankName = lookupBankByClearing(employee.clearing_number || '')
  const bankMissing = !employee.clearing_number || !employee.bank_account_number
  // A saved pair from before the shared definition may name no payable
  // account. Say so here, long before the payment file refuses it on payday.
  const bankInvalid =
    !bankMissing &&
    validateEmployeeBankAccount(employee.clearing_number, employee.bank_account_number).length > 0
  const savedDimensions = employee.default_dimensions ?? {}
  const savedDimensionLabel = Object.keys(savedDimensions)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => savedDimensions[k])
    .join(' · ')
  // Under five workdays a week the paid days are taken as fewer days off
  // (25 paid days are 20 days off at four days a week, semesterlagen 12 a §).
  const vacationDaysOff = daysOffPerYear(employee.vacation_days_per_year, employee.workdays_per_week)
  const sammaloneregelnChoice = pendingSammaloneregelnChange()
  const salaryValue =
    employee.salary_type === 'hourly'
      ? employee.hourly_rate != null
        ? formatCurrency(employee.hourly_rate)
        : null
      : employee.monthly_salary != null
        ? formatCurrency(employee.monthly_salary)
        : null
  const fSkattVerifiedLabel = employee.f_skatt_verified_at
    ? t('detail_f_skatt_verified', { date: new Date(employee.f_skatt_verified_at).toLocaleDateString('sv-SE') })
    : null

  return (
    <div className="space-y-8 stagger-enter">
      {/* Header: serif name over a quiet personnummer/type kicker, quiet actions right */}
      <div>
        <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="page-header-lead min-w-0">
            <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <p className="page-header-meta mt-1 text-sm text-muted-foreground">
              <span className="tabular-nums">{employee.personnummer_masked}</span>
              {' · '}
              {t(EMPLOYMENT_LABEL_KEYS[employee.employment_type])}
              {!employee.is_active && (
                <>
                  {' · '}
                  <span className="text-foreground">{t('detail_inactive')}</span>
                </>
              )}
            </p>
          </div>

          {canWrite && (
            <div className="page-header-action flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={openEdit}
                className="text-muted-foreground hover:text-foreground"
              >
                {t('detail_edit')}
              </Button>
              {employee.is_active ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDeactivate}
                  disabled={deactivating}
                  className="text-muted-foreground hover:text-destructive"
                >
                  {t('detail_deactivate')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleReactivate}
                  loading={reactivating}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {t('detail_reactivate')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <DetailSection kicker={t('form_personal_info')}>
        <DefRow label={t('form_email')}>
          {employee.email ? (
            <a href={`mailto:${employee.email}`} className="hover:underline">
              {employee.email}
            </a>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('form_phone')}>{employee.phone || <DefEmpty />}</DefRow>
        <DefRow label={t('form_address')}>
          {employee.address_line1 || employee.city ? (
            <div>
              {employee.address_line1 && <p>{employee.address_line1}</p>}
              {(employee.postal_code || employee.city) && (
                <p>{[employee.postal_code, employee.city].filter(Boolean).join(' ')}</p>
              )}
            </div>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
      </DetailSection>

      <DetailSection kicker={t('form_employment_salary')}>
        {employee.employment_type === 'employee' && (
          <DefRow label={t('form_personnel_category')}>
            {t(
              employee.personnel_category === 'arbetare'
                ? 'form_personnel_category_arbetare'
                : 'form_personnel_category_tjansteman',
            )}
          </DefRow>
        )}
        {employee.employment_type === 'employee' && employee.fora_fok_id && (
          <DefRow label={t('form_fora_fok_id')}>
            <span className="tabular-nums">
              {t('detail_fora_code', {
                code: employee.fora_fok_id,
                date: employee.fora_fok_start_date ? formatDate(employee.fora_fok_start_date) : '',
              })}
            </span>
          </DefRow>
        )}
        <DefRow label={t('form_employment_start')}>
          {employee.employment_start ? (
            <span className="tabular-nums">{formatDate(employee.employment_start)}</span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('form_employment_end')}>
          {employee.employment_end ? (
            <span className="tabular-nums">{formatDate(employee.employment_end)}</span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('form_employment_degree')}>
          <span className="tabular-nums">{employee.employment_degree}</span>
        </DefRow>
        <DefRow label={t('form_hours_per_week')}>
          <span className="tabular-nums">{employee.hours_per_week ?? 40}</span>
        </DefRow>
        <DefRow label={t('form_workdays_per_week')}>
          <span className="tabular-nums">{employee.workdays_per_week ?? 5}</span>
        </DefRow>
        <DefRow label={t('form_salary_type')}>
          {employee.salary_type === 'hourly' ? t('form_salary_type_hourly') : t('form_salary_type_monthly')}
        </DefRow>
        <DefRow label={employee.salary_type === 'hourly' ? t('form_hourly_rate') : t('form_monthly_salary')}>
          {salaryValue ? <span className="tabular-nums">{salaryValue}</span> : <DefEmpty />}
        </DefRow>
        <DefRow label={t('form_vacation_rule')}>
          {VACATION_RULE_KEYS[employee.vacation_rule]
            ? t(VACATION_RULE_KEYS[employee.vacation_rule])
            : employee.vacation_rule}
        </DefRow>
        <DefRow label={t('form_vacation_days')}>
          <span className="tabular-nums">{employee.vacation_days_per_year}</span>
          {vacationDaysOff !== employee.vacation_days_per_year && (
            <span className="text-muted-foreground">
              {' · '}
              {t('detail_vacation_days_off', { days: vacationDaysOff, workdays: employee.workdays_per_week ?? 5 })}
            </span>
          )}
        </DefRow>
        {employee.vacation_pay_rate != null && (
          <DefRow label={t('form_vacation_pay_rate')}>
            <span className="tabular-nums">{vacationPayRateToPercent(employee.vacation_pay_rate)} %</span>
          </DefRow>
        )}
        {employee.vacation_rule === 'sammaloneregeln' && (
          <DefRow label={t('form_semestertillagg_rate')}>
            <span className="tabular-nums">{semestertillaggRateToPercent(employee.semestertillagg_rate)} %</span>
          </DefRow>
        )}
        {dimensionsEnabled && (
          <DefRow label={t('form_dimensions_title')}>
            {savedDimensionLabel ? (
              <span data-ph-mask="">{savedDimensionLabel}</span>
            ) : (
              <DefEmpty />
            )}
          </DefRow>
        )}
      </DetailSection>

      <DetailSection
        kicker={t('tax_title')}
        aside={
          fSkattVerifiedLabel ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">{fSkattVerifiedLabel}</span>
          ) : undefined
        }
      >
        <DefRow label={t('tax_form_label')}>
          {F_SKATT_LABELS[employee.f_skatt_status] ?? t('tax_status_not_verified')}
          {employee.is_sidoinkomst && (
            <span className="text-muted-foreground">{' · '}{t('tax_sidoinkomst_label')}</span>
          )}
        </DefRow>
        <DefRow label={t('tax_municipality_label')}>{employee.tax_municipality || <DefEmpty />}</DefRow>
        <DefRow label={t('tax_table_label')}>
          {employee.tax_table_number != null ? (
            <span className="tabular-nums">{employee.tax_table_number}</span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('tax_column_label')}>
          <span className="tabular-nums">{employee.tax_column}</span>
        </DefRow>
        <DefRow label={t('tax_jamkning_label')}>
          {employee.jamkning_percentage != null ? (
            <>
              <span className="tabular-nums">{employee.jamkning_percentage} %</span>
              {employee.jamkning_valid_from && employee.jamkning_valid_to && (
                <span className="text-muted-foreground">
                  {' · '}
                  {t('tax_jamkning_detail_period', {
                    from: formatDate(employee.jamkning_valid_from),
                    to: formatDate(employee.jamkning_valid_to),
                  })}
                </span>
              )}
            </>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('tax_extra_label')}>
          {employee.extra_tax_amount != null ? (
            <span className="tabular-nums">
              {t('tax_extra_detail_amount', { amount: formatCurrency(employee.extra_tax_amount) })}
            </span>
          ) : employee.extra_tax_percentage != null ? (
            <span className="tabular-nums">
              {t('tax_extra_detail_percentage', { percentage: employee.extra_tax_percentage })}
            </span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
      </DetailSection>

      <DetailSection kicker={t('form_bank_account')}>
        <DefRow label={t('form_clearing_number')}>
          {employee.clearing_number ? (
            <span className="tabular-nums">
              {employee.clearing_number}
              {savedBankName && <span className="text-muted-foreground">{' · '}{savedBankName}</span>}
            </span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        <DefRow label={t('form_account_number')}>
          {employee.bank_account_number ? (
            <span className="tabular-nums">{employee.bank_account_number}</span>
          ) : (
            <DefEmpty />
          )}
        </DefRow>
        {/* The one attention sentence on the page: a run cannot be approved
            without bank details (the hint that used to sit under the form). */}
        {bankMissing && (
          <AttnLine
            className="mt-2"
            action={canWrite ? { label: t('detail_edit'), onClick: openEdit } : undefined}
          >
            {t('detail_bank_missing')}
          </AttnLine>
        )}
        {bankInvalid && (
          <AttnLine
            className="mt-2"
            action={canWrite ? { label: t('detail_edit'), onClick: openEdit } : undefined}
          >
            {t('detail_bank_invalid')}
          </AttnLine>
        )}
      </DetailSection>

      {/* Self-saving sections. These live OUTSIDE the employee form on purpose:
          benefits and opening balances write to their own endpoints, so the
          "Spara ändringar" in the edit dialog never touches them. */}
      <EmployeeBenefitsPanel employeeId={id} canWrite={canWrite} />
      <EmployeeRecurringLinesPanel
        employeeId={id}
        canWrite={canWrite}
        employmentType={employee.employment_type}
        personnelCategory={employee.personnel_category}
      />
      <OpeningBalancesPanel employeeId={id} canWrite={canWrite} />

      <DestructiveConfirmDialog {...dialogProps} />

      {/* Edit dialog: the employee form, sectioned by hairline dividers like
          NewEmployeeDialog. Closing is explicit (header X or Avbryt): the
          municipality combobox and dimension pickers portal outside the
          dialog, so a backdrop click or stray Escape must not discard edits. */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent
          className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
            <DialogTitle>{t('detail_edit_dialog_title')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <div className="divide-y divide-border">
                {/* Person & kontakt - name, contact, and address */}
                <section className="space-y-4 py-4 first:pt-0">
                  <h3 className={SECTION_HEADER}>{t('form_personal_info')}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="first_name">{t('form_first_name')}<RequiredMark /></Label>
                      <Input id="first_name" name="first_name" defaultValue={employee.first_name} required disabled={!canWrite} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="last_name">{t('form_last_name')}<RequiredMark /></Label>
                      <Input id="last_name" name="last_name" defaultValue={employee.last_name} required disabled={!canWrite} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="email">{t('form_email')}</Label>
                      <Input id="email" name="email" type="email" defaultValue={employee.email || ''} disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('form_email_hint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="phone">{t('form_phone')}</Label>
                      <Input id="phone" name="phone" defaultValue={employee.phone || ''} disabled={!canWrite} />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="address_line1">{t('form_street_address')}</Label>
                      <Input id="address_line1" name="address_line1" defaultValue={employee.address_line1 || ''} disabled={!canWrite} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="postal_code">{t('form_postal_code')}</Label>
                      <Input id="postal_code" name="postal_code" defaultValue={employee.postal_code || ''} className="max-w-[160px]" disabled={!canWrite} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="city">{t('form_city')}</Label>
                      <Input id="city" name="city" defaultValue={employee.city || ''} disabled={!canWrite} />
                    </div>
                  </div>
                </section>

                {/* Anställning & lön - employment terms, salary, and vacation together */}
                <section className="space-y-4 py-4">
                  <h3 className={SECTION_HEADER}>{t('form_employment_salary')}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="employment_type">{t('form_employment_type')}</Label>
                      <Select value={employmentType} onValueChange={setEmploymentType} disabled={!canWrite}>
                        <SelectTrigger id="employment_type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="employee">{t('form_employment_type_employee')}</SelectItem>
                          <SelectItem value="company_owner">{t('form_employment_type_company_owner')}</SelectItem>
                          <SelectItem value="board_member">{t('form_employment_type_board_member')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {employmentType === 'employee' && (
                      <div className="space-y-2">
                        <Label htmlFor="personnel_category">{t('form_personnel_category')}</Label>
                        <Select value={personnelCategory} onValueChange={setPersonnelCategory} disabled={!canWrite}>
                          <SelectTrigger id="personnel_category">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="tjansteman">{t('form_personnel_category_tjansteman')}</SelectItem>
                            <SelectItem value="arbetare">{t('form_personnel_category_arbetare')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{t('form_personnel_category_hint')}</p>
                      </div>
                    )}
                    {employmentType === 'employee' && (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="fora_fok_id">{t('form_fora_fok_id')}</Label>
                          <Input
                            id="fora_fok_id"
                            name="fora_fok_id"
                            defaultValue={employee.fora_fok_id ?? ''}
                            placeholder="FOK306834"
                            autoCapitalize="characters"
                            maxLength={9}
                            disabled={!canWrite}
                          />
                          <p className="text-xs text-muted-foreground">{t('form_fora_fok_id_hint')}</p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="fora_fok_start_date">{t('form_fora_fok_start_date')}</Label>
                          <Input
                            id="fora_fok_start_date"
                            name="fora_fok_start_date"
                            type="date"
                            defaultValue={employee.fora_fok_start_date ?? ''}
                            disabled={!canWrite}
                          />
                          <p className="text-xs text-muted-foreground">{t('form_fora_fok_start_date_hint')}</p>
                        </div>
                      </>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="employment_degree">{t('form_employment_degree')}</Label>
                      <Input id="employment_degree" name="employment_degree" type="number" defaultValue={employee.employment_degree} min="1" max="100" onChange={(e) => setDegreeInput(e.target.value)} disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('form_employment_degree_hint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="hours_per_week">{t('form_hours_per_week')}</Label>
                      <Input id="hours_per_week" name="hours_per_week" type="number" defaultValue={employee.hours_per_week ?? 40} min="1" max="80" step="0.5" disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('form_work_schedule_hint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="workdays_per_week">{t('form_workdays_per_week')}</Label>
                      <Input id="workdays_per_week" name="workdays_per_week" type="number" defaultValue={employee.workdays_per_week ?? 5} min="1" max="7" step="0.01" disabled={!canWrite} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="salary_type">{t('form_salary_type')}<RequiredMark /></Label>
                      <Select value={salaryType} onValueChange={setSalaryType} disabled={!canWrite}>
                        <SelectTrigger id="salary_type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="monthly">{t('form_salary_type_monthly')}</SelectItem>
                          <SelectItem value="hourly">{t('form_salary_type_hourly')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="employment_start">{t('form_employment_start')}<RequiredMark /></Label>
                      <Input id="employment_start" name="employment_start" type="date" defaultValue={employee.employment_start || ''} required disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('detail_employment_start_hint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="employment_end">{t('form_employment_end')}</Label>
                      <Input id="employment_end" name="employment_end" type="date" defaultValue={employee.employment_end || ''} disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('detail_employment_end_hint')}</p>
                    </div>
                    {salaryType === 'monthly' ? (
                      <div className="space-y-2">
                        <Label htmlFor="monthly_salary">{t('form_monthly_salary')}<RequiredMark /></Label>
                        <Input id="monthly_salary" name="monthly_salary" type="number" step="1" min="1" defaultValue={employee.monthly_salary || ''} required disabled={!canWrite} />
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label htmlFor="hourly_rate">{t('form_hourly_rate')}<RequiredMark /></Label>
                        <Input id="hourly_rate" name="hourly_rate" type="number" step="0.01" min="0.01" defaultValue={employee.hourly_rate || ''} required disabled={!canWrite} />
                      </div>
                    )}
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="vacation_rule">{t('form_vacation_rule')}</Label>
                      <Select value={vacationRule} onValueChange={setVacationRule} disabled={!canWrite}>
                        <SelectTrigger id="vacation_rule">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="procentregeln">{t('form_vacation_rule_procentregeln')}</SelectItem>
                          <SelectItem value="sammaloneregeln">{t('form_vacation_rule_sammaloneregeln')}</SelectItem>
                          <SelectItem value="semesterersattning">{t('form_vacation_rule_semesterersattning')}</SelectItem>
                          <SelectItem value="none">{t('form_vacation_rule_none')}</SelectItem>
                        </SelectContent>
                      </Select>
                      {vacationRule === 'none' && (
                        <p className="text-xs text-muted-foreground">
                          {t('detail_vacation_none_hint')}
                        </p>
                      )}
                      {vacationRule === 'semesterersattning' && (
                        <p className="text-xs text-muted-foreground">
                          {t('form_vacation_semesterersattning_hint')}
                        </p>
                      )}
                      {sammaloneregelnChoice && (
                        <div className="space-y-2">
                          <AttnLine
                            action={
                              canWrite
                                ? { label: t('form_sammaloneregeln_degree_switch'), onClick: () => setVacationRule('procentregeln') }
                                : undefined
                            }
                          >
                            {t('form_sammaloneregeln_degree_changed', {
                              from: sammaloneregelnChoice.from,
                              to: sammaloneregelnChoice.to,
                            })}
                          </AttnLine>
                          <div className="flex items-start gap-2">
                            <Checkbox
                              id="sammaloneregeln_kollektivavtal"
                              checked={kollektivavtalConfirmed}
                              onCheckedChange={(checked) => setKollektivavtalConfirmed(checked === true)}
                              disabled={!canWrite}
                              className="mt-0.5"
                            />
                            <Label htmlFor="sammaloneregeln_kollektivavtal" className="text-xs font-normal leading-5 text-muted-foreground">
                              {t('form_sammaloneregeln_kollektivavtal_confirm')}
                            </Label>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="vacation_days_per_year">{t('form_vacation_days')}</Label>
                      <Input
                        id="vacation_days_per_year"
                        name="vacation_days_per_year"
                        type="number"
                        min={vacationRule === 'none' ? 0 : 25}
                        max="40"
                        defaultValue={employee.vacation_days_per_year}
                        disabled={!canWrite}
                      />
                      <p className="text-xs text-muted-foreground">
                        {vacationRule === 'none' ? t('form_vacation_days_hint_none') : t('form_vacation_days_hint')}
                      </p>
                    </div>
                    {(vacationRule === 'procentregeln' || vacationRule === 'semesterersattning') && (
                      <div className="space-y-2">
                        <Label htmlFor="vacation_pay_rate">{t('form_vacation_pay_rate')}</Label>
                        <Input
                          id="vacation_pay_rate"
                          name="vacation_pay_rate"
                          type="number"
                          step="0.01"
                          min="12"
                          max="30"
                          placeholder="12"
                          defaultValue={vacationPayRateToPercent(employee.vacation_pay_rate)}
                          disabled={!canWrite}
                        />
                        <p className="text-xs text-muted-foreground">{t('form_vacation_pay_rate_hint')}</p>
                      </div>
                    )}
                    {vacationRule === 'sammaloneregeln' && (
                      <div className="space-y-2">
                        <Label htmlFor="semestertillagg_rate">{t('form_semestertillagg_rate')}</Label>
                        <Input
                          id="semestertillagg_rate"
                          name="semestertillagg_rate"
                          type="number"
                          step="0.001"
                          min="0"
                          max="5"
                          placeholder="0.43"
                          defaultValue={semestertillaggRateToPercent(employee.semestertillagg_rate)}
                          disabled={!canWrite}
                        />
                        <p className="text-xs text-muted-foreground">{t('form_semestertillagg_rate_hint')}</p>
                      </div>
                    )}
                  </div>
                </section>

                {/* Default dimensions (kostnadsställe/projekt) */}
                {dimensionsEnabled && (
                  <section className="space-y-2 py-4">
                    <h3 className={SECTION_HEADER}>{t('form_dimensions_title')}</h3>
                    <LineDimensionFields dimensions={dimensions} onChange={setDimension} disabled={!canWrite} />
                    <p className="text-xs text-muted-foreground">
                      {t('form_dimensions_hint')}
                    </p>
                  </section>
                )}

                {/* Tax. The masked personnummer is enough input here: EmployeeTaxCard
                    only reads the leading birthdate digits to suggest a tax column. */}
                <section className="space-y-4 py-4">
                  <h3 className={SECTION_HEADER}>{t('tax_title')}</h3>
                  <EmployeeTaxCard
                    personnummer={employee.personnummer_masked || ''}
                    disabled={!canWrite}
                    onChange={setTax}
                    flat
                    initial={{
                      f_skatt_status: employee.f_skatt_status || 'a_skatt',
                      is_sidoinkomst: employee.is_sidoinkomst || false,
                      tax_table_number: employee.tax_table_number ?? null,
                      tax_column: employee.tax_column ?? 1,
                      tax_municipality: employee.tax_municipality || '',
                      jamkning_percentage: employee.jamkning_percentage ?? null,
                      jamkning_valid_from: employee.jamkning_valid_from ?? null,
                      jamkning_valid_to: employee.jamkning_valid_to ?? null,
                      extra_tax_amount: employee.extra_tax_amount ?? null,
                      extra_tax_percentage: employee.extra_tax_percentage ?? null,
                    }}
                  />
                  {fSkattVerifiedLabel && (
                    <p className="text-xs text-muted-foreground">{fSkattVerifiedLabel}</p>
                  )}
                </section>

                {/* Bank */}
                <section className="space-y-4 py-4">
                  <h3 className={SECTION_HEADER}>{t('form_bank_account')}</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="clearing_number">{t('form_clearing_number')}</Label>
                      <Input
                        id="clearing_number"
                        name="clearing_number"
                        inputMode="numeric"
                        value={clearing}
                        onChange={(e) => setClearing(e.target.value)}
                        onFocus={() => setBankFocused(true)}
                        onBlur={() => setBankFocused(false)}
                        disabled={!canWrite}
                        aria-invalid={clearing !== '' && !isValidClearing(normalizeBankNumber(clearing))}
                      />
                      {clearing !== '' && !isValidClearing(normalizeBankNumber(clearing)) ? (
                        <p className="text-xs text-destructive">{t('bank_error_clearing_format')}</p>
                      ) : bankName ? (
                        <p className="text-xs text-muted-foreground">{bankName}</p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bank_account_number">{t('form_account_number')}</Label>
                      <Input
                        id="bank_account_number"
                        name="bank_account_number"
                        inputMode="numeric"
                        value={account}
                        onChange={(e) => setAccount(e.target.value)}
                        onFocus={() => setBankFocused(true)}
                        onBlur={() => setBankFocused(false)}
                        disabled={!canWrite}
                        aria-invalid={accountFormatIssue}
                      />
                      {accountFormatIssue && (
                        <p className="text-xs text-destructive">{t('bank_error_account_format')}</p>
                      )}
                    </div>
                  </div>
                  {showChecksumWarning && (
                    <p className="text-xs text-attn">{t('bank_warn_checksum')}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{t('form_bank_hint')}</p>
                </section>
              </div>
            </div>

            {/* Solid footer outside the scroll area: always visible, never
                overlaps content (the body above scrolls independently). */}
            <div className="flex justify-end gap-3 border-t border-border bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>
                {t('form_cancel')}
              </Button>
              <Button type="submit" disabled={saving || !canWrite}>
                <ArrowDownOnSquareIcon className="mr-2 h-4 w-4" />
                {saving ? t('form_saving') : t('detail_save_changes')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
