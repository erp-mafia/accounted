'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BolagetHeader } from './BolagetHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany } from '@/contexts/CompanyContext'
import { cn, formatDate } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { SHARE_EVENT_KINDS, TRANSFER_REASONS, type ShareEventKind } from '@/lib/bolaget/types'
import type { ShareEventView, ShareRegisterView } from '@/lib/bolaget/view'

interface Person {
  party_id: string
  name: string
  kind: 'person' | 'company'
  org_number: string | null
  personnummer_masked: string | null
  birth_date: string | null
  address: { line1: string | null; line2: string | null; postal_code: string | null; city: string | null; country: string | null } | null
  email: string | null
}

interface PageData {
  register: ShareRegisterView
  events: ShareEventView[]
  people: Person[]
  can_print_full_identity: boolean
}

type FormState = Record<string, string>

const ISSUE: readonly ShareEventKind[] = ['bildande', 'nyemission', 'fondemission']
const FROM_HOLDER: readonly ShareEventKind[] = ['overlatelse', 'indragning', 'omvandling']
const RANGED: readonly ShareEventKind[] = [...ISSUE, ...FROM_HOLDER, 'aktiebrev', 'pant', 'nyttjanderatt']
const NEW_PARTY = '__new'

const EMPTY_EVENT: FormState = {
  kind: 'overlatelse',
  event_date: '',
  share_class_code: '',
  to_share_class_code: '',
  from_party_id: '',
  to_party: '',
  to_name: '',
  to_kind: 'person',
  to_org_number: '',
  counter_party: '',
  counterparty_name: '',
  counterparty_kind: 'company',
  counterparty_org_number: '',
  share_count: '',
  range_start: '',
  range_end: '',
  transfer_reason: 'kop',
  price_total: '',
  ratio: '',
  aktiebrev_number: '',
  aktiebrev_action: 'issued',
  note_status: 'open',
  corrects_event_id: '',
  registered_on: '',
  note: '',
  forbehall_cleared: '',
}

function intOrNull(value: string): number | null {
  const n = Number.parseInt(value.replace(/\s/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The form as POST /api/bolaget/share-register/events takes it: only the fields the kind uses. */
export function eventBody(form: FormState): Record<string, unknown> {
  const kind = form.kind as ShareEventKind
  const body: Record<string, unknown> = { kind, event_date: form.event_date }
  if (form.note.trim()) body.note = form.note.trim()
  if (ISSUE.includes(kind) || FROM_HOLDER.includes(kind)) {
    if (form.share_class_code) body.share_class_code = form.share_class_code
  }
  if (FROM_HOLDER.includes(kind)) body.from_party_id = form.from_party_id || null
  if (ISSUE.includes(kind) || kind === 'overlatelse') {
    if (form.to_party && form.to_party !== NEW_PARTY) body.to_party_id = form.to_party
    else {
      body.to_name = form.to_name.trim()
      body.to_kind = form.to_kind
      if (form.to_kind === 'company' && form.to_org_number.trim()) body.to_org_number = form.to_org_number.trim()
    }
  }
  if (kind === 'pant' || kind === 'nyttjanderatt') {
    if (form.counter_party && form.counter_party !== NEW_PARTY) body.counterparty_party_id = form.counter_party
    else {
      body.counterparty_name = form.counterparty_name.trim()
      body.counterparty_kind = form.counterparty_kind
      if (form.counterparty_kind === 'company' && form.counterparty_org_number.trim()) body.counterparty_org_number = form.counterparty_org_number.trim()
    }
    body.note_status = form.note_status
  }
  if (RANGED.includes(kind)) {
    const start = intOrNull(form.range_start)
    const end = intOrNull(form.range_end)
    const count = intOrNull(form.share_count)
    if (start) {
      body.range_start = start
      body.range_end = end ?? start
    } else if (count) {
      body.share_count = count
    }
  }
  if (kind === 'omvandling') body.to_share_class_code = form.to_share_class_code
  if (kind === 'overlatelse') {
    body.transfer_reason = form.transfer_reason
    if (form.forbehall_cleared === 'true') body.forbehall_cleared = true
  }
  if ((ISSUE.includes(kind) || kind === 'overlatelse' || kind === 'indragning') && form.price_total.trim()) {
    const price = parseAmountInput(form.price_total)
    if (price !== null) body.price_total = price
  }
  if (kind === 'split' || kind === 'sammanlaggning') body.ratio = intOrNull(form.ratio)
  if (kind === 'aktiebrev') {
    body.aktiebrev_number = form.aktiebrev_number.trim()
    body.aktiebrev_action = form.aktiebrev_action
  }
  if (kind === 'rattelse') body.corrects_event_id = form.corrects_event_id
  if ((kind === 'nyemission' || kind === 'fondemission' || kind === 'indragning') && form.registered_on) body.registered_on = form.registered_on
  return body
}

function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date())
}

/**
 * Ägare och aktiebok: the aktiebok (ABL 5 kap.) as of a date, its history,
 * the share classes with their förbehåll, the holders' identities and the
 * printouts (aktiebok, extract per holder, aktiebrev). Every change is an
 * entry, previewed before it is made.
 */
export function ShareRegister() {
  const t = useTranslations('bolaget_aktiebok')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { role } = useCompany()
  const isAdmin = role === 'owner' || role === 'admin'
  const saveSettings = useSaveSettings()

  const [asOf, setAsOf] = useState('')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<PageData | null>(null)
  const [eventForm, setEventForm] = useState<FormState | null>(null)
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [quickStart, setQuickStart] = useState<FormState | null>(null)
  const [person, setPerson] = useState<(FormState & { party_id: string; name: string }) | null>(null)
  const [classForm, setClassForm] = useState<(FormState & { share_class_id?: string }) | null>(null)
  const [capitalForm, setCapitalForm] = useState<FormState | null>(null)
  const [confirmAvstamning, setConfirmAvstamning] = useState(false)

  const fail = useCallback(
    (title: string, body: unknown) => toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' }),
    [locale, toast],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/bolaget/share-register${asOf ? `?as_of=${asOf}` : ''}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('load_failed'), body)
      setData(body.data as PageData)
    } finally {
      setLoading(false)
    }
  }, [asOf, fail, t])

  useEffect(() => {
    void load()
  }, [load])

  const people = useMemo(() => data?.people ?? [], [data])
  const personById = useMemo(() => new Map(people.map((p) => [p.party_id, p])), [people])
  const register = data?.register ?? null
  const holders = register?.holders ?? []
  const classes = register?.classes ?? []
  const eventsById = useMemo(() => new Map((data?.events ?? []).map((e) => [e.share_register_event_id, e])), [data])

  function openEvent(preset: Partial<FormState> = {}) {
    setPreview(null)
    setEventForm({ ...EMPTY_EVENT, event_date: today(), ...preset })
  }

  async function submitEvent(dryRun: boolean) {
    if (!eventForm) return
    setBusy(true)
    try {
      const res = await fetch(`/api/bolaget/share-register/events${dryRun ? '?dry_run=true' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody(eventForm)),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('event_failed'), body)
      if (dryRun) {
        setPreview(body.data as Record<string, unknown>)
        return
      }
      toast({ title: t('event_saved', { number: body.data?.event_number ?? '' }) })
      setEventForm(null)
      setPreview(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function submitQuickStart() {
    if (!quickStart) return
    const count = intOrNull(quickStart.share_count)
    if (!count || !quickStart.event_date || (!quickStart.to_party && !quickStart.to_name.trim())) {
      toast({ title: t('quick_invalid'), variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = { kind: 'bildande', event_date: quickStart.event_date, share_count: count }
      if (quickStart.to_party && quickStart.to_party !== NEW_PARTY) body.to_party_id = quickStart.to_party
      else Object.assign(body, { to_name: quickStart.to_name.trim(), to_kind: quickStart.to_kind, ...(quickStart.to_kind === 'company' && quickStart.to_org_number.trim() ? { to_org_number: quickStart.to_org_number.trim() } : {}) })
      const res = await fetch('/api/bolaget/share-register/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('event_failed'), json)
      toast({ title: t('quick_done') })
      setQuickStart(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function savePerson() {
    if (!person) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        address_line1: person.address_line1,
        address_line2: person.address_line2,
        postal_code: person.postal_code,
        city: person.city,
        country: person.country || null,
        email: person.email,
      }
      if (person.personnummer.trim()) payload.personnummer = person.personnummer.trim()
      if (person.birth_date) payload.birth_date = person.birth_date
      const res = await fetch(`/api/bolaget/people/${person.party_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('person_failed'), body)
      toast({ title: t('person_saved') })
      setPerson(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function saveClass() {
    if (!classForm) return
    const votes = parseDecimalInput(classForm.votes_per_share)
    if (votes === null || !(votes > 0)) {
      toast({ title: t('class_invalid'), variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        name: classForm.name.trim() || null,
        votes_per_share: votes,
        forbehall_samtycke: classForm.forbehall_samtycke === 'true',
        forbehall_forkop: classForm.forbehall_forkop === 'true',
        forbehall_hembud: classForm.forbehall_hembud === 'true',
        forbehall_omvandling: classForm.forbehall_omvandling === 'true',
        forbehall_inlosen: classForm.forbehall_inlosen === 'true',
        forbehall_text: classForm.forbehall_text.trim() || null,
        bolagsordning_reference: classForm.bolagsordning_reference.trim() || null,
      }
      const editing = Boolean(classForm.share_class_id)
      if (!editing) payload.code = classForm.code.trim()
      const res = await fetch(editing ? `/api/bolaget/share-classes/${classForm.share_class_id}` : '/api/bolaget/share-classes', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return fail(t('class_failed'), body)
      const warnings = (body.warnings ?? []) as Array<{ message_sv?: string; message_en?: string }>
      toast({ title: t('class_saved'), ...(warnings.length > 0 ? { description: warnings.map((w) => (locale === 'en' ? w.message_en : w.message_sv)).join(' ') } : {}) })
      setClassForm(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function toggleAvstamning() {
    if (!register) return
    const res = await fetch('/api/bolaget/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_avstamningsbolag: !register.is_avstamningsbolag }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      fail(t('avstamning_failed'), body)
      return
    }
    await load()
  }

  async function saveCapital() {
    if (!capitalForm || !register) return
    const aktiekapital = parseAmountInput(capitalForm.aktiekapital)
    if (aktiekapital === null || aktiekapital <= 0 || !Number.isInteger(aktiekapital)) {
      toast({ title: t('capital_invalid'), variant: 'destructive' })
      return
    }
    const json = await saveSettings({ aktiekapital, antal_aktier: register.total_shares }, { failedTitle: t('capital_failed') })
    if (json) {
      setCapitalForm(null)
      await load()
    }
  }

  function exportHref(format: 'pdf' | 'csv', view?: string) {
    const params = new URLSearchParams({ format })
    if (asOf) params.set('as_of', asOf)
    if (view) params.set('view', view)
    return `/api/bolaget/aktiebok/export?${params.toString()}`
  }

  const field = <S extends FormState>(state: S, set: (s: S) => void, key: string) => ({
    id: `sr-${key}`,
    value: state[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => set({ ...state, [key]: e.target.value }),
  })

  // One ochre sentence: the most pressing of mismatch, settings empty, incomplete identities.
  const attn = (() => {
    if (!register) return null
    const r = register.reconciliation
    if (register.is_avstamningsbolag) return <AttnLine>{t('attn_avstamning')}</AttnLine>
    if (r.status === 'mismatch') return <AttnLine>{t('attn_mismatch', { register: r.register_shares, settings: r.settings_shares ?? 0 })}</AttnLine>
    if (r.status === 'settings_empty' && isAdmin) {
      return (
        <AttnLine action={{ label: t('attn_settings_empty_action'), onClick: () => setCapitalForm({ aktiekapital: '' }) }}>
          {t('attn_settings_empty', { shares: r.register_shares })}
        </AttnLine>
      )
    }
    if (register.incomplete.without_identity > 0 || register.incomplete.without_address > 0) {
      return <AttnLine>{t('attn_incomplete', { count: Math.max(register.incomplete.without_identity, register.incomplete.without_address) })}</AttnLine>
    }
    return null
  })()

  const kind = (eventForm?.kind ?? 'overlatelse') as ShareEventKind
  const selectedClass = classes.find((c) => c.code === eventForm?.share_class_code) ?? (classes.length === 1 ? classes[0] : undefined)
  const classHasForbehall = Boolean(selectedClass && (selectedClass.forbehall_samtycke || selectedClass.forbehall_forkop || selectedClass.forbehall_hembud))

  const partyPicker = (state: FormState, set: (s: FormState) => void, prefix: 'to' | 'counter', label: string) => {
    const selectKey = prefix === 'to' ? 'to_party' : 'counter_party'
    const nameKey = prefix === 'to' ? 'to_name' : 'counterparty_name'
    const kindKey = prefix === 'to' ? 'to_kind' : 'counterparty_kind'
    const orgKey = prefix === 'to' ? 'to_org_number' : 'counterparty_org_number'
    const isNew = !state[selectKey] || state[selectKey] === NEW_PARTY
    return (
      <>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`sr-${selectKey}`}>{label}</Label>
          <SettingsSelect {...field(state, set, selectKey)}>
            <option value={NEW_PARTY}>{t('party_new')}</option>
            {people.map((p) => (
              <option key={p.party_id} value={p.party_id}>
                {p.name}
              </option>
            ))}
          </SettingsSelect>
        </div>
        {isNew && (
          <>
            <div className="space-y-1">
              <Label htmlFor={`sr-${nameKey}`}>{t('field_name')}</Label>
              <Input {...field(state, set, nameKey)} maxLength={200} data-ph-mask="" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`sr-${kindKey}`}>{t('field_party_kind')}</Label>
              <SettingsSelect {...field(state, set, kindKey)}>
                <option value="person">{t('party_kind_person')}</option>
                <option value="company">{t('party_kind_company')}</option>
              </SettingsSelect>
            </div>
            {state[kindKey] === 'company' && (
              <div className="space-y-1">
                <Label htmlFor={`sr-${orgKey}`}>{t('field_org_number')}</Label>
                <Input {...field(state, set, orgKey)} maxLength={13} className="tabular-nums" />
              </div>
            )}
          </>
        )}
      </>
    )
  }

  return (
    <div className="space-y-8">
      <BolagetHeader title={t('title')} subtitle={t('subtitle')} help={t('help')} asOf={asOf} onAsOfChange={setAsOf} asOfLabel={t('as_of')} action={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  {t('export')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={exportHref('pdf')}>{t('export_pdf')}</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={exportHref('csv', 'shares')}>{t('export_csv_shares')}</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={exportHref('csv', 'holders')}>{t('export_csv_holders')}</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={exportHref('csv', 'history')}>{t('export_csv_history')}</a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {canWrite && register && !register.is_avstamningsbolag && (
              <Button size="sm" onClick={() => openEvent()}>
                {t('new_event')}
              </Button>
            )}
          </>
        }
      />

      {attn}

      {loading && !data ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : register && register.events_count === 0 ? (
        <EmptyState
          title={t('empty_title')}
          description={t('empty_description')}
          {...(canWrite && !register.is_avstamningsbolag
            ? {
                actionLabel: t('quick_action'),
                onAction: () =>
                  setQuickStart({
                    ...EMPTY_EVENT,
                    to_party: people[0]?.party_id ?? NEW_PARTY,
                    share_count: register.reconciliation.settings_shares ? String(register.reconciliation.settings_shares) : '',
                    event_date: '',
                  }),
              }
            : {})}
        />
      ) : register ? (
        <>
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('holders_heading')}</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('totals', { shares: register.total_shares, votes: register.total_votes, date: formatDate(register.as_of) })}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="stagger-enter w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_holder')}</th>
                    <th className={TH_CLASS}>{t('col_identity')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_capital')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('col_votes')}</th>
                    <th className={TH_CLASS}>{t('col_numbers')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {holders.map((h) => (
                    <tr key={h.party_id} className="hover:bg-secondary/35">
                      <td className={TD_CLASS} data-ph-mask="">
                        {h.name}
                        {h.officer && <span className="ml-2 text-xs text-muted-foreground">{t('officer')}</span>}
                      </td>
                      <td className={cn(TD_CLASS, 'tabular-nums')} data-ph-mask="">
                        {h.identity ?? <Badge variant="outline">{t('identity_missing')}</Badge>}
                      </td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.shares.toLocaleString('sv-SE')}</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.capital_pct.toLocaleString('sv-SE')} %</td>
                      <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.votes_pct.toLocaleString('sv-SE')} %</td>
                      <td className={cn(TD_CLASS, 'tabular-nums text-muted-foreground')}>
                        {h.ranges.map((r) => (r.range_start === r.range_end ? `${r.range_start}` : `${r.range_start}-${r.range_end}`)).join(', ')}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                        <a className={QUIET_LINK_CLASS} href={`/api/bolaget/holders/${h.party_id}/extract${asOf ? `?as_of=${asOf}` : ''}`}>
                          {t('extract')}
                        </a>
                        {canWrite && (
                          <button
                            type="button"
                            className={cn(QUIET_LINK_CLASS, 'ml-3')}
                            onClick={() => {
                              const p = personById.get(h.party_id)
                              setPerson({
                                party_id: h.party_id,
                                name: h.name,
                                kind: p?.kind ?? 'person',
                                personnummer: '',
                                birth_date: p?.birth_date ?? '',
                                address_line1: p?.address?.line1 ?? '',
                                address_line2: p?.address?.line2 ?? '',
                                postal_code: p?.address?.postal_code ?? '',
                                city: p?.address?.city ?? '',
                                country: p?.address?.country ?? '',
                                email: p?.email ?? '',
                                masked: p?.personnummer_masked ?? '',
                              })
                            }}
                          >
                            {t('edit_details')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {register.notes.length > 0 && (
              <div className="space-y-1 pt-2">
                {register.notes.map((n) => (
                  <div key={`${n.kind}-${n.event_number}-${n.range_start}`} className="flex flex-wrap items-baseline gap-3 text-[12.5px] text-muted-foreground">
                    <span>
                      {n.kind === 'aktiebrev'
                        ? t('note_aktiebrev', { number: n.aktiebrev_number ?? '', from: n.range_start, to: n.range_end })
                        : n.kind === 'pant'
                          ? t('note_pant', { name: n.counterparty_name ?? '', from: n.range_start, to: n.range_end })
                          : t('note_nyttjanderatt', { name: n.counterparty_name ?? '', from: n.range_start, to: n.range_end })}
                    </span>
                    {n.kind === 'aktiebrev' && (
                      <a
                        className={QUIET_LINK_CLASS}
                        href={`/api/bolaget/aktiebrev/${data?.events.find((e) => e.event_number === n.event_number)?.share_register_event_id ?? ''}`}
                      >
                        {t('print_aktiebrev')}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('classes_heading')}</h2>
              {canWrite && (
                <button
                  type="button"
                  className={QUIET_LINK_CLASS}
                  onClick={() =>
                    setClassForm({ code: '', name: '', votes_per_share: '1', forbehall_samtycke: '', forbehall_forkop: '', forbehall_hembud: '', forbehall_omvandling: '', forbehall_inlosen: '', forbehall_text: '', bolagsordning_reference: '' })
                  }
                >
                  {t('class_add')}
                </button>
              )}
            </div>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_class')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_votes_per_share')}</th>
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                  <th className={TH_CLASS}>{t('col_forbehall')}</th>
                  <th className={TH_CLASS} />
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.share_class_id} className="hover:bg-secondary/35">
                    <td className={TD_CLASS}>
                      {c.code}
                      {c.name ? <span className="ml-2 text-muted-foreground">{c.name}</span> : null}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{c.votes_per_share.toLocaleString('sv-SE')}</td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{c.shares.toLocaleString('sv-SE')}</td>
                    <td className={cn(TD_CLASS, 'text-muted-foreground')}>
                      {(['samtycke', 'forkop', 'hembud', 'omvandling', 'inlosen'] as const)
                        .filter((k) => c[`forbehall_${k}`])
                        .map((k) => t(`forbehall_${k}`))
                        .join(', ') || t('forbehall_none')}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right')}>
                      {canWrite && (
                        <button
                          type="button"
                          className={QUIET_LINK_CLASS}
                          onClick={() =>
                            setClassForm({
                              share_class_id: c.share_class_id,
                              code: c.code,
                              name: c.name ?? '',
                              votes_per_share: String(c.votes_per_share),
                              forbehall_samtycke: String(c.forbehall_samtycke),
                              forbehall_forkop: String(c.forbehall_forkop),
                              forbehall_hembud: String(c.forbehall_hembud),
                              forbehall_omvandling: String(c.forbehall_omvandling),
                              forbehall_inlosen: String(c.forbehall_inlosen),
                              forbehall_text: c.forbehall_text ?? '',
                              bolagsordning_reference: c.bolagsordning_reference ?? '',
                            })
                          }
                        >
                          {t('edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{t('history_heading')}</h2>
            <div className="overflow-x-auto">
              <table className="stagger-enter w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('col_number')}</th>
                    <th className={TH_CLASS}>{t('col_date')}</th>
                    <th className={TH_CLASS}>{t('col_entry')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {[...(data?.events ?? [])].reverse().map((e) => (
                    <tr key={e.share_register_event_id} className="hover:bg-secondary/35">
                      <td className={cn(TD_CLASS, 'tabular-nums')}>{e.event_number}</td>
                      <td className={cn(TD_CLASS, 'tabular-nums')}>{formatDate(e.event_date)}</td>
                      <td className={cn(TD_CLASS, e.voided && 'text-muted-foreground line-through')} data-ph-mask="">
                        {e.text}
                        {e.voided && <span className="ml-2 no-underline">{t('voided')}</span>}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                        {e.kind === 'aktiebrev' && e.aktiebrev_action === 'issued' && !e.voided && (
                          <a className={QUIET_LINK_CLASS} href={`/api/bolaget/aktiebrev/${e.share_register_event_id}`}>
                            {t('print_aktiebrev')}
                          </a>
                        )}
                        {canWrite && !e.voided && e.kind !== 'rattelse' && !register.is_avstamningsbolag && (
                          <button
                            type="button"
                            className={cn(QUIET_LINK_CLASS, 'ml-3')}
                            onClick={() => openEvent({ kind: 'rattelse', corrects_event_id: e.share_register_event_id })}
                          >
                            {t('correct')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {register && isAdmin && (
        <p className="text-[12.5px] text-muted-foreground">
          {register.is_avstamningsbolag ? t('avstamning_yes') : t('avstamning_no')}{' '}
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => setConfirmAvstamning(true)}>
            {t('avstamning_change')}
          </button>
        </p>
      )}

      <ConfirmDialog
        open={confirmAvstamning}
        onOpenChange={setConfirmAvstamning}
        title={register?.is_avstamningsbolag ? t('avstamning_unset_title') : t('avstamning_set_title')}
        description={register?.is_avstamningsbolag ? t('avstamning_unset_description') : t('avstamning_set_description')}
        confirmLabel={t('avstamning_confirm')}
        onConfirm={toggleAvstamning}
      />

      <Dialog open={Boolean(eventForm)} onOpenChange={(open) => (open ? null : setEventForm(null))}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview ? t('preview_title') : t('new_event')}</DialogTitle>
          </DialogHeader>
          {eventForm && !preview && (
            <div className="grid max-h-[60vh] gap-4 overflow-y-auto sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sr-kind">{t('field_kind')}</Label>
                <SettingsSelect {...field(eventForm, setEventForm, 'kind')}>
                  {SHARE_EVENT_KINDS.filter((k) => k !== 'rattelse' || eventForm.kind === 'rattelse').map((k) => (
                    <option key={k} value={k}>
                      {t(`kind_${k}`)}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-event_date">{t('field_event_date')}</Label>
                <Input {...field(eventForm, setEventForm, 'event_date')} type="date" className="tabular-nums" />
              </div>
              {kind === 'rattelse' && (
                <p className="text-sm text-muted-foreground sm:col-span-2" data-ph-mask="">
                  {t('correct_intro', { text: eventsById.get(eventForm.corrects_event_id)?.text ?? '' })}
                </p>
              )}
              {(ISSUE.includes(kind) || FROM_HOLDER.includes(kind)) && classes.length > 0 && (
                <div className="space-y-1">
                  <Label htmlFor="sr-share_class_code">{t('field_class')}</Label>
                  <SettingsSelect {...field(eventForm, setEventForm, 'share_class_code')}>
                    <option value="">{classes.length === 1 ? classes[0]!.code : t('choose')}</option>
                    {classes.map((c) => (
                      <option key={c.share_class_id} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
              )}
              {kind === 'omvandling' && (
                <div className="space-y-1">
                  <Label htmlFor="sr-to_share_class_code">{t('field_to_class')}</Label>
                  <SettingsSelect {...field(eventForm, setEventForm, 'to_share_class_code')}>
                    <option value="">{t('choose')}</option>
                    {classes.map((c) => (
                      <option key={c.share_class_id} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
              )}
              {FROM_HOLDER.includes(kind) && (
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="sr-from_party_id">{t('field_from')}</Label>
                  <SettingsSelect {...field(eventForm, setEventForm, 'from_party_id')}>
                    <option value="">{t('choose')}</option>
                    {holders.map((h) => (
                      <option key={h.party_id} value={h.party_id}>
                        {h.name} ({h.shares})
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
              )}
              {(ISSUE.includes(kind) || kind === 'overlatelse') && partyPicker(eventForm, setEventForm, 'to', t('field_to'))}
              {(kind === 'pant' || kind === 'nyttjanderatt') && partyPicker(eventForm, setEventForm, 'counter', kind === 'pant' ? t('field_pledgee') : t('field_usufructuary'))}
              {RANGED.includes(kind) && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="sr-share_count">{t('field_share_count')}</Label>
                    <Input {...field(eventForm, setEventForm, 'share_count')} inputMode="numeric" className="tabular-nums" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="sr-range_start">{t('field_range_start')}</Label>
                      <Input {...field(eventForm, setEventForm, 'range_start')} inputMode="numeric" className="tabular-nums" />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sr-range_end">{t('field_range_end')}</Label>
                      <Input {...field(eventForm, setEventForm, 'range_end')} inputMode="numeric" className="tabular-nums" />
                    </div>
                  </div>
                </>
              )}
              {kind === 'overlatelse' && (
                <div className="space-y-1">
                  <Label htmlFor="sr-transfer_reason">{t('field_reason')}</Label>
                  <SettingsSelect {...field(eventForm, setEventForm, 'transfer_reason')}>
                    {TRANSFER_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`reason_${r}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
              )}
              {(ISSUE.includes(kind) || kind === 'overlatelse' || kind === 'indragning') && (
                <div className="space-y-1">
                  <Label htmlFor="sr-price_total">{t('field_price')}</Label>
                  <Input {...field(eventForm, setEventForm, 'price_total')} inputMode="decimal" className="tabular-nums" />
                </div>
              )}
              {(kind === 'split' || kind === 'sammanlaggning') && (
                <div className="space-y-1">
                  <Label htmlFor="sr-ratio">{kind === 'split' ? t('field_ratio_split') : t('field_ratio_merge')}</Label>
                  <Input {...field(eventForm, setEventForm, 'ratio')} inputMode="numeric" className="tabular-nums" />
                </div>
              )}
              {kind === 'aktiebrev' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="sr-aktiebrev_number">{t('field_aktiebrev_number')}</Label>
                    <Input {...field(eventForm, setEventForm, 'aktiebrev_number')} maxLength={40} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sr-aktiebrev_action">{t('field_aktiebrev_action')}</Label>
                    <SettingsSelect {...field(eventForm, setEventForm, 'aktiebrev_action')}>
                      <option value="issued">{t('aktiebrev_issued')}</option>
                      <option value="returned">{t('aktiebrev_returned')}</option>
                    </SettingsSelect>
                  </div>
                </>
              )}
              {(kind === 'pant' || kind === 'nyttjanderatt') && (
                <div className="space-y-1">
                  <Label htmlFor="sr-note_status">{t('field_note_status')}</Label>
                  <SettingsSelect {...field(eventForm, setEventForm, 'note_status')}>
                    <option value="open">{t('note_open')}</option>
                    <option value="closed">{t('note_closed')}</option>
                  </SettingsSelect>
                </div>
              )}
              {(kind === 'nyemission' || kind === 'fondemission' || kind === 'indragning') && (
                <div className="space-y-1">
                  <Label htmlFor="sr-registered_on">{t('field_registered_on')}</Label>
                  <Input {...field(eventForm, setEventForm, 'registered_on')} type="date" className="tabular-nums" />
                </div>
              )}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sr-note">{kind === 'rattelse' ? t('field_correct_reason') : t('field_note')}</Label>
                <Textarea {...field(eventForm, setEventForm, 'note')} maxLength={2000} rows={2} data-ph-mask="" />
              </div>
              {kind === 'overlatelse' && classHasForbehall && (
                <label className="flex items-start gap-2 text-sm sm:col-span-2">
                  <Checkbox
                    checked={eventForm.forbehall_cleared === 'true'}
                    onCheckedChange={(v) => setEventForm({ ...eventForm, forbehall_cleared: v === true ? 'true' : '' })}
                  />
                  <span>{t('forbehall_cleared')}</span>
                </label>
              )}
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('event_form_hint')}</p>
            </div>
          )}
          {eventForm && preview && (
            <div className="space-y-3 text-sm">
              <p>
                {t('preview_line', {
                  kind: String(preview.kind_label ?? ''),
                  date: String(preview.event_date ?? ''),
                  count: Number(preview.share_count ?? 0),
                  from: preview.range_start === null ? '' : String(preview.range_start),
                  to: preview.range_end === null ? '' : String(preview.range_end),
                })}
              </p>
              {Array.isArray(preview.holders_changed) &&
                (preview.holders_changed as Array<{ party_id: string | null; shares_before: number; shares_after: number }>).map((h, i) => (
                  <p key={h.party_id ?? `new-${i}`} className="tabular-nums text-muted-foreground" data-ph-mask="">
                    {t('preview_holder', {
                      name: h.party_id ? personById.get(h.party_id)?.name ?? '' : eventForm.to_name || eventForm.counterparty_name,
                      before: h.shares_before,
                      after: h.shares_after,
                    })}
                  </p>
                ))}
              <p className="tabular-nums text-muted-foreground">
                {t('preview_total', { before: Number(preview.total_shares_before ?? 0), after: Number(preview.total_shares_after ?? 0) })}
              </p>
              {Array.isArray(preview.warnings) &&
                (preview.warnings as string[]).map((w) => (
                  <AttnLine key={w}>{w}</AttnLine>
                ))}
              <p className="text-xs text-muted-foreground">{t('preview_permanent')}</p>
            </div>
          )}
          <DialogFooter>
            {preview ? (
              <>
                <Button variant="outline" onClick={() => setPreview(null)} disabled={busy}>
                  {t('back')}
                </Button>
                <Button onClick={() => submitEvent(false)} loading={busy}>
                  {t('confirm_event')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setEventForm(null)} disabled={busy}>
                  {t('cancel')}
                </Button>
                <Button onClick={() => submitEvent(true)} loading={busy} disabled={!eventForm?.event_date}>
                  {t('preview')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(quickStart)} onOpenChange={(open) => (open ? null : setQuickStart(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('quick_title')}</DialogTitle>
          </DialogHeader>
          {quickStart && (
            <div className="grid gap-4 sm:grid-cols-2">
              <p className="text-sm text-muted-foreground sm:col-span-2">{t('quick_intro')}</p>
              {partyPicker(quickStart, setQuickStart, 'to', t('quick_owner'))}
              <div className="space-y-1">
                <Label htmlFor="sr-share_count">{t('field_share_count')}</Label>
                <Input {...field(quickStart, setQuickStart, 'share_count')} inputMode="numeric" className="tabular-nums" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-event_date">{t('quick_date')}</Label>
                <Input {...field(quickStart, setQuickStart, 'event_date')} type="date" className="tabular-nums" />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('quick_hint')}</p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setQuickStart(null)
                openEvent({ kind: 'bildande', event_date: '' })
              }}
              disabled={busy}
            >
              {t('manual_action')}
            </Button>
            <Button onClick={submitQuickStart} loading={busy}>
              {t('quick_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(person)} onOpenChange={(open) => (open ? null : setPerson(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle data-ph-mask="">{person?.name ?? ''}</DialogTitle>
          </DialogHeader>
          {person && (
            <div className="grid gap-4 sm:grid-cols-2">
              {person.kind === 'person' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="sr-personnummer">{t('field_personnummer')}</Label>
                    <Input
                      {...field(person, setPerson as (s: FormState) => void, 'personnummer')}
                      placeholder={person.masked || t('personnummer_placeholder')}
                      autoComplete="off"
                      maxLength={13}
                      className="tabular-nums"
                      data-ph-mask=""
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="sr-birth_date">{t('field_birth_date')}</Label>
                    <Input {...field(person, setPerson as (s: FormState) => void, 'birth_date')} type="date" className="tabular-nums" />
                  </div>
                </>
              )}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sr-address_line1">{t('field_address')}</Label>
                <Input {...field(person, setPerson as (s: FormState) => void, 'address_line1')} maxLength={200} data-ph-mask="" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-postal_code">{t('field_postal_code')}</Label>
                <Input {...field(person, setPerson as (s: FormState) => void, 'postal_code')} maxLength={20} className="tabular-nums" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-city">{t('field_city')}</Label>
                <Input {...field(person, setPerson as (s: FormState) => void, 'city')} maxLength={100} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-country">{t('field_country')}</Label>
                <Input {...field(person, setPerson as (s: FormState) => void, 'country')} maxLength={2} placeholder="SE" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-email">{t('field_email')}</Label>
                <Input {...field(person, setPerson as (s: FormState) => void, 'email')} type="email" maxLength={254} data-ph-mask="" />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('person_hint')}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPerson(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={savePerson} loading={busy}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(classForm)} onOpenChange={(open) => (open ? null : setClassForm(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{classForm?.share_class_id ? t('class_edit_title', { code: classForm.code }) : t('class_add')}</DialogTitle>
          </DialogHeader>
          {classForm && (
            <div className="grid gap-4 sm:grid-cols-2">
              {!classForm.share_class_id && (
                <div className="space-y-1">
                  <Label htmlFor="sr-code">{t('field_class_code')}</Label>
                  <Input {...field(classForm, setClassForm as (s: FormState) => void, 'code')} maxLength={12} />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="sr-name">{t('field_class_name')}</Label>
                <Input {...field(classForm, setClassForm as (s: FormState) => void, 'name')} maxLength={100} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-votes_per_share">{t('col_votes_per_share')}</Label>
                <Input {...field(classForm, setClassForm as (s: FormState) => void, 'votes_per_share')} inputMode="decimal" className="tabular-nums" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                {(['samtycke', 'forkop', 'hembud', 'omvandling', 'inlosen'] as const).map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={classForm[`forbehall_${k}`] === 'true'}
                      onCheckedChange={(v) => setClassForm({ ...classForm, [`forbehall_${k}`]: v === true ? 'true' : '' })}
                    />
                    <span>{t(`forbehall_${k}_long`)}</span>
                  </label>
                ))}
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sr-forbehall_text">{t('field_forbehall_text')}</Label>
                <Textarea {...field(classForm, setClassForm as (s: FormState) => void, 'forbehall_text')} maxLength={4000} rows={3} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-bolagsordning_reference">{t('field_bolagsordning_reference')}</Label>
                <Input {...field(classForm, setClassForm as (s: FormState) => void, 'bolagsordning_reference')} maxLength={200} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClassForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={saveClass} loading={busy}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(capitalForm)} onOpenChange={(open) => (open ? null : setCapitalForm(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('capital_title')}</DialogTitle>
          </DialogHeader>
          {capitalForm && register && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('capital_intro', { shares: register.total_shares })}</p>
              <div className="space-y-1">
                <Label htmlFor="sr-aktiekapital">{t('field_aktiekapital')}</Label>
                <Input {...field(capitalForm, setCapitalForm as (s: FormState) => void, 'aktiekapital')} inputMode="numeric" className="tabular-nums" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCapitalForm(null)}>
              {t('cancel')}
            </Button>
            <Button onClick={saveCapital}>{t('save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
