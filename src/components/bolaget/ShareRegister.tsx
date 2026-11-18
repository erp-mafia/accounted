'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { BolagetHeader } from './BolagetHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogConsequence, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { PHONE_HIDDEN, ROW_ACTIONS_TD, SUM_ROW_CLASS, pct } from './register-table'
import {
  COUNTED_KINDS,
  COUNTERPARTY_KINDS,
  EMPTY_EVENT,
  NEW_PARTY,
  PRICED_KINDS,
  RANGED_KINDS,
  RECEIVER_KINDS,
  REGISTERED_KINDS,
  buildEventBody,
  shareNumbersLabel,
  voteSharesAfter,
  withField,
  type EventPreview,
  type FieldErrors,
  type FormState,
  type VoteShare,
} from './share-event-form'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { saveSettingsInDialog } from '@/components/settings/use-save-settings'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useCompany } from '@/contexts/CompanyContext'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { getCountryOptions } from '@/lib/vat/country-codes'
import { HOLDER_KINDS, HOLDING_KINDS, SHARE_EVENT_KINDS, TRANSFER_REASONS, type ShareEventKind } from '@/lib/bolaget/types'
import type { ShareEventView, ShareRegisterView } from '@/lib/bolaget/view'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { ArrowDownTrayIcon, PlusIcon } from '@/components/icons'

interface Person {
  party_id: string
  name: string
  kind: 'person' | 'company'
  org_number: string | null
  personnummer_masked: string | null
  foreign_id_masked: string | null
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

/** The dialog a failed action belongs to: its sentence is shown in that dialog's footer, where the person is. */
type DialogName = 'event' | 'person' | 'class' | 'capital' | 'avstamning'

const FORBEHALL = ['samtycke', 'forkop', 'hembud', 'omvandling', 'inlosen'] as const

const formatCount = (n: number) => n.toLocaleString('sv-SE')

/** The code of a refused request (the structured envelope's error.code), or null. */
function refusalCode(body: unknown): string | null {
  const envelope = (body as { error?: { code?: unknown } } | null)?.error
  return typeof envelope?.code === 'string' ? envelope.code : null
}

/** What sits under a field: why it cannot be sent, or else its one line of help. */
function FieldNote({ error, help }: { error?: string | undefined; help?: string | undefined }) {
  if (error) {
    return (
      <p role="alert" className="text-[12px] leading-4 text-destructive">
        {error}
      </p>
    )
  }
  return help ? <p className="text-[12px] leading-4 text-muted-foreground">{help}</p> : null
}

/** A dialog footer's left side: the sentence of a failed action, or else what the primary will do. */
function FooterNote({ failure, children }: { failure: string | null; children?: React.ReactNode }) {
  if (failure) {
    return (
      // data-ph-mask: a refusal can name a person.
      <DialogConsequence role="alert" className="text-destructive" data-ph-mask="">
        {failure}
      </DialogConsequence>
    )
  }
  return children ? <DialogConsequence>{children}</DialogConsequence> : null
}

/**
 * The entry as it will stand in the aktiebok, said the way its kind reads:
 * the shares and whose holdings change, the entry a rättelse voids, what a
 * note says. `body` is the request the preview was made from, and the one the
 * real write sends.
 */
function EntryPreview({
  preview,
  body,
  today,
  nameOf,
  voidedText,
  onPartyIsNew,
}: {
  preview: EventPreview
  body: Record<string, unknown>
  today: string
  nameOf: (partyId: string) => string
  /** The sentence of the entry a rättelse voids. */
  voidedText: string
  onPartyIsNew: (field: 'to' | 'counterparty', isNew: boolean) => void
}) {
  const t = useTranslations('bolaget_aktiebok')
  const kind = preview.kind
  const date = preview.event_date
  const typed = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '')
  const numbers = shareNumbersLabel(preview.range_start, preview.range_end, formatCount)
  const newReceiver = preview.to?.party_id ? '' : preview.to?.name ?? ''
  const counterpartyName = preview.counterparty?.party_id ? nameOf(preview.counterparty.party_id) : preview.counterparty?.name ?? ''

  const firstLine = (() => {
    if (kind === 'rattelse') return t('preview_line_rattelse', { date, number: preview.corrects_event_number ?? 0, text: voidedText })
    if (kind === 'anteckning') return t('preview_line_anteckning', { date, text: typed('note') })
    if (kind === 'split') return t('preview_line_split', { date, ratio: preview.ratio ?? 0 })
    if (kind === 'sammanlaggning') return t('preview_line_sammanlaggning', { date, ratio: preview.ratio ?? 0 })
    if (kind === 'aktiebrev') {
      return t(typed('aktiebrev_action') === 'returned' ? 'preview_line_aktiebrev_returned' : 'preview_line_aktiebrev_issued', { date, number: typed('aktiebrev_number'), numbers })
    }
    if (kind === 'pant' || kind === 'nyttjanderatt') {
      return t(`preview_line_${kind}_${typed('note_status') === 'closed' ? 'closed' : 'open'}`, { date, numbers, name: counterpartyName })
    }
    return t('preview_line', { kind: preview.kind_label, date, count: preview.share_count ?? 0, shareClass: preview.share_class ?? '', numbers })
  })()

  // A split or a sammanläggning lists every holder, a rättelse the holders of the entry it voids.
  const showTotals = HOLDING_KINDS.includes(kind) || (kind === 'rattelse' && (preview.holders_changed.length > 0 || preview.total_shares_before !== preview.total_shares_after))
  // The server says the same about a matched name as the line below with its action: said once.
  const warnings = preview.warnings.filter((_, i) => preview.warning_codes[i] !== 'BOLAGET_PARTY_MATCHED_EXISTING')
  const price = typeof body.price_total === 'number' ? body.price_total : null
  const madeNew = (['to', 'counterparty'] as const).filter((field) => body[`${field}_is_new`] === true)

  return (
    <div className="space-y-3 text-sm">
      <p data-ph-mask="">{firstLine}</p>
      {kind === 'rattelse' && (
        <p className="text-muted-foreground" data-ph-mask="">
          {t('preview_correct_reason', { text: typed('note') })}
        </p>
      )}
      {preview.creates_share_class && <p className="text-muted-foreground">{t('preview_creates_class', { code: preview.creates_share_class })}</p>}
      {kind === 'omvandling' && <p className="text-muted-foreground">{t('preview_to_class', { code: typed('to_share_class_code') })}</p>}
      {preview.holders_changed.map((h, i) => (
        <p key={h.party_id ?? `new-${i}`} className="tabular-nums text-muted-foreground" data-ph-mask="">
          {t('preview_holder', { name: h.party_id ? nameOf(h.party_id) : newReceiver, before: h.shares_before, after: h.shares_after })}
        </p>
      ))}
      {showTotals && (
        <p className="tabular-nums text-muted-foreground">{t('preview_total', { before: preview.total_shares_before, after: preview.total_shares_after })}</p>
      )}
      {kind === 'overlatelse' && preview.transfer_reason && (
        <p className="text-muted-foreground">{t('preview_transfer_reason', { reason: t(`reason_${preview.transfer_reason}`) })}</p>
      )}
      {price !== null && <p className="tabular-nums text-muted-foreground">{t('preview_price', { amount: formatCurrency(price) })}</p>}
      {typed('registered_on') && <p className="text-muted-foreground">{t('preview_registered', { date: typed('registered_on') })}</p>}
      {kind !== 'rattelse' && kind !== 'anteckning' && typed('note') && (
        <p className="text-muted-foreground" data-ph-mask="">
          {t('preview_comment', { text: typed('note') })}
        </p>
      )}
      {date < today && <p className="text-muted-foreground">{t('preview_backdated', { date, today })}</p>}
      {preview.matched_parties.map((m) => (
        <AttnLine key={`matched-${m.field}`} action={{ label: t('matched_other'), onClick: () => onPartyIsNew(m.field, true) }}>
          <span data-ph-mask="">{t('matched_existing', { name: m.name })}</span>
        </AttnLine>
      ))}
      {madeNew.map((field) => (
        <AttnLine key={`new-${field}`} tone="info" action={{ label: t('new_despite_match_undo'), onClick: () => onPartyIsNew(field, false) }}>
          <span data-ph-mask="">{t('new_despite_match', { name: typed(`${field}_name`) })}</span>
        </AttnLine>
      ))}
      {warnings.map((w) => (
        <AttnLine key={w}>{w}</AttnLine>
      ))}
    </div>
  )
}

/**
 * Aktiebok: the aktiebok (ABL 5 kap.) as of a date, its history, the share
 * classes with their förbehåll, the holders' identities and the printouts
 * (aktiebok, extract per holder, aktiebrev). An entry is permanent: every one
 * is previewed against today's register and confirmed before it is made, and
 * only the company's owner or an administrator is shown the way in.
 */
export function ShareRegister() {
  const t = useTranslations('bolaget_aktiebok')
  // The top bar carries the menu row's name (Företaget's sidebar).
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { role } = useCompany()
  // Every write to the registers needs the owner or an administrator (ABL 5:7: the board keeps the aktiebok).
  const isAdmin = role === 'owner' || role === 'admin'

  const [asOf, setAsOf] = useState('')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<PageData | null>(null)
  // The "Per datum" the register on screen was read for ('' is today); null until the first read.
  const [loadedAsOf, setLoadedAsOf] = useState<string | null>(null)
  // The register could not be read: in place of it when nothing is on
  // screen, as one line above it when a refresh failed.
  const [loadFailed, setLoadFailed] = useState(false)
  const [eventForm, setEventForm] = useState<FormState | null>(null)
  // The short first entry behind "Lägg in ägarna": the same form with fewer fields, the same preview and confirmation.
  const [quick, setQuick] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [preview, setPreview] = useState<{ body: Record<string, unknown>; data: EventPreview } | null>(null)
  const [failure, setFailure] = useState<{ where: DialogName; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [person, setPerson] = useState<(FormState & { party_id: string; name: string }) | null>(null)
  const [classForm, setClassForm] = useState<(FormState & { share_class_id?: string }) | null>(null)
  // A change of votes per share waiting to be confirmed, with the holders whose share of the votes it moves.
  const [votesConfirm, setVotesConfirm] = useState<{ code: string; before: number; after: number; shares: VoteShare[] } | null>(null)
  const [capitalForm, setCapitalForm] = useState<FormState | null>(null)
  // A typed figure outside the entry form that cannot be read, said at its field.
  const [inputError, setInputError] = useState<'votes' | 'aktiekapital' | null>(null)
  const [confirmAvstamning, setConfirmAvstamning] = useState(false)

  const requestedDay = useRef('')
  const load = useCallback(async (day: string) => {
    requestedDay.current = day
    setLoading(true)
    try {
      const res = await fetch(`/api/bolaget/share-register${day ? `?as_of=${day}` : ''}`)
      const body = await res.json().catch(() => ({}))
      // An answer for a day the page has since left is dropped: the newest request decides what is shown.
      if (requestedDay.current !== day) return
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      setData(body.data as PageData)
      setLoadedAsOf(day)
      setLoadFailed(false)
    } catch {
      if (requestedDay.current === day) setLoadFailed(true)
    } finally {
      if (requestedDay.current === day) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(asOf)
  }, [load, asOf])

  const people = useMemo(() => data?.people ?? [], [data])
  const personById = useMemo(() => new Map(people.map((p) => [p.party_id, p])), [people])
  const register = data?.register ?? null
  const holders = register?.holders ?? []
  const classes = register?.classes ?? []
  const events = data?.events ?? []
  const eventsById = useMemo(() => new Map((data?.events ?? []).map((e) => [e.share_register_event_id, e])), [data])
  const countryOptions = useMemo(() => getCountryOptions(locale), [locale])
  const today = todayIsoStockholm()

  // Today's share total, whatever "Per datum" shows (the reconciliation is always made against today).
  const noSharesToday = register ? register.reconciliation.register_shares === 0 : false
  // Nothing to list: the first-time state, also when the only entry has been voided (its history stays below).
  const showEmpty = Boolean(register) && noSharesToday && holders.length === 0
  const canAddEntry = isAdmin && Boolean(register) && !register?.is_avstamningsbolag
  // An entry is made against today's register: its dialogs wait for it when "Per datum" showed another day.
  const registerIsToday = !asOf && loadedAsOf === ''

  const failureIn = (where: DialogName) => (failure?.where === where ? failure.text : null)
  const refusal = (where: DialogName, body: unknown, fallback: string) => setFailure({ where, text: getErrorMessage(body, { locale, fallback }) })

  function openEvent(preset: Partial<FormState> = {}, mode: 'full' | 'quick' = 'full') {
    // Never an entry against an earlier day's holders: back to today.
    if (asOf) setAsOf('')
    setPreview(null)
    setFieldErrors({})
    setFailure(null)
    setQuick(mode === 'quick')
    // Nobody is preselected. With nobody in the registers yet there is nothing to choose from: a new name it is.
    const pick = people.length === 0 ? NEW_PARTY : ''
    setEventForm({
      ...EMPTY_EVENT,
      // Without shares there is nothing to transfer: the first entry is the bildande.
      kind: noSharesToday ? 'bildande' : 'overlatelse',
      event_date: today,
      to_party: pick,
      counter_party: pick,
      ...preset,
    } as FormState)
  }

  function closeEvent() {
    setEventForm(null)
    setPreview(null)
    setFieldErrors({})
    setFailure(null)
    setQuick(false)
  }

  function changeEvent(key: string, value: string) {
    setEventForm((form) => (form ? withField(form, key, value) : form))
    setFieldErrors((errors) => {
      // Another kind has other fields: its errors start over.
      if (key === 'kind') return {}
      if (!errors[key]) return errors
      const rest = { ...errors }
      delete rest[key]
      return rest
    })
  }

  async function previewEvent(typed: FormState | null = eventForm) {
    if (!typed) return
    // With nobody in the registers the pickers are not shown: a blank pick is a new name.
    const form = people.length === 0 ? { ...typed, to_party: typed.to_party || NEW_PARTY, counter_party: typed.counter_party || NEW_PARTY } : typed
    const built = buildEventBody(form, { today })
    if (!built.ok) {
      setFieldErrors(built.errors)
      setFailure(null)
      return
    }
    setFieldErrors({})
    setFailure(null)
    setBusy(true)
    try {
      const res = await fetch('/api/bolaget/share-register/events?dry_run=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.body),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Back to the form with what was typed and the server's sentence.
        setPreview(null)
        refusal('event', body, t('event_failed'))
        return
      }
      setPreview({ body: built.body, data: body.data as EventPreview })
    } catch {
      // No answer (offline, a dropped connection). A preview saves nothing.
      setFailure({ where: 'event', text: t('unreachable_preview') })
    } finally {
      setBusy(false)
    }
  }

  async function confirmEvent() {
    if (!preview) return
    setFailure(null)
    setBusy(true)
    try {
      const res = await fetch('/api/bolaget/share-register/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Exactly what was previewed, and the last entry the preview saw: the
        // server refuses the write when the register has moved on since.
        body: JSON.stringify({ ...preview.body, expected_last_event_number: preview.data.last_event_number }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (refusalCode(body) === 'SHARE_REGISTER_STALE') {
          // Another entry got in between: read the register as it is now and
          // go back to the form, so the next preview is made against it.
          setPreview(null)
          await load('')
        }
        refusal('event', body, t('event_failed'))
        return
      }
      // The outcome was stated before the write (the footer of the preview);
      // the new entry heads the history once the register is read again.
      closeEvent()
      await load('')
    } catch {
      // No answer: the entry may or may not have been saved. Trying again is
      // safe, since a saved entry moves the register on and the retry is refused.
      setFailure({ where: 'event', text: t('unreachable_write') })
    } finally {
      setBusy(false)
    }
  }

  /** "It is somebody else" (and back): said in the preview, then previewed again. */
  function setPartyIsNew(field: 'to' | 'counterparty', isNew: boolean) {
    if (!eventForm || busy) return
    const next = { ...eventForm, [`${field}_is_new`]: isNew ? 'true' : '' }
    setEventForm(next)
    void previewEvent(next)
  }

  function openPerson(partyId: string, name: string) {
    const p = personById.get(partyId)
    setFailure(null)
    setPerson({
      party_id: partyId,
      name,
      kind: p?.kind ?? 'person',
      personnummer: '',
      birth_date: p?.birth_date ?? '',
      foreign_id: '',
      address_line1: p?.address?.line1 ?? '',
      address_line2: p?.address?.line2 ?? '',
      postal_code: p?.address?.postal_code ?? '',
      city: p?.address?.city ?? '',
      country: p?.address?.country ?? '',
      email: p?.email ?? '',
      masked: p?.personnummer_masked ?? '',
      foreign_masked: p?.foreign_id_masked ?? '',
    })
  }

  async function savePerson() {
    if (!person) return
    setFailure(null)
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
      if (person.foreign_id.trim()) payload.foreign_id = person.foreign_id.trim()
      const res = await fetch(`/api/bolaget/people/${person.party_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return refusal('person', body, t('person_failed'))
      toast({ title: t('person_saved') })
      setPerson(null)
      await load(asOf)
    } catch {
      // No answer: said in the dialog, with what was typed still in it.
      setFailure({ where: 'person', text: t('unreachable_save') })
    } finally {
      setBusy(false)
    }
  }

  function openClass(form: FormState & { share_class_id?: string }) {
    // The vote shares a change is confirmed against are today's.
    if (asOf) setAsOf('')
    setFailure(null)
    setInputError(null)
    setClassForm(form)
  }

  /** Save the class, after a change of its votes per share has been confirmed with every holder's share before and after. */
  function submitClass() {
    if (!classForm) return
    const votes = parseDecimalInput(classForm.votes_per_share)
    if (votes === null || !(votes > 0)) {
      setInputError('votes')
      return
    }
    setInputError(null)
    const current = classes.find((c) => c.share_class_id === classForm.share_class_id)
    if (current && current.votes_per_share !== votes) {
      const shares = voteSharesAfter(holders, classes, current.share_class_id, votes).filter((h) => h.before_pct !== h.after_pct)
      setVotesConfirm({ code: current.code, before: current.votes_per_share, after: votes, shares })
      return
    }
    void saveClass(votes)
  }

  async function saveClass(votes: number) {
    if (!classForm) return
    setFailure(null)
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
      if (!res.ok) return refusal('class', body, t('class_failed'))
      const warnings = (body.warnings ?? []) as Array<{ message_sv?: string; message_en?: string }>
      toast({ title: t('class_saved'), ...(warnings.length > 0 ? { description: warnings.map((w) => (locale === 'en' ? w.message_en : w.message_sv)).join(' ') } : {}) })
      setClassForm(null)
      // A change of votes or förbehåll is noted in the aktiebok by the database: the history has a new entry.
      await load(asOf)
    } catch {
      // No answer: said in the drawer, with what was typed still in it.
      setFailure({ where: 'class', text: t('unreachable_save') })
    } finally {
      setBusy(false)
    }
  }

  async function toggleAvstamning() {
    if (!register) return
    setFailure(null)
    setBusy(true)
    try {
      const res = await fetch('/api/bolaget/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_avstamningsbolag: !register.is_avstamningsbolag }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return refusal('avstamning', body, t('avstamning_failed'))
      setConfirmAvstamning(false)
      await load(asOf)
    } catch {
      // No answer: said in the dialog, which stays open.
      setFailure({ where: 'avstamning', text: t('unreachable_save') })
    } finally {
      setBusy(false)
    }
  }

  async function saveCapital() {
    if (!capitalForm || !register) return
    const aktiekapital = parseAmountInput(capitalForm.aktiekapital)
    if (aktiekapital === null || aktiekapital <= 0 || !Number.isInteger(aktiekapital)) {
      setInputError('aktiekapital')
      return
    }
    setInputError(null)
    setFailure(null)
    setBusy(true)
    try {
      // Today's share total, never the total of an earlier "Per datum": the settings hold today's figures.
      const refused = await saveSettingsInDialog({ aktiekapital, antal_aktier: register.reconciliation.register_shares }, locale)
      if (refused) {
        setFailure({ where: 'capital', text: refused })
        return
      }
      setCapitalForm(null)
      await load(asOf)
    } finally {
      setBusy(false)
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

  /** A field of the entry form: its value, and the red hairline while it cannot be sent. */
  const eventField = (key: string) => ({
    id: `sr-${key}`,
    value: eventForm?.[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => changeEvent(key, e.target.value),
    'aria-invalid': fieldErrors[key] ? (true as const) : undefined,
  })
  const errorText = (key: string) => (fieldErrors[key] ? t(`err_${fieldErrors[key]}`) : undefined)

  // One ochre sentence: the most pressing of an entry the history cannot hold, mismatch, settings empty, incomplete identities.
  const attn = (() => {
    if (!register) return null
    const r = register.reconciliation
    const problem = register.note_problems[0]
    if (problem) {
      const more = register.note_problems.length - 1
      return (
        <AttnLine {...(canAddEntry ? { action: { label: t('attn_note_problem_action'), onClick: () => openEvent({ kind: 'rattelse', corrects_event_id: problem.share_register_event_id }) } } : {})}>
          {t('attn_note_problem', { number: problem.event_number, message: problem.message })}
          {more > 0 ? ` ${t('attn_note_problem_more', { count: more })}` : ''}
        </AttnLine>
      )
    }
    if (register.is_avstamningsbolag) return <AttnLine>{t('attn_avstamning')}</AttnLine>
    if (r.status === 'mismatch') return <AttnLine>{t('attn_mismatch', { register: r.register_shares, settings: r.settings_shares ?? 0 })}</AttnLine>
    if (r.status === 'settings_empty' && isAdmin) {
      return (
        <AttnLine
          action={{
            label: t('attn_settings_empty_action'),
            onClick: () => {
              setFailure(null)
              setInputError(null)
              setCapitalForm({ aktiekapital: '' })
            },
          }}
        >
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
  const correctedEntry = kind === 'rattelse' && eventForm ? eventsById.get(eventForm.corrects_event_id) : undefined
  const eventTitle = preview ? t('preview_title') : quick ? t('quick_title') : correctedEntry ? t('correct_title', { number: correctedEntry.event_number }) : t('new_event')
  const nameOf = (partyId: string) =>
    personById.get(partyId)?.name ?? holders.find((h) => h.party_id === partyId)?.name ?? preview?.data.matched_parties.find((m) => m.party_id === partyId)?.name ?? t('unknown_party')

  // The class being changed, and whether the change is one the database notes in the aktiebok (votes, förbehåll).
  const editedClass = classForm?.share_class_id ? classes.find((c) => c.share_class_id === classForm.share_class_id) : undefined
  const classChangeIsNoted = Boolean(
    classForm && editedClass && (parseDecimalInput(classForm.votes_per_share) !== editedClass.votes_per_share || FORBEHALL.some((k) => (classForm[`forbehall_${k}`] === 'true') !== editedClass[`forbehall_${k}`])),
  )
  // The drawer waits for today's register like an entry does; when that read failed it says so where the person is.
  const classFailure = failureIn('class') ?? (classForm && !registerIsToday && loadFailed ? t('load_failed') : null)
  // A country on file that the picker does not offer stays choosable, so opening the dialog never changes it.
  const storedCountry = person ? personById.get(person.party_id)?.address?.country ?? '' : ''

  /** Who an entry is for: somebody picked from the registers, or a new name with its kind. Nobody is preselected. */
  const partyPicker = (form: FormState, which: 'to' | 'counter', label: string) => {
    const pickKey = which === 'to' ? 'to_party' : 'counter_party'
    const nameKey = which === 'to' ? 'to_name' : 'counterparty_name'
    const kindKey = which === 'to' ? 'to_kind' : 'counterparty_kind'
    const orgKey = which === 'to' ? 'to_org_number' : 'counterparty_org_number'
    const hasPeople = people.length > 0
    const isNew = !hasPeople || form[pickKey] === NEW_PARTY
    return (
      <>
        {hasPeople && (
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor={`sr-${pickKey}`}>{label}</Label>
            <SettingsSelect {...eventField(pickKey)}>
              <option value="">{t('choose')}</option>
              <option value={NEW_PARTY}>{t('party_new')}</option>
              {people.map((p) => (
                <option key={p.party_id} value={p.party_id}>
                  {p.name}
                </option>
              ))}
            </SettingsSelect>
            <FieldNote error={errorText(pickKey)} />
          </div>
        )}
        {isNew && (
          <>
            <div className="space-y-1">
              <Label htmlFor={`sr-${nameKey}`}>{hasPeople ? t('field_name') : label}</Label>
              <Input {...eventField(nameKey)} maxLength={200} data-ph-mask="" />
              <FieldNote error={errorText(nameKey)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`sr-${kindKey}`}>{t('field_party_kind')}</Label>
              <SettingsSelect {...eventField(kindKey)}>
                <option value="person">{t('party_kind_person')}</option>
                <option value="company">{t('party_kind_company')}</option>
              </SettingsSelect>
            </div>
            {form[kindKey] === 'company' && (
              <div className="space-y-1">
                <Label htmlFor={`sr-${orgKey}`}>{t('field_org_number')}</Label>
                <Input {...eventField(orgKey)} maxLength={13} className="tabular-nums" />
              </div>
            )}
          </>
        )}
      </>
    )
  }

  /** The entry form. The quick start is the same form with the bildande's few fields. */
  const entryForm = (form: FormState) => {
    const counted = COUNTED_KINDS.includes(kind)
    const classField = counted && classes.length > 1 && (
      <div className="space-y-1">
        <Label htmlFor="sr-share_class_code">{t('field_class')}</Label>
        <SettingsSelect {...eventField('share_class_code')}>
          <option value="">{t('choose')}</option>
          {classes.map((c) => (
            <option key={c.share_class_id} value={c.code}>
              {c.code}
            </option>
          ))}
        </SettingsSelect>
      </div>
    )
    const countField = counted && (
      <div className="space-y-1">
        <Label htmlFor="sr-share_count">{t('field_share_count')}</Label>
        <Input {...eventField('share_count')} inputMode="numeric" className="tabular-nums" />
        <FieldNote error={errorText('share_count')} />
      </div>
    )
    const dateField = (
      <div className="space-y-1">
        <Label htmlFor="sr-event_date">{quick ? t('quick_date') : t('field_event_date')}</Label>
        <Input {...eventField('event_date')} type="date" max={today} className="tabular-nums" />
        <FieldNote error={errorText('event_date')} help={t('event_date_help')} />
      </div>
    )
    if (quick) {
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <p className="text-sm text-muted-foreground sm:col-span-2">{t('quick_intro')}</p>
          {partyPicker(form, 'to', t('quick_owner'))}
          {classField}
          {countField}
          {dateField}
          {classes.length === 0 && <p className="text-xs text-muted-foreground sm:col-span-2">{t('quick_hint')}</p>}
        </div>
      )
    }
    return (
      <div className="grid max-h-[60vh] gap-4 overflow-y-auto sm:grid-cols-2">
        {kind === 'rattelse' ? (
          // A rättelse is opened from the entry it voids: its kind is not a choice.
          <p className="text-sm text-muted-foreground sm:col-span-2" data-ph-mask="">
            {t('correct_intro', { text: correctedEntry?.text ?? '' })}
          </p>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="sr-kind">{t('field_kind')}</Label>
            <SettingsSelect {...eventField('kind')}>
              {SHARE_EVENT_KINDS.filter((k) => k !== 'rattelse').map((k) => (
                <option key={k} value={k}>
                  {t(`kind_${k}`)}
                </option>
              ))}
            </SettingsSelect>
          </div>
        )}
        {dateField}
        {classField}
        {kind === 'omvandling' && (
          <div className="space-y-1">
            <Label htmlFor="sr-to_share_class_code">{t('field_to_class')}</Label>
            <SettingsSelect {...eventField('to_share_class_code')}>
              <option value="">{t('choose')}</option>
              {classes.map((c) => (
                <option key={c.share_class_id} value={c.code}>
                  {c.code}
                </option>
              ))}
            </SettingsSelect>
            <FieldNote error={errorText('to_share_class_code')} />
          </div>
        )}
        {HOLDER_KINDS.includes(kind) && (
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="sr-from_party_id">{t('field_from')}</Label>
            <SettingsSelect {...eventField('from_party_id')}>
              <option value="">{t('choose')}</option>
              {holders.map((h) => (
                <option key={h.party_id} value={h.party_id}>
                  {h.name} ({formatCount(h.shares)})
                </option>
              ))}
            </SettingsSelect>
            <FieldNote error={errorText('from_party_id')} />
          </div>
        )}
        {RECEIVER_KINDS.includes(kind) && partyPicker(form, 'to', t('field_to'))}
        {COUNTERPARTY_KINDS.includes(kind) && partyPicker(form, 'counter', kind === 'pant' ? t('field_pledgee') : t('field_usufructuary'))}
        {RANGED_KINDS.includes(kind) && (
          <>
            {countField}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="sr-range_start">{t('field_range_start')}</Label>
                <Input {...eventField('range_start')} inputMode="numeric" className="tabular-nums" />
                <FieldNote error={errorText('range_start')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-range_end">{t('field_range_end')}</Label>
                <Input {...eventField('range_end')} inputMode="numeric" className="tabular-nums" />
                <FieldNote error={errorText('range_end')} />
              </div>
            </div>
            {counted && <p className="text-xs text-muted-foreground sm:col-span-2">{t('event_form_hint')}</p>}
          </>
        )}
        {kind === 'overlatelse' && (
          <div className="space-y-1">
            <Label htmlFor="sr-transfer_reason">{t('field_reason')}</Label>
            <SettingsSelect {...eventField('transfer_reason')}>
              {TRANSFER_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`reason_${r}`)}
                </option>
              ))}
            </SettingsSelect>
          </div>
        )}
        {PRICED_KINDS.includes(kind) && (
          <div className="space-y-1">
            <Label htmlFor="sr-price_total" optional>
              {t('field_price')}
            </Label>
            <Input {...eventField('price_total')} inputMode="decimal" className="tabular-nums" />
            <FieldNote error={errorText('price_total')} />
          </div>
        )}
        {(kind === 'split' || kind === 'sammanlaggning') && (
          <div className="space-y-1">
            <Label htmlFor="sr-ratio">{kind === 'split' ? t('field_ratio_split') : t('field_ratio_merge')}</Label>
            <Input {...eventField('ratio')} inputMode="numeric" className="tabular-nums" />
            <FieldNote error={errorText('ratio')} />
          </div>
        )}
        {kind === 'aktiebrev' && (
          <>
            <div className="space-y-1">
              <Label htmlFor="sr-aktiebrev_number">{t('field_aktiebrev_number')}</Label>
              <Input {...eventField('aktiebrev_number')} maxLength={40} />
              <FieldNote error={errorText('aktiebrev_number')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sr-aktiebrev_action">{t('field_aktiebrev_action')}</Label>
              <SettingsSelect {...eventField('aktiebrev_action')}>
                <option value="issued">{t('aktiebrev_issued')}</option>
                <option value="returned">{t('aktiebrev_returned')}</option>
              </SettingsSelect>
            </div>
          </>
        )}
        {(kind === 'pant' || kind === 'nyttjanderatt') && (
          <div className="space-y-1">
            <Label htmlFor="sr-note_status">{t(`field_status_${kind}`)}</Label>
            <SettingsSelect {...eventField('note_status')}>
              <option value="open">{t('note_open')}</option>
              <option value="closed">{t('note_closed')}</option>
            </SettingsSelect>
          </div>
        )}
        {REGISTERED_KINDS.includes(kind) && (
          <div className="space-y-1">
            <Label htmlFor="sr-registered_on" optional>
              {t('field_registered_on')}
            </Label>
            <Input {...eventField('registered_on')} type="date" className="tabular-nums" />
          </div>
        )}
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="sr-note" optional={kind !== 'rattelse' && kind !== 'anteckning'}>
            {kind === 'rattelse' ? t('field_correct_reason') : kind === 'anteckning' ? t('field_note_text') : t('field_comment')}
          </Label>
          <Textarea {...eventField('note')} maxLength={2000} rows={2} data-ph-mask="" />
          <FieldNote error={errorText('note')} />
        </div>
        {kind === 'overlatelse' && classHasForbehall && (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <Checkbox checked={form.forbehall_cleared === 'true'} onCheckedChange={(v) => changeEvent('forbehall_cleared', v === true ? 'true' : '')} />
            <span>{t('forbehall_cleared')}</span>
          </label>
        )}
      </div>
    )
  }

  const holderColumns = classes.length > 1 ? 8 : 7

  return (
    <div className="space-y-8">
      <BolagetHeader
        title={tNav('v3_share_register')}
        subtitle={t('subtitle')}
        help={t('help')}
        asOf={asOf}
        onAsOfChange={setAsOf}
        asOfLabel={t('as_of')}
        toolbarEnd={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="toolbar">
                <ArrowDownTrayIcon className="h-4 w-4" />
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
        }
        action={
          // One primary per view: while the register has no shares it is the empty state's "Lägg in ägarna".
          canAddEntry && !showEmpty ? (
            <Button onClick={() => openEvent()}>
              <PlusIcon className="h-4 w-4" />
              {t('new_event')}
            </Button>
          ) : undefined
        }
      />

      {loadFailed && data ? (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load(asOf) }}>{tCommon('refresh_failed')}</AttnLine>
      ) : (
        attn
      )}

      {loading && !data ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </LateReveal>
      ) : loadFailed && !data ? (
        <LoadError title={t('load_failed')} onRetry={() => void load(asOf)} />
      ) : register ? (
        <>
          {showEmpty ? (
            <EmptyState
              // Entries that were all voided leave no shares, and stay in the history below.
              title={events.length > 0 ? t('empty_title_voided') : t('empty_title')}
              description={events.length > 0 ? t('empty_description_voided') : t('empty_description')}
              {...(canAddEntry
                ? {
                    actionLabel: t('quick_action'),
                    onAction: () =>
                      openEvent(
                        {
                          kind: 'bildande',
                          // The quick start asks when the shares were issued: no date is assumed.
                          event_date: '',
                          share_count: register.reconciliation.settings_shares ? String(register.reconciliation.settings_shares) : '',
                        },
                        'quick',
                      ),
                  }
                : {})}
            />
          ) : (
            <section className="space-y-3">
              <div>
                <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('holders_heading')}</h2>
                <p className="text-[13px] text-muted-foreground">
                  {t('totals', { shares: register.total_shares, votes: register.total_votes, date: formatDate(register.as_of) })}
                </p>
              </div>
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_holder')}</th>
                      <th className={cn(TH_CLASS, PHONE_HIDDEN)}>{t('col_identity')}</th>
                      {classes.length > 1 && <th className={cn(TH_CLASS, PHONE_HIDDEN)}>{t('col_class')}</th>}
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_capital')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('col_votes')}</th>
                      <th className={cn(TH_CLASS, PHONE_HIDDEN)}>{t('col_numbers')}</th>
                      <th className={TH_CLASS} />
                    </tr>
                  </thead>
                  <tbody>
                    {holders.map((h) => (
                      <tr key={h.party_id} className="group hover:bg-secondary/35">
                        <td className={TD_CLASS} data-ph-mask="">
                          {h.name}
                          {h.officer && <span className="ml-2 text-xs text-muted-foreground">{t('officer')}</span>}
                        </td>
                        <td className={cn(TD_CLASS, PHONE_HIDDEN, 'tabular-nums')} data-ph-mask="">
                          {h.identity ?? <Badge variant="outline">{t('identity_missing')}</Badge>}
                        </td>
                        {classes.length > 1 && (
                          <td className={cn(TD_CLASS, PHONE_HIDDEN, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                            {h.by_class.map((c) => `${c.code} ${formatCount(c.shares)}`).join(', ')}
                          </td>
                        )}
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCount(h.shares)}</td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{pct(h.capital_pct)}</td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{pct(h.votes_pct)}</td>
                        <td className={cn(TD_CLASS, PHONE_HIDDEN, 'tabular-nums text-muted-foreground')}>
                          {h.ranges.map((r) => shareNumbersLabel(r.range_start, r.range_end, formatCount)).join(', ')}
                        </td>
                        <td className={ROW_ACTIONS_TD}>
                          <Button variant="row" asChild>
                            <a href={`/api/bolaget/holders/${h.party_id}/extract${asOf ? `?as_of=${asOf}` : ''}`}>{t('extract')}</a>
                          </Button>
                          {isAdmin && (
                            <Button variant="row" onClick={() => openPerson(h.party_id, h.name)}>
                              {t('edit_details')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {holders.length === 0 ? (
                      <tr>
                        <td colSpan={holderColumns} className={cn(TD_CLASS, 'text-muted-foreground')}>
                          {t('holders_none_as_of', { date: formatDate(register.as_of) })}
                        </td>
                      </tr>
                    ) : (
                      <tr className={SUM_ROW_CLASS}>
                        <td className={TD_CLASS}>{t('total_row')}</td>
                        <td className={cn(TD_CLASS, PHONE_HIDDEN)} />
                        {classes.length > 1 && <td className={cn(TD_CLASS, PHONE_HIDDEN)} />}
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCount(register.total_shares)}</td>
                        {/* The holders are the whole: 100 %, not the sum of their rounded shares (which can read 99,99 %). */}
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{pct(100)}</td>
                        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{pct(100)}</td>
                        <td className={cn(TD_CLASS, PHONE_HIDDEN)} />
                        <td className={TD_CLASS} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {register.notes.length > 0 && (
                <div className="space-y-1 pt-2">
                  {register.notes.map((n) => (
                    <div key={`${n.kind}-${n.event_number}-${n.range_start}`} className="flex flex-wrap items-baseline gap-3 text-xs text-muted-foreground">
                      <span>
                        {n.kind === 'aktiebrev'
                          ? t('note_aktiebrev', { number: n.aktiebrev_number ?? '', from: n.range_start, to: n.range_end })
                          : n.kind === 'pant'
                            ? t('note_pant', { name: n.counterparty_name ?? '', from: n.range_start, to: n.range_end })
                            : t('note_nyttjanderatt', { name: n.counterparty_name ?? '', from: n.range_start, to: n.range_end })}
                      </span>
                      {n.kind === 'aktiebrev' && (
                        <a className={QUIET_LINK_CLASS} href={`/api/bolaget/aktiebrev/${events.find((e) => e.event_number === n.event_number)?.share_register_event_id ?? ''}`}>
                          {t('print_aktiebrev')}
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {(!showEmpty || classes.length > 0) && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('classes_heading')}</h2>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      openClass({ code: '', name: '', votes_per_share: '1', forbehall_samtycke: '', forbehall_forkop: '', forbehall_hembud: '', forbehall_omvandling: '', forbehall_inlosen: '', forbehall_text: '', bolagsordning_reference: '' })
                    }
                  >
                    <PlusIcon className="h-4 w-4" />
                    {t('class_add')}
                  </Button>
                )}
              </div>
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
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
                      <tr key={c.share_class_id} className="group hover:bg-secondary/35">
                        <td className={TD_CLASS}>
                          {c.code}
                          {c.name ? <span className="ml-2 text-muted-foreground">{c.name}</span> : null}
                        </td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{c.votes_per_share.toLocaleString('sv-SE')}</td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{formatCount(c.shares)}</td>
                        <td className={cn(TD_CLASS, 'text-muted-foreground')}>
                          {FORBEHALL.filter((k) => c[`forbehall_${k}`])
                            .map((k) => t(`forbehall_${k}`))
                            .join(', ') || t('forbehall_none')}
                        </td>
                        <td className={ROW_ACTIONS_TD}>
                          {isAdmin && (
                            <Button
                              variant="row"
                              onClick={() =>
                                openClass({
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
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {events.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('history_heading')}</h2>
              <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
                <table className="stagger-enter w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={TH_CLASS}>{t('col_number')}</th>
                      <th className={TH_CLASS}>{t('col_date')}</th>
                      <th className={cn(TH_CLASS, PHONE_HIDDEN)}>{t('col_entered')}</th>
                      <th className={TH_CLASS}>{t('col_entry')}</th>
                      <th className={TH_CLASS} />
                    </tr>
                  </thead>
                  <tbody>
                    {[...events].reverse().map((e) => (
                      <tr key={e.share_register_event_id} className="group hover:bg-secondary/35">
                        <td className={cn(TD_CLASS, 'tabular-nums')}>{e.event_number}</td>
                        <td className={cn(TD_CLASS, 'date-figures whitespace-nowrap')}>{formatDate(e.event_date)}</td>
                        <td className={cn(TD_CLASS, PHONE_HIDDEN, 'date-figures whitespace-nowrap text-muted-foreground')}>{formatDate(e.entered_at)}</td>
                        <td className={cn(TD_CLASS, 'min-w-56', e.voided && 'text-muted-foreground line-through')} data-ph-mask="">
                          {e.text}
                          {e.voided && <span className="ml-2 no-underline">{t('voided')}</span>}
                        </td>
                        <td className={ROW_ACTIONS_TD}>
                          {e.kind === 'aktiebrev' && e.aktiebrev_action === 'issued' && !e.voided && (
                            <Button variant="row" asChild>
                              <a href={`/api/bolaget/aktiebrev/${e.share_register_event_id}`}>{t('print_aktiebrev')}</a>
                            </Button>
                          )}
                          {canAddEntry && !e.voided && e.kind !== 'rattelse' && (
                            <Button variant="row" onClick={() => openEvent({ kind: 'rattelse', corrects_event_id: e.share_register_event_id })}>
                              {t('correct')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : null}

      {register && isAdmin && (
        <p className="text-xs text-muted-foreground">
          {register.is_avstamningsbolag ? t('avstamning_yes') : t('avstamning_no')}{' '}
          <button
            type="button"
            className={QUIET_LINK_CLASS}
            onClick={() => {
              setFailure(null)
              setConfirmAvstamning(true)
            }}
          >
            {t('avstamning_change')}
          </button>
        </p>
      )}
      {/* A member can keep the books but not the aktiebok: said once, instead of a form that is refused. */}
      {register && canWrite && !isAdmin && <p className="text-xs text-muted-foreground">{t('member_note')}</p>}

      <Dialog open={confirmAvstamning} onOpenChange={(open) => (open || busy ? null : setConfirmAvstamning(false))}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{register?.is_avstamningsbolag ? t('avstamning_unset_title') : t('avstamning_set_title')}</DialogTitle>
            <DialogDescription className="text-[13px] leading-5">
              {register?.is_avstamningsbolag ? t('avstamning_unset_description') : t('avstamning_set_description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <FooterNote failure={failureIn('avstamning')} />
            <Button variant="ghost" onClick={() => setConfirmAvstamning(false)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void toggleAvstamning()} loading={busy}>
              {t('avstamning_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(eventForm)} onOpenChange={(open) => (open || busy ? null : closeEvent())}>
        <DialogContent size={quick ? 'form' : 'wide'}>
          <DialogHeader>
            <DialogTitle>{eventTitle}</DialogTitle>
          </DialogHeader>
          {!eventForm ? null : !registerIsToday ? (
            loadFailed ? (
              <LoadError title={t('load_failed')} onRetry={() => void load('')} />
            ) : (
              <LateReveal className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </LateReveal>
            )
          ) : preview ? (
            <EntryPreview preview={preview.data} body={preview.body} today={today} nameOf={nameOf} voidedText={correctedEntry?.text ?? ''} onPartyIsNew={setPartyIsNew} />
          ) : (
            entryForm(eventForm)
          )}
          <DialogFooter>
            {preview ? (
              <>
                {/* Stated before the write, not commented on after it: the number the entry gets, and that it stays. */}
                <FooterNote failure={failureIn('event')}>{t('preview_consequence', { number: preview.data.last_event_number + 1 })}</FooterNote>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPreview(null)
                    setFailure(null)
                  }}
                  disabled={busy}
                >
                  {t('back')}
                </Button>
                <Button onClick={() => void confirmEvent()} loading={busy}>
                  {t('confirm_event')}
                </Button>
              </>
            ) : (
              <>
                <FooterNote failure={failureIn('event')} />
                <Button variant="ghost" onClick={closeEvent} disabled={busy}>
                  {t('cancel')}
                </Button>
                {quick && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuick(false)
                      setFieldErrors({})
                    }}
                    disabled={busy}
                  >
                    {t('manual_action')}
                  </Button>
                )}
                <Button onClick={() => void previewEvent()} loading={busy} disabled={!registerIsToday}>
                  {t('preview')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(person)} onOpenChange={(open) => (open || busy ? null : setPerson(null))}>
        <DialogContent size="form">
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
                <Label htmlFor="sr-foreign_id" optional>
                  {t('field_foreign_id')}
                </Label>
                <Input
                  {...field(person, setPerson as (s: FormState) => void, 'foreign_id')}
                  placeholder={person.foreign_masked}
                  autoComplete="off"
                  maxLength={64}
                  className="tabular-nums"
                  data-ph-mask=""
                />
              </div>
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
                {/* A country is stored as its two-letter code: picked by name, never typed ("Sverige" became "SV"). */}
                <SettingsSelect {...field(person, setPerson as (s: FormState) => void, 'country')}>
                  <option value="">{t('country_none')}</option>
                  {storedCountry && !countryOptions.some((option) => option.code === storedCountry) && <option value={storedCountry}>{storedCountry}</option>}
                  {countryOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {locale === 'en' ? option.nameEn : option.name}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sr-email">{t('field_email')}</Label>
                <Input {...field(person, setPerson as (s: FormState) => void, 'email')} type="email" maxLength={254} data-ph-mask="" />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('person_hint')}</p>
            </div>
          )}
          <DialogFooter>
            <FooterNote failure={failureIn('person')} />
            <Button variant="ghost" onClick={() => setPerson(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void savePerson()} loading={busy}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A share class is a small record: added and changed in a drawer over the register (V7 creation forms). */}
      <SlideOver open={Boolean(classForm)} onOpenChange={(open) => (open || busy ? null : setClassForm(null))}>
        <SlideOverContent aria-describedby={undefined}>
          <SlideOverHeader title={classForm?.share_class_id ? t('class_edit_title', { code: classForm.code }) : t('class_add')} />
          <SlideOverBody>
            {classForm && (
              <div className="grid gap-4 sm:grid-cols-2">
                {!classForm.share_class_id && (
                  <div className="space-y-1">
                    <Label htmlFor="sr-code">{t('field_class_code')}</Label>
                    <Input {...field(classForm, setClassForm as (s: FormState) => void, 'code')} maxLength={12} />
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="sr-name" optional>
                    {t('field_class_name')}
                  </Label>
                  <Input {...field(classForm, setClassForm as (s: FormState) => void, 'name')} maxLength={100} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sr-votes_per_share">{t('col_votes_per_share')}</Label>
                  <Input
                    {...field(classForm, setClassForm as (s: FormState) => void, 'votes_per_share')}
                    inputMode="decimal"
                    className="tabular-nums"
                    aria-invalid={inputError === 'votes' ? true : undefined}
                  />
                  <FieldNote error={inputError === 'votes' ? t('class_invalid') : undefined} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  {FORBEHALL.map((k) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={classForm[`forbehall_${k}`] === 'true'} onCheckedChange={(v) => setClassForm({ ...classForm, [`forbehall_${k}`]: v === true ? 'true' : '' })} />
                      <span>{t(`forbehall_${k}_long`)}</span>
                    </label>
                  ))}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="sr-forbehall_text" optional>
                    {t('field_forbehall_text')}
                  </Label>
                  <Textarea {...field(classForm, setClassForm as (s: FormState) => void, 'forbehall_text')} maxLength={4000} rows={3} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="sr-bolagsordning_reference" optional>
                    {t('field_bolagsordning_reference')}
                  </Label>
                  <Input {...field(classForm, setClassForm as (s: FormState) => void, 'bolagsordning_reference')} maxLength={200} />
                </div>
              </div>
            )}
          </SlideOverBody>
          <SlideOverFooter>
            {classFailure ? (
              <p role="alert" className="mr-auto min-w-0 text-[12px] leading-4 text-destructive" data-ph-mask="">
                {classFailure}
              </p>
            ) : (
              classChangeIsNoted && <p className="mr-auto min-w-0 text-[12px] leading-4 text-muted-foreground">{t('class_note_consequence')}</p>
            )}
            <Button variant="ghost" onClick={() => setClassForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={submitClass} loading={busy} disabled={!registerIsToday}>
              {classForm?.share_class_id ? t('save') : t('class_create')}
            </Button>
          </SlideOverFooter>
        </SlideOverContent>
      </SlideOver>

      {/* Votes per share change every holder's share of the votes: confirmed with before and after. */}
      <ConfirmDialog
        open={Boolean(votesConfirm)}
        onOpenChange={(open) => (open ? null : setVotesConfirm(null))}
        title={t('class_votes_title', { code: votesConfirm?.code ?? '' })}
        description={t('class_votes_description', { before: votesConfirm?.before ?? 0, after: votesConfirm?.after ?? 0 })}
        confirmLabel={t('save')}
        onConfirm={() => (votesConfirm ? saveClass(votesConfirm.after) : undefined)}
      >
        <div className="max-h-[40vh] space-y-1 overflow-y-auto text-[13px] tabular-nums text-muted-foreground">
          {!votesConfirm || votesConfirm.shares.length === 0 ? (
            <p>{t('class_votes_unchanged')}</p>
          ) : (
            votesConfirm.shares.map((h) => (
              <p key={h.party_id} data-ph-mask="">
                {t('class_votes_holder', { name: h.name, before: pct(h.before_pct), after: pct(h.after_pct) })}
              </p>
            ))
          )}
        </div>
      </ConfirmDialog>

      <Dialog open={Boolean(capitalForm)} onOpenChange={(open) => (open || busy ? null : setCapitalForm(null))}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t('capital_title')}</DialogTitle>
          </DialogHeader>
          {capitalForm && register && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t('capital_intro', { shares: register.reconciliation.register_shares })}</p>
              <div className="space-y-1">
                <Label htmlFor="sr-aktiekapital">{t('field_aktiekapital')}</Label>
                <Input
                  {...field(capitalForm, setCapitalForm as (s: FormState) => void, 'aktiekapital')}
                  inputMode="numeric"
                  className="tabular-nums"
                  aria-invalid={inputError === 'aktiekapital' ? true : undefined}
                />
                <FieldNote error={inputError === 'aktiekapital' ? t('capital_invalid') : undefined} />
              </div>
            </div>
          )}
          <DialogFooter>
            <FooterNote failure={failureIn('capital')} />
            <Button variant="ghost" onClick={() => setCapitalForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void saveCapital()} loading={busy}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
