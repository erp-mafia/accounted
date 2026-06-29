'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Save } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import EmployeeTaxCard, { type EmployeeTaxValue } from '@/components/salary/EmployeeTaxCard'

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

export default function NewEmployeePage() {
  const router = useRouter()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [employmentType, setEmploymentType] = useState('employee')
  const [salaryType, setSalaryType] = useState('monthly')
  const [personnummer, setPersonnummer] = useState('')
  const [vacationRule, setVacationRule] = useState('procentregeln')
  const [tax, setTax] = useState<EmployeeTaxValue>({
    f_skatt_status: 'a_skatt',
    is_sidoinkomst: false,
    tax_table_number: null,
    tax_column: 1,
    tax_municipality: '',
  })

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)

    const form = new FormData(e.currentTarget)
    const body = {
      first_name: form.get('first_name') as string,
      last_name: form.get('last_name') as string,
      personnummer: personnummer.replace(/\D/g, ''),
      employment_type: employmentType,
      employment_start: form.get('employment_start') as string,
      employment_end: form.get('employment_end') as string || undefined,
      employment_degree: parseFloat(form.get('employment_degree') as string) || 100,
      salary_type: salaryType,
      monthly_salary: salaryType === 'monthly' ? (parseFloat(form.get('monthly_salary') as string) || undefined) : undefined,
      hourly_rate: salaryType === 'hourly' ? (parseFloat(form.get('hourly_rate') as string) || undefined) : undefined,
      f_skatt_status: tax.f_skatt_status,
      is_sidoinkomst: tax.is_sidoinkomst,
      tax_table_number: tax.tax_table_number ?? undefined,
      tax_column: tax.tax_column,
      tax_municipality: tax.tax_municipality || undefined,
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

    const res = await fetch('/api/salary/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      toast({ title: 'Anställd skapad' })
      router.push('/salary/employees')
    } else {
      const result = await res.json()
      toast({
        title: 'Kunde inte skapa anställd',
        description: getErrorMessage(result, { context: 'salary', statusCode: res.status }),
        variant: 'destructive',
      })
    }

    setSaving(false)
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/salary/employees" aria-label="Tillbaka till anställda"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">Ny anställd</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Personal info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Personuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first_name">Förnamn<RequiredMark /></Label>
                <Input id="first_name" name="first_name" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Efternamn<RequiredMark /></Label>
                <Input id="last_name" name="last_name" required />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="personnummer">Personnummer (12 siffror)<RequiredMark /></Label>
                <Input
                  id="personnummer"
                  name="personnummer"
                  placeholder="ÅÅÅÅMMDDNNNN"
                  required
                  maxLength={13}
                  value={personnummer}
                  onChange={(e) => setPersonnummer(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Krypteras vid lagring</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">E-post</Label>
                <Input id="email" name="email" type="email" />
                <p className="text-xs text-muted-foreground">Krävs för att skicka lönebesked</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Telefon</Label>
              <Input id="phone" name="phone" className="max-w-xs" />
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
              <Input id="address_line1" name="address_line1" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="postal_code">Postnummer</Label>
                <Input id="postal_code" name="postal_code" className="max-w-[160px]" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">Ort</Label>
                <Input id="city" name="city" />
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="employment_type">Typ</Label>
                <Select value={employmentType} onValueChange={setEmploymentType}>
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
                <Label htmlFor="employment_start">Anställningsdatum<RequiredMark /></Label>
                <Input id="employment_start" name="employment_start" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="employment_end">Slutdatum</Label>
                <Input id="employment_end" name="employment_end" type="date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="employment_degree">Sysselsättningsgrad (%)</Label>
                <Input id="employment_degree" name="employment_degree" type="number" defaultValue="100" min="1" max="100" />
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
                <Select value={salaryType} onValueChange={setSalaryType}>
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
                  <Input id="monthly_salary" name="monthly_salary" type="number" step="1" min="1" required />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="hourly_rate">Timlön (SEK)<RequiredMark /></Label>
                  <Input id="hourly_rate" name="hourly_rate" type="number" step="0.01" min="0.01" required />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tax */}
        <EmployeeTaxCard personnummer={personnummer} onChange={setTax} />

        {/* Vacation */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Semester</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="vacation_rule">Semesterregel</Label>
                <Select value={vacationRule} onValueChange={setVacationRule}>
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
                    Ingen avsättning till 2920 bokas. Vanligt för ägare som är enda anställd.
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
                <Input id="vacation_days_per_year" name="vacation_days_per_year" type="number" min="25" max="40" defaultValue="25" />
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
                <Input id="clearing_number" name="clearing_number" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank_account_number">Kontonummer</Label>
                <Input id="bank_account_number" name="bank_account_number" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">Krävs innan lönekörning kan godkännas</p>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" asChild>
            <Link href="/salary/employees">Avbryt</Link>
          </Button>
          <Button type="submit" disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? 'Sparar...' : 'Spara'}
          </Button>
        </div>
      </form>
    </div>
  )
}
