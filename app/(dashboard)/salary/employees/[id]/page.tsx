'use client'

import { useState, useEffect, use } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { AttnLine } from '@/components/ui/attn-line'
import { ArrowLeft, Save } from 'lucide-react'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  validateEmployeeBankAccount,
  isValidClearing,
  isValidAccount,
  normalizeBankNumber,
  lookupBankByClearing,
  checkEmployeeAccountChecksum,
} from '@/lib/salary/payment/bank-account'
import type { EmployeeMasked } from '@/types'
import { EmployeeBenefitsPanel } from '@/components/salary/EmployeeBenefitsPanel'
import { OpeningBalancesPanel } from '@/components/salary/OpeningBalancesPanel'
import EmployeeTaxCard, { type EmployeeTaxValue } from '@/components/salary/EmployeeTaxCard'
import { jamkningPatch } from '@/lib/salary/jamkning-patch'
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
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [employmentType, setEmploymentType] = useState('employee')
  const [salaryType, setSalaryType] = useState('monthly')
  const [vacationRule, setVacationRule] = useState('procentregeln')
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
    setSalaryType(data.salary_type || 'monthly')
    setVacationRule(data.vacation_rule || 'procentregeln')
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

    setSaving(true)

    const form = new FormData(e.currentTarget)
    const body: Record<string, unknown> = {
      first_name: form.get('first_name') as string,
      last_name: form.get('last_name') as string,
      employment_type: employmentType,
      employment_start: form.get('employment_start') as string || undefined,
      employment_end: form.get('employment_end') as string || undefined,
      // Sparse patch: an empty/cleared field is OMITTED (undefined keys are
      // dropped by JSON.stringify) so the server's patch schema leaves the
      // column unchanged. Hardcoded fallbacks here would silently reset real
      // DB values on submit.
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
      email: form.get('email') as string || undefined,
      phone: form.get('phone') as string || undefined,
      address_line1: form.get('address_line1') as string || undefined,
      postal_code: form.get('postal_code') as string || undefined,
      city: form.get('city') as string || undefined,
      clearing_number: normalizeBankNumber(clearing) || undefined,
      bank_account_number: normalizeBankNumber(account) || undefined,
      vacation_rule: vacationRule,
      vacation_days_per_year: parseInt(form.get('vacation_days_per_year') as string) || undefined,
      // Always sent: {} clears the employee's default dimensions.
      default_dimensions: dimensions,
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
        toast({ title: t('detail_deactivated') })
        router.push('/salary/employees')
      }
    } finally {
      setDeactivating(false)
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
  const showChecksumWarning =
    !bankFocused &&
    validateEmployeeBankAccount(clearing, account).length === 0 &&
    checkEmployeeAccountChecksum(clearing, account) === 'invalid'

  // Saved (not in-progress) values for the read view.
  const savedBankName = lookupBankByClearing(employee.clearing_number || '')
  const bankMissing = !employee.clearing_number || !employee.bank_account_number
  const savedDimensions = employee.default_dimensions ?? {}
  const savedDimensionLabel = Object.keys(savedDimensions)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => savedDimensions[k])
    .join(' · ')
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
    <div className="max-w-2xl space-y-8 stagger-enter">
      {/* Header: serif name over a quiet personnummer/type kicker, quiet actions right */}
      <div>
        <Link
          href="/salary/employees"
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('form_back_to_employees')}
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-8 tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="tabular-nums">{employee.personnummer_masked}</span>
              {' · '}
              {t(EMPLOYMENT_LABEL_KEYS[employee.employment_type])}
            </p>
          </div>

          {canWrite && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={openEdit}
                className="min-h-10 text-muted-foreground hover:text-foreground"
              >
                {t('detail_edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDeactivate}
                disabled={deactivating}
                className="min-h-10 text-muted-foreground hover:text-destructive"
              >
                {t('detail_deactivate')}
              </Button>
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
        </DefRow>
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
      </DetailSection>

      {/* Self-saving sections. These live OUTSIDE the employee form on purpose:
          benefits and opening balances write to their own endpoints, so the
          "Spara ändringar" in the edit dialog never touches them. */}
      <EmployeeBenefitsPanel employeeId={id} canWrite={canWrite} />
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
                    <div className="space-y-2">
                      <Label htmlFor="employment_degree">{t('form_employment_degree')}</Label>
                      <Input id="employment_degree" name="employment_degree" type="number" defaultValue={employee.employment_degree} min="1" max="100" disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('form_employment_degree_hint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="hours_per_week">{t('form_hours_per_week')}</Label>
                      <Input id="hours_per_week" name="hours_per_week" type="number" defaultValue={employee.hours_per_week ?? 40} min="1" max="80" step="0.5" disabled={!canWrite} />
                      <p className="text-xs text-muted-foreground">{t('form_work_schedule_hint')}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="workdays_per_week">{t('form_workdays_per_week')}</Label>
                      <Input id="workdays_per_week" name="workdays_per_week" type="number" defaultValue={employee.workdays_per_week ?? 5} min="1" max="7" step="1" disabled={!canWrite} />
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
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="vacation_days_per_year">{t('form_vacation_days')}</Label>
                      <Input
                        id="vacation_days_per_year"
                        name="vacation_days_per_year"
                        type="number"
                        min="25"
                        max="40"
                        defaultValue={employee.vacation_days_per_year}
                        disabled={!canWrite}
                      />
                      <p className="text-xs text-muted-foreground">{t('form_vacation_days_hint')}</p>
                    </div>
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
                        aria-invalid={account !== '' && !isValidAccount(normalizeBankNumber(account))}
                      />
                      {account !== '' && !isValidAccount(normalizeBankNumber(account)) && (
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
                <Save className="mr-2 h-4 w-4" />
                {saving ? t('form_saving') : t('detail_save_changes')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
