'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Save, Trash2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  validateEmployeeBankAccount,
  isValidClearing,
  isValidAccount,
  normalizeBankNumber,
  lookupBankByClearing,
  checkEmployeeAccountChecksum,
} from '@/lib/salary/payment/bank-account'
import type { Employee } from '@/types'
import { EmployeeBenefitsPanel } from '@/components/salary/EmployeeBenefitsPanel'
import EmployeeTaxCard, { type EmployeeTaxValue } from '@/components/salary/EmployeeTaxCard'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'

const EMPLOYMENT_LABEL_KEYS: Record<string, string> = {
  employee: 'form_employment_type_employee',
  company_owner: 'form_employment_type_company_owner',
  board_member: 'form_employment_type_board_member',
}

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('salary_employee')
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
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
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [dimensions, setDimensions] = useState<Record<string, string>>({})

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/salary/employees/${id}`)
      if (res.ok) {
        const { data } = await res.json()
        setEmployee(data)
        setEmploymentType(data.employment_type)
        setSalaryType(data.salary_type || 'monthly')
        setVacationRule(data.vacation_rule || 'procentregeln')
        setClearing(data.clearing_number || '')
        setAccount(data.bank_account_number || '')
        setDimensions(data.default_dimensions ?? {})
      }
      setLoading(false)
    }
    load()
  }, [id])

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then(({ data }) => setDimensionsEnabled(data?.dimensions_enabled === true))
      .catch(() => {/* keep the dimension fields hidden */})
  }, [])

  function setDimension(dimNo: string, code: string | null) {
    setDimensions((prev) => {
      const next = { ...prev }
      const value = code?.trim()
      if (value) next[dimNo] = value
      else delete next[dimNo]
      return next
    })
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
      employment_degree: parseFloat(form.get('employment_degree') as string) || 100,
      salary_type: salaryType,
      f_skatt_status: tax?.f_skatt_status,
      is_sidoinkomst: tax?.is_sidoinkomst,
      tax_table_number: tax?.tax_table_number ?? undefined,
      tax_column: tax?.tax_column ?? 1,
      tax_municipality: tax?.tax_municipality || undefined,
      email: form.get('email') as string || undefined,
      phone: form.get('phone') as string || undefined,
      address_line1: form.get('address_line1') as string || undefined,
      postal_code: form.get('postal_code') as string || undefined,
      city: form.get('city') as string || undefined,
      clearing_number: normalizeBankNumber(clearing) || undefined,
      bank_account_number: normalizeBankNumber(account) || undefined,
      vacation_rule: vacationRule,
      vacation_days_per_year: parseInt(form.get('vacation_days_per_year') as string) || 25,
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
    if (!confirm(t('detail_deactivate_confirm'))) return

    const res = await fetch(`/api/salary/employees/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: t('detail_deactivated') })
      router.push('/salary/employees')
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

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/salary/employees" aria-label={t('form_back_to_employees')}><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {employee.personnummer} · {t(EMPLOYMENT_LABEL_KEYS[employee.employment_type])}
            </p>
          </div>
        </div>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={handleDeactivate} className="text-destructive">
            <Trash2 className="mr-2 h-4 w-4" />
            {t('detail_deactivate')}
          </Button>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        {/* Person & kontakt - name, contact, and address in one dense card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('form_personal_info')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        {/* Anställning & lön - employment terms, salary, and vacation together */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('form_employment_salary')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
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
          </CardContent>
        </Card>

        {/* Default dimensions (kostnadsställe/projekt) */}
        {dimensionsEnabled && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t('form_dimensions_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <LineDimensionFields dimensions={dimensions} onChange={setDimension} disabled={!canWrite} />
              <p className="text-xs text-muted-foreground">
                {t('form_dimensions_hint')}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Tax */}
        <EmployeeTaxCard
          personnummer={employee.personnummer || ''}
          disabled={!canWrite}
          onChange={setTax}
          initial={{
            f_skatt_status: employee.f_skatt_status || 'a_skatt',
            is_sidoinkomst: employee.is_sidoinkomst || false,
            tax_table_number: employee.tax_table_number ?? null,
            tax_column: employee.tax_column ?? 1,
            tax_municipality: employee.tax_municipality || '',
          }}
        />
        {employee.f_skatt_verified_at && (
          <p className="-mt-2 text-xs text-muted-foreground">
            {t('detail_f_skatt_verified', { date: new Date(employee.f_skatt_verified_at).toLocaleDateString('sv-SE') })}
          </p>
        )}

        {/* Bank */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('form_bank_account')}</CardTitle>
          </CardHeader>
          <CardContent>
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
              <p className="mt-2 text-xs text-warning-foreground">{t('bank_warn_checksum')}</p>
            )}
            <p className="text-xs text-muted-foreground mt-2">{t('form_bank_hint')}</p>
          </CardContent>
        </Card>

        {/* Benefits */}
        <EmployeeBenefitsPanel employeeId={id} canWrite={canWrite} />

        {canWrite && (
          <div className="flex justify-end gap-3">
            <Button variant="outline" asChild>
              <Link href="/salary/employees">{t('form_cancel')}</Link>
            </Button>
            <Button type="submit" disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? t('form_saving') : t('detail_save_changes')}
            </Button>
          </div>
        )}
      </form>
    </div>
  )
}
