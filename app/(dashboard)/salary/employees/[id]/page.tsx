'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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
import type { Employee } from '@/types'
import { EmployeeBenefitsPanel } from '@/components/salary/EmployeeBenefitsPanel'
import EmployeeTaxCard, { type EmployeeTaxValue } from '@/components/salary/EmployeeTaxCard'

const EMPLOYMENT_LABELS: Record<string, string> = {
  employee: 'Anställd',
  company_owner: 'Företagsledare',
  board_member: 'Styrelseledamot',
}

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [employmentType, setEmploymentType] = useState('employee')
  const [salaryType, setSalaryType] = useState('monthly')
  const [vacationRule, setVacationRule] = useState('procentregeln')
  const [tax, setTax] = useState<EmployeeTaxValue | null>(null)

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/salary/employees/${id}`)
      if (res.ok) {
        const { data } = await res.json()
        setEmployee(data)
        setEmploymentType(data.employment_type)
        setSalaryType(data.salary_type || 'monthly')
        setVacationRule(data.vacation_rule || 'procentregeln')
      }
      setLoading(false)
    }
    load()
  }, [id])

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
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
      clearing_number: form.get('clearing_number') as string || undefined,
      bank_account_number: form.get('bank_account_number') as string || undefined,
      vacation_rule: vacationRule,
      vacation_days_per_year: parseInt(form.get('vacation_days_per_year') as string) || 25,
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
      toast({ title: 'Anställd uppdaterad' })
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte uppdatera anställd',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }

    setSaving(false)
  }

  async function handleDeactivate() {
    if (!confirm('Vill du inaktivera denna anställd?')) return

    const res = await fetch(`/api/salary/employees/${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: 'Anställd inaktiverad' })
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
    return <p className="text-muted-foreground">Anställd hittades inte</p>
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/salary/employees" aria-label="Tillbaka till anställda"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {employee.personnummer} · {EMPLOYMENT_LABELS[employee.employment_type]}
            </p>
          </div>
        </div>
        {canWrite && (
          <Button variant="outline" size="sm" onClick={handleDeactivate} className="text-destructive">
            <Trash2 className="mr-2 h-4 w-4" />
            Inaktivera
          </Button>
        )}
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Personal info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Personuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first_name">Förnamn<RequiredMark /></Label>
                <Input id="first_name" name="first_name" defaultValue={employee.first_name} required disabled={!canWrite} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Efternamn<RequiredMark /></Label>
                <Input id="last_name" name="last_name" defaultValue={employee.last_name} required disabled={!canWrite} />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="email">E-post</Label>
                <Input id="email" name="email" type="email" defaultValue={employee.email || ''} disabled={!canWrite} />
                <p className="text-xs text-muted-foreground">Krävs för att skicka lönebesked</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Telefon</Label>
                <Input id="phone" name="phone" defaultValue={employee.phone || ''} disabled={!canWrite} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Address */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Adress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="address_line1">Gatuadress</Label>
              <Input id="address_line1" name="address_line1" defaultValue={employee.address_line1 || ''} disabled={!canWrite} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="postal_code">Postnummer</Label>
                <Input id="postal_code" name="postal_code" defaultValue={employee.postal_code || ''} className="max-w-[160px]" disabled={!canWrite} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">Ort</Label>
                <Input id="city" name="city" defaultValue={employee.city || ''} disabled={!canWrite} />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Employment */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Anställning</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="employment_type">Typ</Label>
                <Select value={employmentType} onValueChange={setEmploymentType} disabled={!canWrite}>
                  <SelectTrigger id="employment_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">Anställd</SelectItem>
                    <SelectItem value="company_owner">Företagsledare</SelectItem>
                    <SelectItem value="board_member">Styrelseledamot</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="employment_degree">Sysselsättningsgrad (%)</Label>
                <Input id="employment_degree" name="employment_degree" type="number" defaultValue={employee.employment_degree} min="1" max="100" disabled={!canWrite} />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="employment_start">Anställningsdatum<RequiredMark /></Label>
                <Input id="employment_start" name="employment_start" type="date" defaultValue={employee.employment_start || ''} required disabled={!canWrite} />
                <p className="text-xs text-muted-foreground">Lönen proportioneras automatiskt om anställningen börjar eller slutar mitt i en löneperiod.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="employment_end">Slutdatum</Label>
                <Input id="employment_end" name="employment_end" type="date" defaultValue={employee.employment_end || ''} disabled={!canWrite} />
                <p className="text-xs text-muted-foreground">Lämna tomt för pågående anställning.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Salary */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lön</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="salary_type">Löneform<RequiredMark /></Label>
                <Select value={salaryType} onValueChange={setSalaryType} disabled={!canWrite}>
                  <SelectTrigger id="salary_type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Månadslön</SelectItem>
                    <SelectItem value="hourly">Timlön</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {salaryType === 'monthly' ? (
                <div className="space-y-2">
                  <Label htmlFor="monthly_salary">Månadslön (brutto, SEK)<RequiredMark /></Label>
                  <Input id="monthly_salary" name="monthly_salary" type="number" step="1" min="1" defaultValue={employee.monthly_salary || ''} required disabled={!canWrite} />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="hourly_rate">Timlön (SEK)<RequiredMark /></Label>
                  <Input id="hourly_rate" name="hourly_rate" type="number" step="0.01" min="0.01" defaultValue={employee.hourly_rate || ''} required disabled={!canWrite} />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

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
            F-skatt verifierad: {new Date(employee.f_skatt_verified_at).toLocaleDateString('sv-SE')}
          </p>
        )}

        {/* Vacation */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Semester</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vacation_rule">Semesterregel</Label>
                <Select value={vacationRule} onValueChange={setVacationRule} disabled={!canWrite}>
                  <SelectTrigger id="vacation_rule">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="procentregeln">Procentregeln (12 %)</SelectItem>
                    <SelectItem value="sammaloneregeln">Sammalöneregeln</SelectItem>
                    <SelectItem value="semesterersattning">Semesterersättning (betalas ut direkt)</SelectItem>
                    <SelectItem value="none">Ingen semesteravsättning</SelectItem>
                  </SelectContent>
                </Select>
                {vacationRule === 'none' && (
                  <p className="text-xs text-muted-foreground">
                    Ingen avsättning till 2920 bokas. Använd om semester ingår i månadslönen — vanligt för ägare som är enda anställd.
                  </p>
                )}
                {vacationRule === 'semesterersattning' && (
                  <p className="text-xs text-muted-foreground">
                    12 % läggs på varje lönekörning och bokas mot 7285. Ingen semesterlöneskuld byggs upp — vanligt för tim- och visstidsanställda.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="vacation_days_per_year">Semesterdagar per år</Label>
                <Input
                  id="vacation_days_per_year"
                  name="vacation_days_per_year"
                  type="number"
                  min="25"
                  max="40"
                  defaultValue={employee.vacation_days_per_year}
                  disabled={!canWrite}
                />
                <p className="text-xs text-muted-foreground">Lagstadgat minimum: 25 dagar</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Bank */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bankkonto</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="clearing_number">Clearingnummer</Label>
                <Input id="clearing_number" name="clearing_number" defaultValue={employee.clearing_number || ''} disabled={!canWrite} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank_account_number">Kontonummer</Label>
                <Input id="bank_account_number" name="bank_account_number" defaultValue={employee.bank_account_number || ''} disabled={!canWrite} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Krävs innan lönekörning kan godkännas</p>
          </CardContent>
        </Card>

        {/* Benefits */}
        <EmployeeBenefitsPanel employeeId={id} canWrite={canWrite} />

        {canWrite && (
          <div className="flex justify-end gap-3">
            <Button variant="outline" asChild>
              <Link href="/salary/employees">Avbryt</Link>
            </Button>
            <Button type="submit" disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Sparar...' : 'Spara ändringar'}
            </Button>
          </div>
        )}
      </form>
    </div>
  )
}
