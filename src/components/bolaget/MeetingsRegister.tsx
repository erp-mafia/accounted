'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { BolagetHeader } from './BolagetHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverFooter, SlideOverHeader } from '@/components/ui/slide-over'
import { LIST_BLEED_CLASS, TD_CLASS, TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { PHONE_HIDDEN, SUM_ROW_CLASS } from './register-table'
import { SettingsSelect } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { fetchSigningAvailability } from '@/components/signing/signing-client'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { cn, formatDate } from '@/lib/utils'
import { parseAmountInput, parseDecimalInput } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { ATTENDEE_CAPACITIES, DECISION_KINDS, DECISION_OUTCOMES, MEETING_KINDS, type DecisionKind } from '@/lib/bolaget/meetings/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { ArrowDownTrayIcon, PlusIcon, TrashIcon } from '@/components/icons'

type Payload = Record<string, unknown>

interface MeetingSummary {
  corporate_meeting_id: string
  kind: (typeof MEETING_KINDS)[number]
  organ: 'bolagsstamma' | 'styrelse'
  title: string
  sequence_number: number | null
  meeting_date: string
  place: string | null
  is_digital: boolean
  status: 'draft' | 'held' | 'signed'
  signing_pending: boolean
}

interface Person {
  party_id: string
  name: string
}

interface DecisionRow {
  corporate_decision_id: string
  item_number: number
  kind: DecisionKind
  title: string
  text: string | null
  text_rendered: string
  payload: Payload
  outcome: (typeof DECISION_OUTCOMES)[number]
  votes_for: number | null
  votes_against: number | null
  votes_abstained: number | null
  reservations: string | null
}

interface Effect {
  action: 'add' | 'end' | 'keep'
  role: string
  name: string
  date: string
}

interface MeetingDetail extends MeetingSummary {
  meeting_time: string | null
  chair: Person | null
  secretary: Person | null
  adjusters: Person[]
  kallelse_date: string | null
  kallelse_method: string | null
  kallelse_window: { earliest: string; latest: string } | null
  fiscal_period: { period_start: string; period_end: string } | null
  voting_list: { as_of: string; total_shares: number; total_votes: number; holders: Array<{ party_id: string; name: string; shares: number; votes: number; present: boolean; proxy_name: string | null }> } | null
  attendees: Array<{ party_id: string | null; name: string; capacity: (typeof ATTENDEE_CAPACITIES)[number]; present: boolean }>
  notes: string | null
  signature_names: string | null
  signed_document_id: string | null
  decisions: DecisionRow[]
  justering: string
  signers: Array<{ party_id: string; name: string; role_label: string; has_email: boolean }>
  register_effects: { planned: Effect[]; kept: Effect[]; applied: { added: Array<{ name: string; role: string; date: string | null }>; ended: Array<{ name: string; role: string; date: string | null }> } }
  warnings: Array<{ code: string; message_sv: string; message_en: string }>
  signing: { status: string; signers: Array<{ name: string; role_label: string | null; status: string }> } | null
}

interface FiscalPeriod {
  id: string
  name: string | null
  period_start: string
  period_end: string
}

type FieldType = 'money' | 'int' | 'date' | 'text' | 'textarea' | 'bool'

/** The scalar terms each decision kind is edited by; the lists (elections, discharge) have their own editors. */
const PAYLOAD_FIELDS: Partial<Record<DecisionKind, Array<{ key: string; type: FieldType; options?: readonly string[] }>>> = {
  resultatdisposition: [
    { key: 'follows_board_proposal', type: 'bool' },
    { key: 'available_amount', type: 'money' },
    { key: 'dividend_total', type: 'money' },
    { key: 'carried_forward', type: 'money' },
    { key: 'board_proposal_text', type: 'textarea' },
  ],
  utdelning: [
    { key: 'amount_per_share', type: 'money' },
    { key: 'share_count', type: 'int' },
    { key: 'total_amount', type: 'money' },
    { key: 'payment_date', type: 'date' },
    { key: 'share_class_code', type: 'text' },
  ],
  arvoden: [
    { key: 'board_fee_total', type: 'money' },
    { key: 'auditor_fee', type: 'text' },
  ],
  andrad_bolagsordning: [
    { key: 'sections', type: 'text' },
    { key: 'new_wording', type: 'textarea' },
  ],
  nyemission: [
    { key: 'share_count', type: 'int' },
    { key: 'price_per_share', type: 'money' },
    { key: 'share_class_code', type: 'text' },
    { key: 'subscription_end', type: 'date' },
    { key: 'payment_date', type: 'date' },
  ],
  fondemission: [
    { key: 'amount', type: 'money' },
    { key: 'new_share_count', type: 'int' },
    { key: 'source', type: 'text' },
  ],
  minskning: [
    { key: 'amount', type: 'money' },
    { key: 'cancelled_share_count', type: 'int' },
  ],
  optioner: [
    { key: 'option_count', type: 'int' },
    { key: 'strike_price', type: 'money' },
    { key: 'subscription_end', type: 'date' },
    { key: 'exercise_end', type: 'date' },
  ],
  aterbetalning_villkorat_tillskott: [
    { key: 'total_amount', type: 'money' },
    { key: 'payment_date', type: 'date' },
  ],
  val_styrelse: [{ key: 'term', type: 'text' }],
  val_revisor: [
    { key: 'term', type: 'text' },
    { key: 'no_auditor', type: 'bool' },
  ],
}

const BOARD_ROLES = ['styrelseledamot', 'styrelseordforande', 'styrelsesuppleant'] as const
const AUDITOR_ROLES = ['revisor', 'huvudansvarig_revisor', 'revisorssuppleant'] as const
const NEW = '__new'

/** The payload with the scalar fields as the API wants them: numbers, dates, nulls. */
function cleanPayload(kind: DecisionKind, draft: Payload): Payload {
  const out: Payload = { ...draft }
  for (const f of PAYLOAD_FIELDS[kind] ?? []) {
    const v = draft[f.key]
    if (f.type === 'bool') out[f.key] = Boolean(v)
    else if (f.type === 'money') out[f.key] = typeof v === 'number' ? v : parseAmountInput(String(v ?? ''))
    else if (f.type === 'int') out[f.key] = typeof v === 'number' ? v : parseDecimalInput(String(v ?? ''))
    else out[f.key] = typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }
  if (kind === 'val_styrelse') out.members = ((draft.members as Payload[] | undefined) ?? []).filter((m) => String(m.name ?? '').trim())
  if (kind === 'val_revisor') out.auditors = ((draft.auditors as Payload[] | undefined) ?? []).filter((m) => String(m.name ?? '').trim())
  return out
}

/**
 * Möten och protokoll: bolagsstämmor, styrelsemöten and per capsulam
 * decisions (ABL 7 kap., 8:24-26). The list of meetings, and one meeting
 * with its agenda and decisions, röstlängd or attendance, the effects on
 * the roles, the minutes PDF and the signing.
 */
export function MeetingsRegister() {
  const t = useTranslations('bolaget_meetings')
  const tRoles = useTranslations('bolaget_roles')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { canWrite } = useCanWrite()

  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  // The list or the open meeting could not be read: said in the page, in
  // place of what did not load (or as one line above a list on screen).
  const [listFailed, setListFailed] = useState(false)
  const [meetingFailed, setMeetingFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const { periods: periodRows } = useFiscalPeriods()
  const periods = useMemo(() => [...(periodRows as FiscalPeriod[])].sort((a, z) => z.period_start.localeCompare(a.period_start)), [periodRows])
  const [bankIdAvailable, setBankIdAvailable] = useState(false)

  const [createForm, setCreateForm] = useState<Record<string, string> | null>(null)
  const [editForm, setEditForm] = useState<Record<string, string | string[] | boolean> | null>(null)
  const [decisionForm, setDecisionForm] = useState<{ id: string | null; kind: DecisionKind; title: string; text: string; outcome: string; votes_for: string; votes_against: string; votes_abstained: string; reservations: string; payload: Payload } | null>(null)
  const [confirmHold, setConfirmHold] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletingDecision, setDeletingDecision] = useState<DecisionRow | null>(null)
  const [signForm, setSignForm] = useState<{ mode: 'bankid' | 'manual'; signedOn: string; names: string; file: File | null } | null>(null)
  const [signerLinks, setSignerLinks] = useState<Array<{ name: string; url: string }>>([])

  const fail = useCallback(
    (title: string, body: unknown) => toast({ title, description: getErrorMessage(body, { locale, fallback: title }), variant: 'destructive' }),
    [locale, toast],
  )

  const select = useCallback((id: string | null) => {
    setSelectedId(id)
    setMeeting(null)
    try {
      const url = new URL(window.location.href)
      if (id) url.searchParams.set('id', id)
      else url.searchParams.delete('id')
      window.history.replaceState(null, '', url.toString())
    } catch {
      // The address only mirrors the selection.
    }
  }, [])

  const loadList = useCallback(async () => {
    const res = await fetch('/api/bolaget/meetings').catch(() => null) // unreachable: listFailed
    if (!res?.ok) {
      setListFailed(true)
      return
    }
    const body = await res.json().catch(() => ({}))
    setMeetings((body.data?.meetings ?? []) as MeetingSummary[])
    setListFailed(false)
  }, [])

  const loadMeeting = useCallback(
    async (id: string) => {
      setMeetingFailed(false)
      const res = await fetch(`/api/bolaget/meetings/${id}`).catch(() => null) // unreachable: meetingFailed
      // A meeting that no longer exists: back to the list.
      if (res?.status === 404) return select(null)
      if (!res?.ok) {
        setMeetingFailed(true)
        return
      }
      const body = await res.json().catch(() => ({}))
      setMeeting(body.data as MeetingDetail)
    },
    [select],
  )

  useEffect(() => {
    const initial = new URL(window.location.href).searchParams.get('id')
    if (initial) setSelectedId(initial)
    void (async () => {
      setLoading(true)
      try {
        await loadList()
      } finally {
        setLoading(false)
      }
    })()
    void fetchSigningAvailability()
      .then((a) => setBankIdAvailable(a.available))
      .catch(() => setBankIdAvailable(false))
    void fetch('/api/bolaget/share-register')
      .then((r) => r.json())
      .then((b) => {
        const all = ((b.data?.people ?? []) as Array<{ party_id: string; name: string }>).map((p) => ({ party_id: p.party_id, name: p.name }))
        setPeople(all.sort((a, z) => a.name.localeCompare(z.name, 'sv')))
      })
      .catch(() => setPeople([]))
  }, [loadList])

  useEffect(() => {
    if (selectedId) void loadMeeting(selectedId)
  }, [selectedId, loadMeeting])

  async function send(url: string, init: RequestInit, failTitle: string): Promise<Record<string, unknown> | null> {
    setBusy(true)
    try {
      const res = await fetch(url, init)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        fail(failTitle, body)
        return null
      }
      const warnings = (body.warnings ?? []) as Array<{ message_sv: string; message_en: string }>
      if (warnings.length > 0) toast({ title: t('warnings_title'), description: warnings.map((w) => (locale === 'en' ? w.message_en : w.message_sv)).join(' ') })
      return body as Record<string, unknown>
    } finally {
      setBusy(false)
    }
  }

  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  async function refresh() {
    await loadList()
    if (selectedId) await loadMeeting(selectedId)
  }

  async function create() {
    if (!createForm) return
    const body: Record<string, unknown> = { kind: createForm.kind, meeting_date: createForm.meeting_date }
    if (createForm.kind === 'per_capsulam') body.organ = createForm.organ
    if (createForm.kind === 'arsstamma') body.fiscal_period_id = createForm.fiscal_period_id || null
    if (createForm.place.trim()) body.place = createForm.place.trim()
    if (createForm.meeting_time) body.meeting_time = createForm.meeting_time
    const result = await send('/api/bolaget/meetings', json('POST', body), t('save_failed'))
    if (!result) return
    toast({ title: t('created') })
    setCreateForm(null)
    await loadList()
    select(((result.data as { corporate_meeting_id: string }) ?? {}).corporate_meeting_id)
  }

  async function patch(body: Record<string, unknown>, successTitle?: string): Promise<boolean> {
    if (!meeting) return false
    const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}`, json('PATCH', body), t('save_failed'))
    if (!result) return false
    if (successTitle) toast({ title: successTitle })
    await refresh()
    return true
  }

  async function saveEdit() {
    if (!editForm || !meeting) return
    const body: Record<string, unknown> = {
      meeting_date: editForm.meeting_date,
      meeting_time: editForm.meeting_time || null,
      place: editForm.place || null,
      is_digital: Boolean(editForm.is_digital),
      kallelse_date: editForm.kallelse_date || null,
      kallelse_method: editForm.kallelse_method || null,
      notes: editForm.notes || null,
      adjuster_party_ids: editForm.adjusters as string[],
    }
    for (const role of ['chair', 'secretary'] as const) {
      const value = editForm[role] as string
      if (value === NEW) {
        const name = String(editForm[`${role}_name`] ?? '').trim()
        body[`${role}_party_id`] = null
        if (name) body[`${role}_name`] = name
      } else {
        body[`${role}_party_id`] = value || null
      }
    }
    if (await patch(body, t('saved'))) setEditForm(null)
  }

  async function saveDecision() {
    if (!decisionForm || !meeting) return
    const number = (v: string) => parseDecimalInput(v)
    const body: Record<string, unknown> = {
      kind: decisionForm.kind,
      title: decisionForm.title.trim() || null,
      text: decisionForm.text.trim() || null,
      outcome: decisionForm.outcome,
      payload: cleanPayload(decisionForm.kind, decisionForm.payload),
      votes_for: number(decisionForm.votes_for),
      votes_against: number(decisionForm.votes_against),
      votes_abstained: number(decisionForm.votes_abstained),
      reservations: decisionForm.reservations.trim() || null,
    }
    if (decisionForm.id) body.corporate_decision_id = decisionForm.id
    const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}/decisions`, json('POST', body), t('save_failed'))
    if (!result) return
    toast({ title: t('decision_saved') })
    setDecisionForm(null)
    await refresh()
  }

  async function removeDecision() {
    if (!deletingDecision || !meeting) return
    const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}/decisions/${deletingDecision.corporate_decision_id}`, { method: 'DELETE' }, t('save_failed'))
    setDeletingDecision(null)
    if (result) await refresh()
  }

  async function hold() {
    if (!meeting) return
    const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}/hold`, { method: 'POST' }, t('hold_failed'))
    if (!result) return
    toast({ title: t('held') })
    await refresh()
  }

  async function removeMeeting() {
    if (!meeting) return
    const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}`, { method: 'DELETE' }, t('delete_failed'))
    if (!result) return
    toast({ title: t('deleted') })
    select(null)
    await loadList()
  }

  async function sign() {
    if (!signForm || !meeting) return
    if (signForm.mode === 'bankid') {
      const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}/bankid`, { method: 'POST' }, t('sign_failed'))
      if (!result) return
      const signers = ((result.data as { signers?: Array<{ name: string; url: string | null }> })?.signers ?? []).filter((s): s is { name: string; url: string } => Boolean(s.url))
      setSignerLinks(signers)
      toast({ title: t('bankid_started') })
    } else {
      const data = new FormData()
      data.set('signed_on', signForm.signedOn)
      data.set('signature_names', signForm.names)
      if (signForm.file) data.set('file', signForm.file)
      const result = await send(`/api/bolaget/meetings/${meeting.corporate_meeting_id}/sign`, { method: 'POST', body: data }, t('sign_failed'))
      if (!result) return
      toast({ title: t('signed') })
    }
    setSignForm(null)
    await refresh()
  }

  async function togglePresence(partyId: string, present: boolean) {
    await patch({ presence: [{ party_id: partyId, present }] })
  }

  async function toggleAttendee(index: number, present: boolean) {
    if (!meeting) return
    await patch({ attendees: meeting.attendees.map((a, i) => (i === index ? { ...a, present } : a)) })
  }

  const open = meeting ? meeting.status !== 'signed' && !meeting.signing_pending : false
  const editable = canWrite && open

  function openDecision(d: DecisionRow | null) {
    setDecisionForm(
      d
        ? {
            id: d.corporate_decision_id,
            kind: d.kind,
            title: d.title,
            text: d.text ?? '',
            outcome: d.outcome,
            votes_for: d.votes_for?.toString() ?? '',
            votes_against: d.votes_against?.toString() ?? '',
            votes_abstained: d.votes_abstained?.toString() ?? '',
            reservations: d.reservations ?? '',
            payload: { ...d.payload },
          }
        : { id: null, kind: 'ovrigt', title: '', text: '', outcome: 'bifallen', votes_for: '', votes_against: '', votes_abstained: '', reservations: '', payload: {} },
    )
  }

  function openEdit() {
    if (!meeting) return
    setEditForm({
      meeting_date: meeting.meeting_date,
      meeting_time: meeting.meeting_time ?? '',
      place: meeting.place ?? '',
      is_digital: meeting.is_digital,
      chair: meeting.chair?.party_id ?? '',
      chair_name: '',
      secretary: meeting.secretary?.party_id ?? '',
      secretary_name: '',
      adjusters: meeting.adjusters.map((a) => a.party_id),
      kallelse_date: meeting.kallelse_date ?? '',
      kallelse_method: meeting.kallelse_method ?? '',
      notes: meeting.notes ?? '',
    })
  }

  const statusChip = (m: MeetingSummary) =>
    m.signing_pending ? <Badge variant="warning">{t('status_signing')}</Badge> : m.status === 'draft' ? <Badge variant="outline">{t('status_draft')}</Badge> : m.status === 'held' ? <Badge variant="secondary">{t('status_held')}</Badge> : <span className="text-xs text-muted-foreground">{t('status_signed')}</span>

  const peopleOptions = useMemo(() => {
    const extra = meeting ? [meeting.chair, meeting.secretary, ...meeting.adjusters, ...(meeting.voting_list?.holders ?? [])].filter((p): p is Person => Boolean(p)) : []
    return [...new Map([...people, ...extra].map((p) => [p.party_id, { party_id: p.party_id, name: p.name }])).values()].sort((a, z) => a.name.localeCompare(z.name, 'sv'))
  }, [people, meeting])

  // ── List ──────────────────────────────────────────────────────────
  if (!selectedId) {
    return (
      <div className="space-y-8">
        <BolagetHeader
          title={t('title')}
          subtitle={t('subtitle')}
          help={t('help')}
          action={
            canWrite ? (
              <Button onClick={() => setCreateForm({ kind: 'arsstamma', organ: 'bolagsstamma', meeting_date: todayIsoStockholm(), meeting_time: '', place: '', fiscal_period_id: periods[0]?.id ?? '' })}>
                <PlusIcon className="h-4 w-4" />
                {t('new_meeting')}
              </Button>
            ) : null
          }
        />
        {listFailed && meetings ? (
          <AttnLine action={{ label: tCommon('retry'), onClick: () => void loadList() }}>{tCommon('refresh_failed')}</AttnLine>
        ) : null}
        {loading && !meetings ? (
          <LateReveal className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </LateReveal>
        ) : listFailed && !meetings ? (
          <LoadError
            title={t('load_failed')}
            onRetry={() => {
              setLoading(true)
              void loadList().finally(() => setLoading(false))
            }}
          />
        ) : !meetings || meetings.length === 0 ? (
          <EmptyState title={t('empty_title')} description={t('empty_description')} />
        ) : (
          <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
            <table className="stagger-enter w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('col_date')}</th>
                  <th className={TH_CLASS}>{t('col_meeting')}</th>
                  <th className={cn(TH_CLASS, PHONE_HIDDEN)}>{t('col_place')}</th>
                  <th className={TH_CLASS}>{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {meetings.map((m) => (
                  <tr key={m.corporate_meeting_id} className="cursor-pointer hover:bg-secondary/35" onClick={() => select(m.corporate_meeting_id)}>
                    <td className={cn(TD_CLASS, 'date-figures whitespace-nowrap')}>{formatDate(m.meeting_date)}</td>
                    <td className={TD_CLASS}>
                      <button type="button" className="text-left text-strong" onClick={(e) => (e.stopPropagation(), select(m.corporate_meeting_id))}>
                        {t(`kind_${m.kind}`)}
                        {m.sequence_number ? ` ${t('number', { n: m.sequence_number })}` : ''}
                      </button>
                    </td>
                    <td className={cn(TD_CLASS, PHONE_HIDDEN, 'text-muted-foreground')}>{m.is_digital ? t('digital') : m.place ?? ''}</td>
                    <td className={TD_CLASS}>{statusChip(m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* A new meeting starts as a small record: date, kind and place, in a drawer over the list (V7 creation forms). */}
        <SlideOver open={Boolean(createForm)} onOpenChange={(o) => (o ? null : setCreateForm(null))}>
          <SlideOverContent aria-describedby={undefined}>
            <SlideOverHeader title={t('new_meeting')} />
            <SlideOverBody>
            {createForm && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="mt-kind">{t('field_kind')}</Label>
                  <SettingsSelect id="mt-kind" value={createForm.kind} onChange={(e) => setCreateForm({ ...createForm, kind: e.target.value })}>
                    {MEETING_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`kind_${k}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
                {createForm.kind === 'per_capsulam' && (
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="mt-organ">{t('field_organ')}</Label>
                    <SettingsSelect id="mt-organ" value={createForm.organ} onChange={(e) => setCreateForm({ ...createForm, organ: e.target.value })}>
                      <option value="bolagsstamma">{t('organ_bolagsstamma')}</option>
                      <option value="styrelse">{t('organ_styrelse')}</option>
                    </SettingsSelect>
                  </div>
                )}
                {createForm.kind === 'arsstamma' && (
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="mt-fp">{t('field_fiscal_period')}</Label>
                    <SettingsSelect id="mt-fp" value={createForm.fiscal_period_id} onChange={(e) => setCreateForm({ ...createForm, fiscal_period_id: e.target.value })}>
                      {periods.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name ?? `${p.period_start} - ${p.period_end}`}
                        </option>
                      ))}
                    </SettingsSelect>
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="mt-date">{t('field_date')}</Label>
                  <Input id="mt-date" type="date" value={createForm.meeting_date} onChange={(e) => setCreateForm({ ...createForm, meeting_date: e.target.value })} className="tabular-nums" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mt-time">{t('field_time')}</Label>
                  <Input id="mt-time" type="time" value={createForm.meeting_time} onChange={(e) => setCreateForm({ ...createForm, meeting_time: e.target.value })} className="tabular-nums" />
                </div>
                {createForm.kind !== 'per_capsulam' && (
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="mt-place">{t('field_place')}</Label>
                    <Input id="mt-place" value={createForm.place} maxLength={200} onChange={(e) => setCreateForm({ ...createForm, place: e.target.value })} />
                  </div>
                )}
                <p className="text-xs text-muted-foreground sm:col-span-2">{createForm.kind === 'arsstamma' ? t('create_hint_arsstamma') : t('create_hint')}</p>
              </div>
            )}
            </SlideOverBody>
            <SlideOverFooter>
              <Button variant="ghost" onClick={() => setCreateForm(null)} disabled={busy}>
                {t('cancel')}
              </Button>
              <Button onClick={create} loading={busy} disabled={!createForm?.meeting_date || (createForm.kind === 'arsstamma' && !createForm.fiscal_period_id)}>
                {t('create_meeting')}
              </Button>
            </SlideOverFooter>
          </SlideOverContent>
        </SlideOver>
      </div>
    )
  }

  // ── One meeting ───────────────────────────────────────────────────
  const m = meeting
  const fields = decisionForm ? PAYLOAD_FIELDS[decisionForm.kind] ?? [] : []
  const setPayload = (key: string, value: unknown) => decisionForm && setDecisionForm({ ...decisionForm, payload: { ...decisionForm.payload, [key]: value } })
  const listKey = decisionForm?.kind === 'val_styrelse' ? 'members' : decisionForm?.kind === 'val_revisor' ? 'auditors' : decisionForm?.kind === 'ansvarsfrihet' ? 'persons' : null
  const listRows = listKey && decisionForm ? ((decisionForm.payload[listKey] as Payload[] | undefined) ?? []) : []
  const setRows = (rows: Payload[]) => listKey && setPayload(listKey, rows)
  const effects = m?.register_effects
  const changes = effects ? [...effects.planned] : []

  return (
    <div className="space-y-8">
      <PageHeader
        parent={{ label: t('title'), href: '/bolaget/moten', onClick: () => select(null) }}
        title={m ? m.title : ''}
        meta={m ? [m.meeting_time, m.kind === 'per_capsulam' ? null : m.is_digital ? t('digital') : m.place].filter(Boolean).join(' · ') || undefined : undefined}
        help={
          <HelpPopover>
            <p>{t('help')}</p>
          </HelpPopover>
        }
        action={
          m ? (
            <>
              {canWrite && m.status === 'draft' && (
                <Button size="toolbar" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>
                  <TrashIcon className="h-4 w-4" />
                  {t('delete_meeting')}
                </Button>
              )}
              <Button size="toolbar" variant="outline" asChild>
                <a href={`/api/bolaget/meetings/${m.corporate_meeting_id}/pdf`} target="_blank" rel="noreferrer">
                  <ArrowDownTrayIcon className="h-4 w-4" />
                  {t('pdf')}
                </a>
              </Button>
              {canWrite && m.status === 'draft' && (
                <Button size="toolbar" onClick={() => setConfirmHold(true)} disabled={m.meeting_date > todayIsoStockholm()}>
                  {t('hold')}
                </Button>
              )}
              {canWrite && m.status === 'held' && !m.signing_pending && (
                <Button size="toolbar" onClick={() => setSignForm({ mode: bankIdAvailable ? 'bankid' : 'manual', signedOn: todayIsoStockholm(), names: m.signers.map((s) => s.name).join(', '), file: null })}>
                  {t('sign')}
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      {!m && meetingFailed ? (
        <LoadError onRetry={() => (selectedId ? void loadMeeting(selectedId) : undefined)} />
      ) : !m ? (
        <LateReveal className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </LateReveal>
      ) : (
        <>
          {m.warnings[0] && m.status !== 'signed' ? <AttnLine>{locale === 'en' ? m.warnings[0].message_en : m.warnings[0].message_sv}</AttnLine> : null}

          <div className="grid gap-x-14 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
          <section className="space-y-3 lg:col-start-2 lg:row-start-1">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('section_meeting')}</h2>
              {editable && (
                <Button variant="ghost" onClick={openEdit}>
                  {t('edit')}
                </Button>
              )}
            </div>
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
              <dt className="text-muted-foreground">{t('field_status')}</dt>
              <dd>{statusChip(m)}</dd>
              <dt className="text-muted-foreground">{t('field_date')}</dt>
              <dd className="date-figures">{formatDate(m.meeting_date)}{m.meeting_time ? ` ${m.meeting_time}` : ''}</dd>
              {m.kind !== 'per_capsulam' && (
                <>
                  <dt className="text-muted-foreground">{t('field_place')}</dt>
                  <dd>{m.is_digital ? t('digital') : m.place ?? ''}</dd>
                  <dt className="text-muted-foreground">{t('field_chair')}</dt>
                  <dd data-ph-mask="">{m.chair?.name ?? <span className="text-muted-foreground">{t('not_set')}</span>}</dd>
                  <dt className="text-muted-foreground">{t('field_secretary')}</dt>
                  <dd data-ph-mask="">{m.secretary?.name ?? <span className="text-muted-foreground">{t('not_set')}</span>}</dd>
                  <dt className="text-muted-foreground">{t('field_adjusters')}</dt>
                  <dd data-ph-mask="">{m.adjusters.length > 0 ? m.adjusters.map((a) => a.name).join(', ') : <span className="text-muted-foreground">{t(`justering_${m.justering}`)}</span>}</dd>
                </>
              )}
              {m.organ === 'bolagsstamma' && m.kind !== 'per_capsulam' && (
                <>
                  <dt className="text-muted-foreground">{t('field_kallelse')}</dt>
                  <dd>
                    {m.kallelse_date ? `${formatDate(m.kallelse_date)}${m.kallelse_method ? `, ${m.kallelse_method}` : ''}` : null}
                    {!m.kallelse_date && m.kallelse_window ? (
                      <span className="text-muted-foreground">{t('kallelse_window', { earliest: formatDate(m.kallelse_window.earliest), latest: formatDate(m.kallelse_window.latest) })}</span>
                    ) : null}
                  </dd>
                </>
              )}
              {m.fiscal_period && (
                <>
                  <dt className="text-muted-foreground">{t('field_fiscal_period')}</dt>
                  <dd className="date-figures">{`${formatDate(m.fiscal_period.period_start)} - ${formatDate(m.fiscal_period.period_end)}`}</dd>
                </>
              )}
            </dl>
          </section>

          <div className="min-w-0 space-y-8 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('section_decisions')}</h2>
              {editable && (
                <Button variant="ghost" onClick={() => openDecision(null)}>
                  <PlusIcon className="h-4 w-4" />
                  {t('add_decision')}
                </Button>
              )}
            </div>
            {m.decisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('decisions_empty')}</p>
            ) : (
              <ol className={cn(LIST_BLEED_CLASS, 'stagger-enter border-t-hairline')}>
                {m.decisions.map((d) => (
                  <li key={d.corporate_decision_id} className="group border-b-hairline px-2 py-2 text-[13px] hover:bg-secondary/35">
                    <div className="flex items-center justify-between gap-4">
                      <div className="py-1 font-medium text-strong">
                        § {d.item_number} {d.title}
                        {d.outcome !== 'bifallen' ? (
                          <Badge variant="outline" className="ml-2">
                            {t(`outcome_${d.outcome}`)}
                          </Badge>
                        ) : null}
                      </div>
                      {editable && (
                        <div className="flex shrink-0">
                          <Button variant="row" onClick={() => openDecision(d)}>
                            {t('edit')}
                          </Button>
                          <Button variant="row" onClick={() => setDeletingDecision(d)}>
                            {t('remove')}
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="max-w-[70ch] pb-1 text-muted-foreground" data-ph-mask="">
                      {d.text_rendered}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {m.voting_list && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('section_voting_list')}</h2>
                {editable && (
                  <Button variant="ghost" onClick={() => void patch({ refresh_voting_list: true }, t('voting_list_refreshed'))}>
                    {t('refresh_voting_list')}
                  </Button>
                )}
              </div>
              {m.voting_list.holders.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('voting_list_empty')}</p>
              ) : (
                <div className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}>
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr>
                        <th className={TH_CLASS}>{t('col_holder')}</th>
                        <th className={cn(TH_CLASS, 'text-right')}>{t('col_shares')}</th>
                        <th className={cn(TH_CLASS, 'text-right')}>{t('col_votes')}</th>
                        <th className={TH_CLASS}>{t('col_present')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.voting_list.holders.map((h) => (
                        <tr key={h.party_id} className="hover:bg-secondary/35">
                          <td className={TD_CLASS} data-ph-mask="">
                            {h.name}
                            {h.proxy_name ? <span className="ml-2 text-xs text-muted-foreground">{t('proxy', { name: h.proxy_name })}</span> : null}
                          </td>
                          <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.shares.toLocaleString('sv-SE')}</td>
                          <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{h.votes.toLocaleString('sv-SE')}</td>
                          <td className={TD_CLASS}>
                            <Checkbox checked={h.present} disabled={!editable || busy} aria-label={t('col_present')} onCheckedChange={(v) => void togglePresence(h.party_id, v === true)} />
                          </td>
                        </tr>
                      ))}
                      <tr className={SUM_ROW_CLASS}>
                        <td className={TD_CLASS}>{t('total_row')}</td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{m.voting_list.holders.reduce((sum, h) => sum + h.shares, 0).toLocaleString('sv-SE')}</td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>{m.voting_list.holders.reduce((sum, h) => sum + h.votes, 0).toLocaleString('sv-SE')}</td>
                        <td className={TD_CLASS} />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {m.attendees.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('section_attendees')}</h2>
              <div className="space-y-2">
                {m.attendees.map((a, i) => (
                  <label key={`${a.party_id ?? a.name}-${i}`} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={a.present} disabled={!editable || busy} onCheckedChange={(v) => void toggleAttendee(i, v === true)} />
                    <span data-ph-mask="">{a.name}</span>
                    <span className="text-xs text-muted-foreground">{t(`capacity_${a.capacity}`)}</span>
                  </label>
                ))}
              </div>
            </section>
          )}

          {effects && (changes.length > 0 || effects.applied.added.length > 0 || effects.applied.ended.length > 0) && (
            <section className="space-y-3">
              <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('section_effects')}</h2>
              <div className="space-y-1 text-[13px]" data-ph-mask="">
                {changes.map((e, i) => (
                  <div key={`p-${i}`}>
                    {t(e.action === 'add' ? 'effect_add' : 'effect_end', { name: e.name, role: tRoles(`role_${e.role}`), date: formatDate(e.date) })}
                  </div>
                ))}
                {effects.applied.added.map((e, i) => (
                  <div key={`a-${i}`}>{t('effect_added', { name: e.name, role: tRoles(`role_${e.role}`), date: e.date ? formatDate(e.date) : '' })}</div>
                ))}
                {effects.applied.ended.map((e, i) => (
                  <div key={`e-${i}`}>{t('effect_ended', { name: e.name, role: tRoles(`role_${e.role}`), date: e.date ? formatDate(e.date) : '' })}</div>
                ))}
              </div>
              {changes.length > 0 && <p className="text-xs text-muted-foreground">{t('effects_hint')}</p>}
            </section>
          )}
          </div>

          <section className="space-y-3 lg:col-start-2 lg:row-start-2">
            <h2 className="text-[15px] font-medium leading-[22px] text-strong">{t('section_signatures')}</h2>
            {m.status === 'signed' ? (
              <div className="space-y-1 text-[13px]">
                <div data-ph-mask="">{t('signed_by', { names: m.signature_names ?? '' })}</div>
                {m.signed_document_id && (
                  <a className={QUIET_LINK_CLASS} href={`/api/documents/${m.signed_document_id}/inline`} target="_blank" rel="noreferrer">
                    {t('signed_copy')}
                  </a>
                )}
              </div>
            ) : m.signing ? (
              <div className="space-y-1 text-[13px]" data-ph-mask="">
                {m.signing.signers.map((s, i) => (
                  <div key={`${s.name}-${i}`}>
                    {s.name}
                    {s.role_label ? <span className="text-muted-foreground">, {s.role_label}</span> : null}
                    <span className="ml-2 text-xs text-muted-foreground">{t(`signer_${s.status === 'signed' ? 'signed' : s.status === 'declined' ? 'declined' : 'waiting'}`)}</span>
                  </div>
                ))}
              </div>
            ) : m.signers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('signers_empty')}</p>
            ) : (
              <div className="space-y-1 text-[13px]" data-ph-mask="">
                {m.signers.map((s) => (
                  <div key={s.party_id}>
                    {s.name}
                    <span className="text-muted-foreground">, {s.role_label}</span>
                  </div>
                ))}
              </div>
            )}
            {m.warnings.length > 1 && m.status !== 'signed' && (
              <ul className="space-y-1 pt-2 text-xs text-muted-foreground">
                {m.warnings.slice(1).map((w) => (
                  <li key={w.code}>{locale === 'en' ? w.message_en : w.message_sv}</li>
                ))}
              </ul>
            )}
            {signerLinks.length > 0 && (
              <div className="space-y-1 pt-2 text-xs">
                <div className="text-muted-foreground">{t('signer_links')}</div>
                {signerLinks.map((s) => (
                  <div key={s.url} data-ph-mask="">
                    {s.name}:{' '}
                    <a className={QUIET_LINK_CLASS} href={s.url} target="_blank" rel="noreferrer">
                      {t('signer_link')}
                    </a>
                  </div>
                ))}
              </div>
            )}
          </section>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmHold}
        onOpenChange={setConfirmHold}
        title={t('hold_title')}
        description={m?.organ === 'styrelse' ? t('hold_description_board') : m?.kind === 'arsstamma' ? t('hold_description_agm') : t('hold_description')}
        confirmLabel={t('hold')}
        onConfirm={hold}
      />
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={t('delete_title')} description={t('delete_description')} confirmLabel={t('delete_meeting')} onConfirm={removeMeeting} destructive />
      <ConfirmDialog
        open={Boolean(deletingDecision)}
        onOpenChange={(o) => (o ? null : setDeletingDecision(null))}
        title={t('remove_decision_title', { title: deletingDecision?.title ?? '' })}
        description={t('remove_decision_description')}
        confirmLabel={t('remove')}
        onConfirm={removeDecision}
        destructive
      />

      <Dialog open={Boolean(editForm)} onOpenChange={(o) => (o ? null : setEditForm(null))}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('edit_meeting')}</DialogTitle>
          </DialogHeader>
          {editForm && (
            <div className="grid max-h-[70vh] gap-4 overflow-y-auto sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="me-date">{t('field_date')}</Label>
                <Input id="me-date" type="date" value={editForm.meeting_date as string} onChange={(e) => setEditForm({ ...editForm, meeting_date: e.target.value })} className="tabular-nums" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="me-time">{t('field_time')}</Label>
                <Input id="me-time" type="time" value={editForm.meeting_time as string} onChange={(e) => setEditForm({ ...editForm, meeting_time: e.target.value })} className="tabular-nums" />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="me-place">{t('field_place')}</Label>
                <Input id="me-place" value={editForm.place as string} maxLength={200} onChange={(e) => setEditForm({ ...editForm, place: e.target.value })} />
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Checkbox checked={Boolean(editForm.is_digital)} onCheckedChange={(v) => setEditForm({ ...editForm, is_digital: v === true })} />
                {t('field_digital')}
              </label>
              {(['chair', 'secretary'] as const).map((role) => (
                <div key={role} className="space-y-1">
                  <Label htmlFor={`me-${role}`}>{t(`field_${role}`)}</Label>
                  <SettingsSelect id={`me-${role}`} value={editForm[role] as string} onChange={(e) => setEditForm({ ...editForm, [role]: e.target.value })}>
                    <option value="">{t('not_set')}</option>
                    {peopleOptions.map((p) => (
                      <option key={p.party_id} value={p.party_id}>
                        {p.name}
                      </option>
                    ))}
                    <option value={NEW}>{t('person_new')}</option>
                  </SettingsSelect>
                  {editForm[role] === NEW && (
                    <Input value={editForm[`${role}_name`] as string} maxLength={200} placeholder={t('field_name')} onChange={(e) => setEditForm({ ...editForm, [`${role}_name`]: e.target.value })} data-ph-mask="" />
                  )}
                </div>
              ))}
              <div className="space-y-1 sm:col-span-2">
                <Label>{t('field_adjusters')}</Label>
                <div className="space-y-1">
                  {peopleOptions.map((p) => {
                    const chosen = (editForm.adjusters as string[]).includes(p.party_id)
                    return (
                      <label key={p.party_id} className="flex items-center gap-2 text-sm" data-ph-mask="">
                        <Checkbox
                          checked={chosen}
                          onCheckedChange={(v) =>
                            setEditForm({
                              ...editForm,
                              adjusters: v === true ? [...(editForm.adjusters as string[]), p.party_id] : (editForm.adjusters as string[]).filter((id) => id !== p.party_id),
                            })
                          }
                        />
                        {p.name}
                      </label>
                    )
                  })}
                </div>
              </div>
              {m?.organ === 'bolagsstamma' && m.kind !== 'per_capsulam' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="me-kd">{t('field_kallelse_date')}</Label>
                    <Input id="me-kd" type="date" value={editForm.kallelse_date as string} onChange={(e) => setEditForm({ ...editForm, kallelse_date: e.target.value })} className="tabular-nums" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="me-km">{t('field_kallelse_method')}</Label>
                    <Input id="me-km" value={editForm.kallelse_method as string} maxLength={200} onChange={(e) => setEditForm({ ...editForm, kallelse_method: e.target.value })} />
                  </div>
                </>
              )}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="me-notes">{t('field_notes')}</Label>
                <Textarea id="me-notes" value={editForm.notes as string} maxLength={4000} rows={2} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={saveEdit} loading={busy}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(decisionForm)} onOpenChange={(o) => (o ? null : setDecisionForm(null))}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{decisionForm?.id ? t('edit_decision') : t('add_decision')}</DialogTitle>
          </DialogHeader>
          {decisionForm && (
            <div className="grid max-h-[70vh] gap-4 overflow-y-auto sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="md-kind">{t('field_decision_kind')}</Label>
                <SettingsSelect id="md-kind" value={decisionForm.kind} onChange={(e) => setDecisionForm({ ...decisionForm, kind: e.target.value as DecisionKind, payload: e.target.value === decisionForm.kind ? decisionForm.payload : {} })}>
                  {DECISION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`decision_${k}`)}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor="md-outcome">{t('field_outcome')}</Label>
                <SettingsSelect id="md-outcome" value={decisionForm.outcome} onChange={(e) => setDecisionForm({ ...decisionForm, outcome: e.target.value })}>
                  {DECISION_OUTCOMES.map((o) => (
                    <option key={o} value={o}>
                      {t(`outcome_${o}`)}
                    </option>
                  ))}
                </SettingsSelect>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="md-title">{t('field_title')}</Label>
                <Input id="md-title" value={decisionForm.title} maxLength={300} placeholder={t(`decision_${decisionForm.kind}`)} onChange={(e) => setDecisionForm({ ...decisionForm, title: e.target.value })} />
              </div>
              {fields.map((f) => (
                <div key={f.key} className={cn('space-y-1', (f.type === 'textarea' || f.type === 'bool') && 'sm:col-span-2')}>
                  {f.type === 'bool' ? (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={decisionForm.payload[f.key] === true || (decisionForm.payload[f.key] === undefined && f.key === 'follows_board_proposal')} onCheckedChange={(v) => setPayload(f.key, v === true)} />
                      {t(`payload_${f.key}`)}
                    </label>
                  ) : (
                    <>
                      <Label htmlFor={`md-${f.key}`}>{t(`payload_${f.key}`)}</Label>
                      {f.type === 'textarea' ? (
                        <Textarea id={`md-${f.key}`} rows={3} maxLength={8000} value={String(decisionForm.payload[f.key] ?? '')} onChange={(e) => setPayload(f.key, e.target.value)} />
                      ) : (
                        <Input
                          id={`md-${f.key}`}
                          type={f.type === 'date' ? 'date' : 'text'}
                          inputMode={f.type === 'money' ? 'decimal' : f.type === 'int' ? 'numeric' : undefined}
                          value={decisionForm.payload[f.key] === null || decisionForm.payload[f.key] === undefined ? '' : String(decisionForm.payload[f.key])}
                          onChange={(e) => setPayload(f.key, e.target.value)}
                          className={cn((f.type === 'money' || f.type === 'int' || f.type === 'date') && 'tabular-nums')}
                        />
                      )}
                    </>
                  )}
                </div>
              ))}
              {listKey && (
                <div className="space-y-2 sm:col-span-2">
                  <Label>{t(`list_${listKey}`)}</Label>
                  {listRows.map((row, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input
                        value={String(row.name ?? '')}
                        maxLength={200}
                        placeholder={t('field_name')}
                        className="min-w-40 flex-1"
                        data-ph-mask=""
                        onChange={(e) => setRows(listRows.map((r, j) => (j === i ? { ...r, name: e.target.value, party_id: null } : r)))}
                        list="meeting-people"
                      />
                      {listKey === 'persons' ? (
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox checked={row.granted !== false} onCheckedChange={(v) => setRows(listRows.map((r, j) => (j === i ? { ...r, granted: v === true } : r)))} />
                          {t('granted')}
                        </label>
                      ) : (
                        <SettingsSelect
                          value={String(row.role ?? (listKey === 'members' ? 'styrelseledamot' : 'revisor'))}
                          onChange={(e) => setRows(listRows.map((r, j) => (j === i ? { ...r, role: e.target.value } : r)))}
                          wrapperClassName="w-48"
                        >
                          {(listKey === 'members' ? BOARD_ROLES : AUDITOR_ROLES).map((r) => (
                            <option key={r} value={r}>
                              {tRoles(`role_${r}`)}
                            </option>
                          ))}
                        </SettingsSelect>
                      )}
                      <button type="button" className={QUIET_LINK_CLASS} onClick={() => setRows(listRows.filter((_, j) => j !== i))}>
                        {t('remove')}
                      </button>
                    </div>
                  ))}
                  <datalist id="meeting-people">
                    {peopleOptions.map((p) => (
                      <option key={p.party_id} value={p.name} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className={QUIET_LINK_CLASS}
                    onClick={() => setRows([...listRows, listKey === 'persons' ? { name: '', roles: [], granted: true } : listKey === 'members' ? { name: '', role: 'styrelseledamot' } : { name: '', role: 'revisor', kind: 'person' }])}
                  >
                    {t('add_row')}
                  </button>
                </div>
              )}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="md-text">{t('field_text')}</Label>
                <Textarea
                  id="md-text"
                  rows={3}
                  maxLength={8000}
                  value={decisionForm.text}
                  placeholder={m?.decisions.find((d) => d.corporate_decision_id === decisionForm.id)?.text_rendered ?? t('text_placeholder')}
                  onChange={(e) => setDecisionForm({ ...decisionForm, text: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t('text_hint')}</p>
              </div>
              {(['votes_for', 'votes_against', 'votes_abstained'] as const).map((k) => (
                <div key={k} className="space-y-1">
                  <Label htmlFor={`md-${k}`}>{t(`field_${k}`)}</Label>
                  <Input id={`md-${k}`} inputMode="decimal" value={decisionForm[k]} onChange={(e) => setDecisionForm({ ...decisionForm, [k]: e.target.value })} className="tabular-nums" />
                </div>
              ))}
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="md-res">{t('field_reservations')}</Label>
                <Textarea id="md-res" rows={2} maxLength={2000} value={decisionForm.reservations} onChange={(e) => setDecisionForm({ ...decisionForm, reservations: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={saveDecision} loading={busy}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(signForm)} onOpenChange={(o) => (o ? null : setSignForm(null))}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('sign_title')}</DialogTitle>
          </DialogHeader>
          {signForm && m && (
            <div className="space-y-4">
              {bankIdAvailable && (
                <SettingsSelect value={signForm.mode} onChange={(e) => setSignForm({ ...signForm, mode: e.target.value as 'bankid' | 'manual' })}>
                  <option value="bankid">{t('sign_bankid')}</option>
                  <option value="manual">{t('sign_manual')}</option>
                </SettingsSelect>
              )}
              <div className="space-y-1 text-[13px]" data-ph-mask="">
                <div className="text-muted-foreground">{t('signers_heading')}</div>
                {m.signers.map((s) => (
                  <div key={s.party_id}>
                    {s.name}, {s.role_label}
                    {signForm.mode === 'bankid' && !s.has_email ? <span className="ml-2 text-xs text-muted-foreground">{t('signer_no_email')}</span> : null}
                  </div>
                ))}
              </div>
              {signForm.mode === 'manual' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="ms-on">{t('field_signed_on')}</Label>
                    <Input id="ms-on" type="date" value={signForm.signedOn} onChange={(e) => setSignForm({ ...signForm, signedOn: e.target.value })} className="tabular-nums" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ms-names">{t('field_signature_names')}</Label>
                    <Input id="ms-names" value={signForm.names} maxLength={1000} onChange={(e) => setSignForm({ ...signForm, names: e.target.value })} data-ph-mask="" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ms-file">{t('field_signed_copy')}</Label>
                    <Input id="ms-file" type="file" accept="application/pdf,image/*" onChange={(e) => setSignForm({ ...signForm, file: e.target.files?.[0] ?? null })} />
                  </div>
                </>
              )}
              <p className="text-xs text-muted-foreground">{signForm.mode === 'bankid' ? t('sign_bankid_hint') : t('sign_manual_hint')}</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignForm(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button onClick={sign} loading={busy} disabled={signForm?.mode === 'manual' && !signForm.names.trim()}>
              {signForm?.mode === 'bankid' ? t('sign_bankid') : t('sign')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
