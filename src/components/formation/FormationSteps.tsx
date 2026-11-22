'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { PlusIcon, TrashIcon } from '@/components/icons'
import {
  BANKS,
  type BankId,
  type FormationAnswers,
  type FormationCompanyFounder,
  type FormationParty,
  type FormationPerson,
  MAX_FOUNDERS,
  MAX_NAME_PROPOSALS,
  type RoleKey,
  type SignatoryRule,
  boardMembers,
  founders,
  quotaValue,
} from '@/lib/formation/answers'
import type { FormationIssue } from '@/lib/formation/rules'
import { ChoiceGroup, FieldIssues, NumberField, StepSection, TextField, ToggleChips } from './FormationFields'

export interface StepProps {
  answers: FormationAnswers
  update: (next: FormationAnswers) => void
  issues: FormationIssue[]
}

const field = (issues: FormationIssue[], path: string) => issues.filter((i) => i.field === path)

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14)
}

function replaceParty(a: FormationAnswers, id: string, patch: Partial<FormationPerson> | Partial<FormationCompanyFounder>): FormationAnswers {
  return { ...a, parties: a.parties.map((p) => (p.id === id ? ({ ...p, ...patch } as FormationParty) : p)) }
}

function sharePercent(a: FormationAnswers, p: FormationParty): string {
  const total = founders(a).reduce((s, f) => s + f.shares, 0)
  if (total <= 0 || p.shares <= 0) return ''
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 }).format((p.shares / total) * 100)} %`
}

// ---------------------------------------------------------------------------
// 1. Bolaget
// ---------------------------------------------------------------------------

export function CompanyStep({ answers: a, update, issues }: StepProps) {
  const tc = useTranslations('formation.company')
  const names = a.names.length > 0 ? a.names : ['']
  return (
    <div className="space-y-8">
      <StepSection title={tc('names_title')} help={tc('names_help')}>
        {names.map((name, i) => (
          <div key={i} className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label={tc('name_label', { n: i + 1 })}
              value={name}
              placeholder={i === 0 ? tc('name_placeholder') : undefined}
              issues={field(issues, `names.${i}`)}
              onChange={(v) => update({ ...a, names: names.map((n, j) => (j === i ? v : n)) })}
              maxLength={120}
            />
            {names.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tc('name_remove', { n: i + 1 })}
                onClick={() => update({ ...a, names: names.filter((_, j) => j !== i) })}
                className="mb-0.5"
              >
                <TrashIcon className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        <FieldIssues issues={field(issues, 'names')} />
        {names.length < MAX_NAME_PROPOSALS && (
          <Button type="button" variant="outline" onClick={() => update({ ...a, names: [...names, ''] })}>
            <PlusIcon className="h-4 w-4" />
            {tc('name_add')}
          </Button>
        )}
      </StepSection>

      <StepSection title={tc('description_title')} help={tc('description_help')}>
        <div>
          <Label htmlFor="formation-description">{tc('description_label')}</Label>
          <div className="mt-1.5 flex flex-col gap-1.5">
            <span className="text-sm text-muted-foreground">{tc('description_prefix')}</span>
            <Textarea
              id="formation-description"
              rows={3}
              value={a.description}
              placeholder={tc('description_placeholder')}
              aria-invalid={field(issues, 'description').some((i) => i.severity === 'error') || undefined}
              onChange={(e) => update({ ...a, description: e.target.value })}
              maxLength={1000}
            />
          </div>
          <FieldIssues issues={field(issues, 'description')} />
        </div>
      </StepSection>

      <StepSection title={tc('address_title')} help={tc('address_help')}>
        <TextField label={tc('seat_label')} help={tc('seat_help')} value={a.seat} issues={field(issues, 'seat')} onChange={(v) => update({ ...a, seat: v })} />
        <TextField label={tc('street_label')} value={a.address.street} autoComplete="street-address" issues={field(issues, 'address.street')} onChange={(v) => update({ ...a, address: { ...a.address, street: v } })} />
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <TextField label={tc('postal_code_label')} inputMode="numeric" autoComplete="postal-code" value={a.address.postalCode} issues={field(issues, 'address.postalCode')} onChange={(v) => update({ ...a, address: { ...a.address, postalCode: v } })} maxLength={6} />
          <TextField label={tc('city_label')} autoComplete="address-level2" value={a.address.city} issues={field(issues, 'address.city')} onChange={(v) => update({ ...a, address: { ...a.address, city: v } })} />
        </div>
        <TextField label={tc('co_label')} optional value={a.address.co} onChange={(v) => update({ ...a, address: { ...a.address, co: v } })} />
        <TextField label={tc('company_email_label')} optional inputMode="email" value={a.companyEmail} issues={field(issues, 'companyEmail')} onChange={(v) => update({ ...a, companyEmail: v })} />
      </StepSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Ägare och aktier
// ---------------------------------------------------------------------------

export function OwnersStep({ answers: a, update, issues }: StepProps) {
  const to = useTranslations('formation.owners')
  const owners = a.parties.filter((p) => p.shares > 0 || (p.type === 'company') || (p.type === 'person' && p.roles.length === 0))
  const subscribed = founders(a).reduce((s, f) => s + f.shares, 0)
  const canAdd = founders(a).length < MAX_FOUNDERS && owners.length < MAX_FOUNDERS

  const addPerson = () => {
    const remaining = Math.max(0, a.capital.shares - subscribed)
    update({ ...a, parties: [...a.parties, { id: newId(), type: 'person', name: '', personnummer: '', email: '', shares: remaining, roles: ['ledamot'] }] })
  }
  const addCompany = () => {
    const remaining = Math.max(0, a.capital.shares - subscribed)
    update({ ...a, parties: [...a.parties, { id: newId(), type: 'company', name: '', orgNumber: '', signatories: [''], shares: remaining, controlledBy: [] }] })
  }
  const splitEvenly = () => {
    const fs = founders(a)
    if (fs.length === 0) return
    const base = Math.floor(a.capital.shares / fs.length)
    let rest = a.capital.shares - base * fs.length
    const ids = new Map(fs.map((f) => [f.id, base + (rest-- > 0 ? 1 : 0)]))
    update({ ...a, parties: a.parties.map((p) => (ids.has(p.id) ? ({ ...p, shares: ids.get(p.id)! } as FormationParty) : p)) })
  }

  return (
    <div className="space-y-8">
      <StepSection title={to('capital_title')} help={to('capital_help')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label={to('capital_label')} value={a.capital.amount} issues={field(issues, 'capital.amount')} onChange={(v) => update({ ...a, capital: { ...a.capital, amount: v ?? 0 } })} />
          <NumberField label={to('shares_label')} value={a.capital.shares} onChange={(v) => update({ ...a, capital: { ...a.capital, shares: Math.max(1, v ?? 1) } })} />
        </div>
        <p className="text-xs text-muted-foreground">{to('quota', { quota: new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(quotaValue(a)) })}</p>
      </StepSection>

      <StepSection title={to('owners_title')} help={to('owners_help')}>
        {owners.length === 0 && <p className="text-sm text-muted-foreground">{to('owners_empty')}</p>}
        {owners.map((p) => (
          <div key={p.id} className="space-y-3 border-t-hairline pt-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-strong">{p.type === 'company' ? to('company_owner') : to('person_owner')}</p>
              <div className="flex items-center gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">{sharePercent(a, p)}</span>
                <Button type="button" variant="ghost" size="icon" aria-label={to('remove_owner')} onClick={() => update({ ...a, parties: a.parties.filter((x) => x.id !== p.id) })}>
                  <TrashIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {p.type === 'person' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label={to('name_label')} mask autoComplete="name" value={p.name} issues={field(issues, `parties.${p.id}.name`)} onChange={(v) => update(replaceParty(a, p.id, { name: v }))} />
                <TextField
                  label={to('personnummer_label')}
                  mask
                  inputMode="numeric"
                  placeholder={p.personnummerLast4 ? to('personnummer_saved', { last4: p.personnummerLast4 }) : to('personnummer_placeholder')}
                  help={p.personnummerLast4 && !p.personnummer ? to('personnummer_saved_help') : undefined}
                  value={p.personnummer}
                  issues={field(issues, `parties.${p.id}.personnummer`)}
                  onChange={(v) => update(replaceParty(a, p.id, { personnummer: v }))}
                  maxLength={13}
                />
                <NumberField label={to('owner_shares_label')} value={p.shares} onChange={(v) => update(replaceParty(a, p.id, { shares: Math.max(0, v ?? 0) }))} />
                <TextField label={to('email_label')} optional inputMode="email" mask value={p.email} onChange={(v) => update(replaceParty(a, p.id, { email: v }))} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField label={to('company_name_label')} value={p.name} issues={field(issues, `parties.${p.id}.name`)} onChange={(v) => update(replaceParty(a, p.id, { name: v }))} />
                  <TextField label={to('org_number_label')} inputMode="numeric" placeholder="NNNNNN-NNNN" value={p.orgNumber} issues={field(issues, `parties.${p.id}.orgNumber`)} onChange={(v) => update(replaceParty(a, p.id, { orgNumber: v }))} maxLength={13} />
                  <NumberField label={to('owner_shares_label')} value={p.shares} onChange={(v) => update(replaceParty(a, p.id, { shares: Math.max(0, v ?? 0) }))} />
                  <TextField
                    label={to('company_signatory_label')}
                    help={to('company_signatory_help')}
                    mask
                    value={p.signatories[0] ?? ''}
                    issues={field(issues, `parties.${p.id}.signatories`)}
                    onChange={(v) => update(replaceParty(a, p.id, { signatories: [v] }))}
                  />
                </div>
                <TextField
                  label={to('controlled_by_label')}
                  help={to('controlled_by_help')}
                  mask
                  value={p.controlledBy.join(', ')}
                  issues={field(issues, `parties.${p.id}.controlledBy`)}
                  onChange={(v) => update(replaceParty(a, p.id, { controlledBy: v.split(',').map((s) => s.trimStart()) }))}
                />
              </div>
            )}
          </div>
        ))}
        <p className="text-xs tabular-nums text-muted-foreground">{to('shares_summary', { subscribed, total: a.capital.shares })}</p>
        <FieldIssues issues={[...field(issues, 'capital.shares'), ...field(issues, 'parties')]} />
        <div className="flex flex-wrap gap-2">
          {canAdd && (
            <Button type="button" variant="outline" onClick={addPerson}>
              <PlusIcon className="h-4 w-4" />
              {to('add_person')}
            </Button>
          )}
          {canAdd && (
            <Button type="button" variant="outline" onClick={addCompany}>
              <PlusIcon className="h-4 w-4" />
              {to('add_company')}
            </Button>
          )}
          {founders(a).length > 1 && (
            <Button type="button" variant="ghost" onClick={splitEvenly}>
              {to('split_evenly')}
            </Button>
          )}
        </div>
      </StepSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Styrelse
// ---------------------------------------------------------------------------

const ROLE_ORDER: RoleKey[] = ['ledamot', 'suppleant', 'ordforande', 'vd']

export function BoardStep({ answers: a, update, issues }: StepProps) {
  const tb = useTranslations('formation.board')
  const people = a.parties.filter((p): p is FormationPerson => p.type === 'person')
  const memberCount = boardMembers(a).length

  const toggle = (person: FormationPerson, role: RoleKey) => {
    let roles: RoleKey[] = person.roles.includes(role) ? person.roles.filter((r) => r !== role) : [...person.roles, role]
    if (role === 'ledamot' && roles.includes('ledamot')) roles = roles.filter((r) => r !== 'suppleant')
    if (role === 'suppleant' && roles.includes('suppleant')) roles = roles.filter((r) => r !== 'ledamot' && r !== 'ordforande')
    if (!roles.includes('ledamot')) roles = roles.filter((r) => r !== 'ordforande')
    update(replaceParty(a, person.id, { roles }))
  }
  const addPerson = () =>
    update({ ...a, parties: [...a.parties, { id: newId(), type: 'person', name: '', personnummer: '', email: '', shares: 0, roles: ['suppleant'] }] })

  return (
    <div className="space-y-8">
      <StepSection title={tb('board_title')} help={tb('board_help')}>
        {people.length === 0 && <p className="text-sm text-muted-foreground">{tb('board_empty')}</p>}
        {people.map((p) => (
          <div key={p.id} className="space-y-2.5 border-t-hairline pt-4">
            {p.shares > 0 ? (
              <p className="text-sm font-medium text-strong" data-ph-mask="">
                {p.name || tb('unnamed')}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{tb('owner_tag')}</span>
              </p>
            ) : (
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-3 sm:grid-cols-2">
                  <TextField label={tb('name_label')} mask value={p.name} issues={field(issues, `parties.${p.id}.name`)} onChange={(v) => update(replaceParty(a, p.id, { name: v }))} />
                  <TextField
                    label={tb('personnummer_label')}
                    mask
                    inputMode="numeric"
                    placeholder={p.personnummerLast4 ? tb('personnummer_saved', { last4: p.personnummerLast4 }) : tb('personnummer_placeholder')}
                    value={p.personnummer}
                    issues={field(issues, `parties.${p.id}.personnummer`)}
                    onChange={(v) => update(replaceParty(a, p.id, { personnummer: v }))}
                    maxLength={13}
                  />
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={tb('remove_person')} onClick={() => update({ ...a, parties: a.parties.filter((x) => x.id !== p.id) })} className="mb-0.5">
                  <TrashIcon className="h-4 w-4" />
                </Button>
              </div>
            )}
            <ToggleChips
              label={tb('roles_label', { name: p.name || tb('unnamed') })}
              value={p.roles}
              onToggle={(r) => toggle(p, r)}
              options={ROLE_ORDER.map((r) => ({
                value: r,
                label: tb(`role_${r}`),
                disabled: r === 'ordforande' && (!p.roles.includes('ledamot') || memberCount < 2),
              }))}
            />
            {p.shares > 0 && <FieldIssues issues={field(issues, `parties.${p.id}.personnummer`).filter((i) => i.step === 'board')} />}
          </div>
        ))}
        <FieldIssues issues={field(issues, 'roles')} />
        <Button type="button" variant="outline" onClick={addPerson}>
          <PlusIcon className="h-4 w-4" />
          {tb('add_person')}
        </Button>
      </StepSection>

      <StepSection title={tb('signatory_title')} help={tb('signatory_help')}>
        <ChoiceGroup<SignatoryRule>
          value={a.signatoryRule}
          onChange={(v) => update({ ...a, signatoryRule: v })}
          options={[
            { value: 'board', label: tb('signatory_board'), hint: tb('signatory_board_hint') },
            { value: 'board_or_each', label: tb('signatory_each'), hint: tb('signatory_each_hint') },
            ...(memberCount >= 2 ? [{ value: 'board_or_two' as const, label: tb('signatory_two'), hint: tb('signatory_two_hint') }] : []),
          ]}
        />
        <FieldIssues issues={field(issues, 'signatoryRule')} />
      </StepSection>

      <StepSection title={tb('auditor_title')} help={tb('auditor_help')}>
        <ChoiceGroup<'no' | 'yes'>
          columns={2}
          value={a.auditor.has ? 'yes' : 'no'}
          onChange={(v) => update({ ...a, auditor: { ...a.auditor, has: v === 'yes' } })}
          options={[
            { value: 'no', label: tb('auditor_no') },
            { value: 'yes', label: tb('auditor_yes') },
          ]}
        />
        {a.auditor.has && (
          <TextField label={tb('auditor_name_label')} value={a.auditor.name} issues={field(issues, 'auditor.name')} onChange={(v) => update({ ...a, auditor: { ...a.auditor, name: v } })} />
        )}
      </StepSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Detaljer: räkenskapsår, bank, skatt, kontakt
// ---------------------------------------------------------------------------

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const

export function DetailsStep({ answers: a, update, issues }: StepProps) {
  const td = useTranslations('formation.details')
  const months = useTranslations('formation.months')
  return (
    <div className="space-y-8">
      <StepSection title={td('fiscal_title')} help={td('fiscal_help')}>
        <ChoiceGroup<'calendar' | 'other'>
          columns={2}
          value={a.fiscalYearStartMonth === 1 ? 'calendar' : 'other'}
          onChange={(v) => update({ ...a, fiscalYearStartMonth: v === 'calendar' ? 1 : a.fiscalYearStartMonth === 1 ? 7 : a.fiscalYearStartMonth })}
          options={[
            { value: 'calendar', label: td('fiscal_calendar'), hint: td('fiscal_calendar_hint') },
            { value: 'other', label: td('fiscal_other'), hint: td('fiscal_other_hint') },
          ]}
        />
        {a.fiscalYearStartMonth !== 1 && (
          <div>
            <Label htmlFor="formation-fy-month">{td('fiscal_start_label')}</Label>
            <select
              id="formation-fy-month"
              className="mt-1.5 h-8 w-full rounded-lg bg-control px-2.5 text-sm shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 sm:w-56"
              value={a.fiscalYearStartMonth}
              onChange={(e) => update({ ...a, fiscalYearStartMonth: Number(e.target.value) })}
            >
              {MONTHS.filter((m) => m !== 1).map((m) => (
                <option key={m} value={m}>
                  {months(String(m))}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={a.extendFirstYear} onCheckedChange={(v) => update({ ...a, extendFirstYear: v === true })} />
          <span>
            <span className="block text-foreground">{td('extend_label')}</span>
            <span className="block text-xs text-muted-foreground">{td('extend_hint')}</span>
          </span>
        </label>
      </StepSection>

      <StepSection title={td('bank_title')} help={td('bank_help')}>
        <ChoiceGroup<BankId>
          columns={4}
          value={a.bank}
          onChange={(v) => update({ ...a, bank: v })}
          options={BANKS.map((b) => ({ value: b, label: td(`bank_${b}`) }))}
        />
        <FieldIssues issues={field(issues, 'bank')} />
      </StepSection>

      <StepSection title={td('tax_title')} help={td('tax_help')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label={td('turnover_label')} optional help={td('turnover_help')} value={a.tax.expectedTurnover} onChange={(v) => update({ ...a, tax: { ...a.tax, expectedTurnover: v } })} />
          <NumberField label={td('profit_label')} optional help={td('profit_help')} value={a.tax.expectedProfit} onChange={(v) => update({ ...a, tax: { ...a.tax, expectedProfit: v } })} />
        </div>
        <ChoiceGroup<'now' | 'later' | 'no'>
          label={td('salary_label')}
          columns={3}
          value={a.tax.ownerSalary}
          onChange={(v) => update({ ...a, tax: { ...a.tax, ownerSalary: v } })}
          options={[
            { value: 'now', label: td('salary_now') },
            { value: 'later', label: td('salary_later') },
            { value: 'no', label: td('salary_no') },
          ]}
        />
        <ChoiceGroup<'quarter' | 'month' | 'year'>
          label={td('vat_period_label')}
          columns={3}
          value={a.tax.vatPeriod}
          onChange={(v) => update({ ...a, tax: { ...a.tax, vatPeriod: v } })}
          options={[
            { value: 'quarter', label: td('vat_quarter') },
            { value: 'month', label: td('vat_month') },
            { value: 'year', label: td('vat_year') },
          ]}
        />
      </StepSection>

      <StepSection title={td('contact_title')} help={td('contact_help')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={td('contact_name_label')} mask autoComplete="name" value={a.contact.name} issues={field(issues, 'contact.name')} onChange={(v) => update({ ...a, contact: { ...a.contact, name: v } })} />
          <TextField label={td('contact_phone_label')} mask inputMode="tel" autoComplete="tel" placeholder="+46701234567" value={a.contact.phone} issues={field(issues, 'contact.phone')} onChange={(v) => update({ ...a, contact: { ...a.contact, phone: v } })} />
        </div>
        <TextField label={td('contact_email_label')} mask inputMode="email" autoComplete="email" value={a.contact.email} issues={field(issues, 'contact.email')} onChange={(v) => update({ ...a, contact: { ...a.contact, email: v } })} />
      </StepSection>
    </div>
  )
}
