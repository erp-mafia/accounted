'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { SsykCombobox } from '@/components/salary/SsykCombobox'
import { ARBETSTIDSART_OPTIONS } from '@/lib/salary/arbetstidsart'
import { ArrowLeft, Save } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

export default function NewEmployeePage() {
  const router = useRouter()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [employmentType, setEmploymentType] = useState('employee')
  const [salaryType, setSalaryType] = useState('monthly')
  const [fSkattStatus, setFSkattStatus] = useState('a_skatt')
  const [isSidoinkomst, setIsSidoinkomst] = useState(false)
  const [vacationRule, setVacationRule] = useState('procentregeln')
  const [workerCategory, setWorkerCategory] = useState('tjansteman')
  const [anstallningsform, setAnstallningsform] = useState('')
  const [arbetstidsart, setArbetstidsart] = useState('')

  const requiresTaxTable = fSkattStatus === 'a_skatt' && !isSidoinkomst

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)

    const form = new FormData(e.currentTarget)
    const body = {
      first_name: form.get('first_name') as string,
      last_name: form.get('last_name') as string,
      personnummer: (form.get('personnummer') as string).replace(/\D/g, ''),
      employment_type: employmentType,
      worker_category: workerCategory,
      ssyk_code: (form.get('ssyk_code') as string)?.trim() || undefined,
      cfar_number: (form.get('cfar_number') as string)?.trim() || undefined,
      arbetstidsart: arbetstidsart || undefined,
      anstallningsform: anstallningsform || undefined,
      employment_start: form.get('employment_start') as string,
      employment_degree: parseFloat(form.get('employment_degree') as string) || 100,
      salary_type: salaryType,
      monthly_salary: salaryType === 'monthly' ? (parseFloat(form.get('monthly_salary') as string) || undefined) : undefined,
      hourly_rate: salaryType === 'hourly' ? (parseFloat(form.get('hourly_rate') as string) || undefined) : undefined,
      f_skatt_status: fSkattStatus,
      is_sidoinkomst: isSidoinkomst,
      tax_table_number: parseInt(form.get('tax_table_number') as string) || undefined,
      tax_column: parseInt(form.get('tax_column') as string) || 1,
      tax_municipality: form.get('tax_municipality') as string || undefined,
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
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Ny anställd</h1>
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
                <Input id="personnummer" name="personnummer" placeholder="ÅÅÅÅMMDDNNNN" required maxLength={13} />
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
            <p className="mt-1 text-xs text-muted-foreground">
              Personalkategori, yrkeskod, CFAR-nummer, arbetstidsart och anställningsform används för den
              lagstadgade lönestatistiken till SCB och Svenskt Näringsliv (SLP och KLP). Fälten är frivilliga
              här men krävs för att statistikfilerna ska bli kompletta — saknade värden nollfylls.
            </p>
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
                <div className="flex items-center gap-2">
                  <Label htmlFor="worker_category">Personalkategori</Label>
                  <InfoTooltip content="Anger om den anställda är arbetare (kollektivanställd) eller tjänsteman. Styr indelningen i lönestatistiken till SCB (SLP) och Svenskt Näringsliv samt aggregeringen i konjunkturlönestatistiken (KLP)." />
                </div>
                <Select value={workerCategory} onValueChange={(v) => setWorkerCategory(v as 'arbetare' | 'tjansteman')}>
                  <SelectTrigger id="worker_category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tjansteman">Tjänsteman</SelectItem>
                    <SelectItem value="arbetare">Arbetare</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="ssyk_code">Yrkeskod (SSYK 2012)</Label>
                  <InfoTooltip content="Fyrställig kod enligt Standard för svensk yrkesklassificering (SSYK 2012) för den anställdas yrke. Sök på kod eller yrkestitel — alla 426 koder finns i listan. Krävs i lönestrukturstatistiken (SLP)." />
                </div>
                <SsykCombobox id="ssyk_code" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="cfar_number">CFAR-nummer</Label>
                  <InfoTooltip content="Arbetsställets identitet i SCB:s företagsregister (CFAR), åtta siffror. Identifierar det arbetsställe där personen arbetar. Hittas på SCB:s uppgiftslämnarsida eller i registerutdraget." />
                </div>
                <Input id="cfar_number" name="cfar_number" maxLength={8} inputMode="numeric" placeholder="Arbetsställe" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="arbetstidsart">Arbetstidsart</Label>
                  <InfoTooltip content="Skiftform enligt SCB. Redovisas endast för arbetsställen inom gruv- och tillverkningsindustrin — er blankett anger om fältet ska fyllas i. Lämna tomt om det inte är aktuellt." />
                </div>
                <input type="hidden" name="arbetstidsart" value={arbetstidsart} />
                <Select value={arbetstidsart} onValueChange={(v) => setArbetstidsart(v === '__none__' ? '' : v)}>
                  <SelectTrigger id="arbetstidsart">
                    <SelectValue placeholder="Ej aktuellt" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Ej aktuellt</SelectItem>
                    {ARBETSTIDSART_OPTIONS.map((o) => (
                      <SelectItem key={o.code} value={o.code}>{o.code} – {o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor="anstallningsform">Anställningsform</Label>
                  <InfoTooltip content="Om anställningen är tillsvidare eller tidsbegränsad (visstid). Redovisas i lönestrukturstatistiken (SLP)." />
                </div>
                <Select value={anstallningsform} onValueChange={setAnstallningsform}>
                  <SelectTrigger id="anstallningsform">
                    <SelectValue placeholder="Välj" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Tillsvidare</SelectItem>
                    <SelectItem value="2">Visstid</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="employment_start">Anställningsdatum<RequiredMark /></Label>
                <Input id="employment_start" name="employment_start" type="date" required />
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
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Skatt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="f_skatt_status">Skatteform</Label>
                <Select value={fSkattStatus} onValueChange={setFSkattStatus}>
                  <SelectTrigger id="f_skatt_status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a_skatt">A-skatt</SelectItem>
                    <SelectItem value="f_skatt">F-skatt</SelectItem>
                    <SelectItem value="fa_skatt">FA-skatt</SelectItem>
                    <SelectItem value="not_verified">Ej verifierad</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isSidoinkomst}
                    onChange={(e) => setIsSidoinkomst(e.target.checked)}
                    className="rounded border-border"
                  />
                  Sidoinkomst (30% skatteavdrag)
                </label>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tax_table_number">
                  Skattetabell (29-42){requiresTaxTable && <RequiredMark />}
                </Label>
                <Input
                  id="tax_table_number"
                  name="tax_table_number"
                  type="number"
                  min="29"
                  max="42"
                  required={requiresTaxTable}
                />
                <p className="text-xs text-muted-foreground">Baseras på folkbokföringskommun</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tax_column">Kolumn (1-6)</Label>
                <Input id="tax_column" name="tax_column" type="number" defaultValue="1" min="1" max="6" />
                <p className="text-xs text-muted-foreground">1 = standard under 66 år</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tax_municipality">
                  Folkbokföringskommun{requiresTaxTable && <RequiredMark />}
                </Label>
                <Input id="tax_municipality" name="tax_municipality" required={requiresTaxTable} />
              </div>
            </div>
          </CardContent>
        </Card>

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
