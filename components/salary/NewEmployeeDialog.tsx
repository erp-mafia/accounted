'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  validateEmployeeBankAccount,
  isValidClearing,
  isValidAccount,
  normalizeBankNumber,
  lookupBankByClearing,
  checkEmployeeAccountChecksum,
  BANK_ISSUE_MESSAGES_SV,
  BANK_CHECKSUM_WARNING_SV,
} from '@/lib/salary/payment/bank-account'
import EmployeeTaxCard, { type EmployeeTaxValue } from '@/components/salary/EmployeeTaxCard'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'

function RequiredMark() {
  return <span className="text-destructive ml-0.5">*</span>
}

// Small caps section label; sections are separated by a hairline divider
// instead of being boxed in their own cards (compact, Linear-style layout).
const SECTION_HEADER = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground'

/** Compact label + control stack shared by every field in the dialog. */
function Field({
  label,
  htmlFor,
  required,
  className,
  children,
}: {
  label: string
  htmlFor?: string
  required?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && <RequiredMark />}
      </Label>
      {children}
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful create. Hosts close the dialog and refresh their list. */
  onCreated: () => void
}

/**
 * "Ny anställd" as a modal: mirrors NewSupplierInvoiceDialog. The last
 * register entity (after customers/suppliers/articles) to move off a full
 * page. Compact layout: borderless sections split by hairline dividers
 * (no per-section cards) with a sticky Spara bar, to keep scrolling short.
 */
export default function NewEmployeeDialog({ open, onOpenChange, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Override the primitive's own padding + whole-dialog scroll: this
        // dialog is a fixed header + scrolling body + solid footer (flex
        // column), so the footer never overlaps scrolling content.
        className="sm:max-w-3xl max-h-[95dvh] sm:max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden"
        // A half-typed employee must survive an accidental backdrop click or
        // a stray Escape (the municipality combobox and dimension pickers
        // portal outside the dialog). Closing is explicit: the header X or
        // Avbryt. Same convention as NewJournalEntryDialog.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b border-border px-6 pb-4 pt-6">
          <DialogTitle>Ny anställd</DialogTitle>
        </DialogHeader>
        <NewEmployeeForm onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// Inner component so form state resets whenever the dialog reopens (Radix
// unmounts DialogContent children on close).
function NewEmployeeForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [employmentType, setEmploymentType] = useState('employee')
  const [salaryType, setSalaryType] = useState('monthly')
  const [personnummer, setPersonnummer] = useState('')
  const [vacationRule, setVacationRule] = useState('procentregeln')
  const [clearing, setClearing] = useState('')
  const [account, setAccount] = useState('')
  // Suppress the (soft) check-digit warning while the user is still typing in
  // the bank fields; only surface it once they move focus away.
  const [bankFocused, setBankFocused] = useState(false)
  // Default dimensions bag ({sie_dim_no: object_code}) proposed on the
  // employee's salary-cost lines at booking. The fields render only when
  // company_settings.dimensions_enabled: same UI gate as the voucher form.
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [dimensions, setDimensions] = useState<Record<string, string>>({})
  const [tax, setTax] = useState<EmployeeTaxValue>({
    f_skatt_status: 'a_skatt',
    is_sidoinkomst: false,
    tax_table_number: null,
    tax_column: 1,
    tax_municipality: '',
  })

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    // Block on structurally invalid bank details before hitting the server.
    const bankIssues = validateEmployeeBankAccount(clearing, account)
    if (bankIssues.length > 0) {
      toast({
        title: 'Kontrollera bankuppgifterna',
        description: bankIssues.map((i) => i.message).join('. '),
        variant: 'destructive',
      })
      return
    }

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
      clearing_number: normalizeBankNumber(clearing) || undefined,
      bank_account_number: normalizeBankNumber(account) || undefined,
      vacation_rule: vacationRule,
      vacation_days_per_year: parseInt(form.get('vacation_days_per_year') as string) || 25,
      // Always sent: {} means no default dimensions.
      default_dimensions: dimensions,
    }

    const res = await fetch('/api/salary/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (res.ok) {
      toast({ title: 'Anställd skapad' })
      onCreated()
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

  const bankName = lookupBankByClearing(clearing)
  const showChecksumWarning =
    !bankFocused &&
    validateEmployeeBankAccount(clearing, account).length === 0 &&
    checkEmployeeAccountChecksum(clearing, account) === 'invalid'

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="divide-y divide-border">
        {/* Personuppgifter */}
        <section className="space-y-3 py-4 first:pt-0">
          <h3 className={SECTION_HEADER}>Personuppgifter</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Förnamn" htmlFor="first_name" required>
              <Input id="first_name" name="first_name" required />
            </Field>
            <Field label="Efternamn" htmlFor="last_name" required>
              <Input id="last_name" name="last_name" required />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Personnummer" htmlFor="personnummer" required>
              <Input
                id="personnummer"
                name="personnummer"
                placeholder="ÅÅÅÅMMDDNNNN"
                required
                maxLength={13}
                value={personnummer}
                onChange={(e) => setPersonnummer(e.target.value)}
              />
            </Field>
            <Field label="E-post" htmlFor="email">
              <Input id="email" name="email" type="email" placeholder="Krävs för lönebesked" />
            </Field>
          </div>
          <Field label="Telefon" htmlFor="phone" className="max-w-xs">
            <Input id="phone" name="phone" />
          </Field>
        </section>

        {/* Adress */}
        <section className="space-y-3 py-4">
          <h3 className={SECTION_HEADER}>Adress</h3>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px_1fr] gap-3">
            <Field label="Gatuadress" htmlFor="address_line1">
              <Input id="address_line1" name="address_line1" />
            </Field>
            <Field label="Postnummer" htmlFor="postal_code">
              <Input id="postal_code" name="postal_code" />
            </Field>
            <Field label="Ort" htmlFor="city">
              <Input id="city" name="city" />
            </Field>
          </div>
        </section>

        {/* Anställning & lön */}
        <section className="space-y-3 py-4">
          <h3 className={SECTION_HEADER}>Anställning &amp; lön</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Field label="Typ" htmlFor="employment_type">
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
            </Field>
            <Field label="Anställningsdatum" htmlFor="employment_start" required>
              <Input id="employment_start" name="employment_start" type="date" required />
            </Field>
            <Field label="Slutdatum" htmlFor="employment_end">
              <Input id="employment_end" name="employment_end" type="date" />
            </Field>
            <Field label="Sysselsättningsgrad (%)" htmlFor="employment_degree">
              <Input id="employment_degree" name="employment_degree" type="number" defaultValue="100" min="1" max="100" />
            </Field>
            <Field label="Löneform" htmlFor="salary_type" required>
              <Select value={salaryType} onValueChange={setSalaryType}>
                <SelectTrigger id="salary_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Månadslön</SelectItem>
                  <SelectItem value="hourly">Timlön</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {salaryType === 'monthly' ? (
              <Field label="Månadslön (brutto)" htmlFor="monthly_salary" required>
                <Input id="monthly_salary" name="monthly_salary" type="number" step="1" min="1" required />
              </Field>
            ) : (
              <Field label="Timlön (SEK)" htmlFor="hourly_rate" required>
                <Input id="hourly_rate" name="hourly_rate" type="number" step="0.01" min="0.01" required />
              </Field>
            )}
          </div>
        </section>

        {/* Skatt */}
        <section className="space-y-3 py-4">
          <h3 className={SECTION_HEADER}>Skatt</h3>
          <EmployeeTaxCard personnummer={personnummer} onChange={setTax} flat />
        </section>

        {/* Semester */}
        <section className="space-y-3 py-4">
          <h3 className={SECTION_HEADER}>Semester</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Semesterregel" htmlFor="vacation_rule">
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
                  12 % läggs på varje lönekörning och bokas mot 7285. Ingen semesterlöneskuld byggs upp. Vanligt för tim- och visstidsanställda.
                </p>
              )}
            </Field>
            <Field label="Semesterdagar per år" htmlFor="vacation_days_per_year">
              <Input id="vacation_days_per_year" name="vacation_days_per_year" type="number" min="25" max="40" defaultValue="25" />
              <p className="text-xs text-muted-foreground">Lagstadgat minimum: 25 dagar</p>
            </Field>
          </div>
        </section>

        {/* Kostnadsställe / Projekt (standard) */}
        {dimensionsEnabled && (
          <section className="space-y-3 py-4">
            <h3 className={SECTION_HEADER}>Kostnadsställe / Projekt</h3>
            <LineDimensionFields dimensions={dimensions} onChange={setDimension} />
            <p className="text-xs text-muted-foreground">
              Föreslås på lönekostnadsrader vid bokföring av lönekörningar.
            </p>
          </section>
        )}

        {/* Bankkonto */}
        <section className="space-y-3 py-4">
          <h3 className={SECTION_HEADER}>Bankkonto</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Clearingnummer" htmlFor="clearing_number">
              <Input
                id="clearing_number"
                name="clearing_number"
                inputMode="numeric"
                value={clearing}
                onChange={(e) => setClearing(e.target.value)}
                onFocus={() => setBankFocused(true)}
                onBlur={() => setBankFocused(false)}
                aria-invalid={clearing !== '' && !isValidClearing(normalizeBankNumber(clearing))}
              />
              {clearing !== '' && !isValidClearing(normalizeBankNumber(clearing)) ? (
                <p className="text-xs text-destructive">{BANK_ISSUE_MESSAGES_SV.clearing_format}</p>
              ) : bankName ? (
                <p className="text-xs text-muted-foreground">{bankName}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Krävs innan lönekörning</p>
              )}
            </Field>
            <Field label="Kontonummer" htmlFor="bank_account_number">
              <Input
                id="bank_account_number"
                name="bank_account_number"
                inputMode="numeric"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                onFocus={() => setBankFocused(true)}
                onBlur={() => setBankFocused(false)}
                aria-invalid={account !== '' && !isValidAccount(normalizeBankNumber(account))}
              />
              {account !== '' && !isValidAccount(normalizeBankNumber(account)) && (
                <p className="text-xs text-destructive">{BANK_ISSUE_MESSAGES_SV.account_format}</p>
              )}
            </Field>
          </div>
          {showChecksumWarning && (
            <p className="text-xs text-warning-foreground">{BANK_CHECKSUM_WARNING_SV}</p>
          )}
        </section>
        </div>
      </div>

      {/* Solid footer outside the scroll area: always visible, never overlaps
          content (the body above scrolls independently). */}
      <div className="flex justify-end gap-3 border-t border-border bg-background px-6 py-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Avbryt
        </Button>
        <Button type="submit" disabled={saving}>
          <Save className="mr-2 h-4 w-4" />
          {saving ? 'Sparar...' : 'Spara'}
        </Button>
      </div>
    </form>
  )
}
