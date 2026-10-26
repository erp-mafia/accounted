'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { BankIdMark } from '@/components/bankid/BankIdMark'
import { CopyLink } from '@/components/signing/CopyLink'
import { SigningRequestCard } from '@/components/signing/SigningRequestCard'
import { personalNumberValid, SIGNER_EMAIL_RE } from '@/components/signing/signer-fields'
import {
  cancelSigningRequest,
  fetchCompanyMemberOptions,
  getSigningRequest,
  listSigningRequests,
  requestArsredovisningSigning,
  signingErrorBody,
  type CompanyMemberOption,
} from '@/components/signing/signing-client'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { SignatureRequest } from '@/lib/bokslut/arsredovisning/signature-service'
import { createdSignerForSlot, expiredBlockingRequests, type ArsredovisningSigningTrack } from '@/lib/bokslut/arsredovisning/signing-track'
import type { CreatedSigningRequest, SigningRequestView } from '@/lib/signing/requests'
import { SIGNING_DEFAULT_TTL_DAYS, SIGNING_MAX_TTL_DAYS, SIGNING_MESSAGE_MAX } from '@/lib/signing/types'
import { annualReportStepAnchor } from './StepSectionHeader'

/**
 * The BankID signing requests of one locked version, newest first; null
 * while they load. A completed request whose signed copy never landed is
 * read once by id, which seals it again.
 */
export function useVersionSigningRequests(versionId: string | null, reloadKey: number): SigningRequestView[] | null {
  const [state, setState] = useState<{ versionId: string; requests: SigningRequestView[] } | null>(null)
  useEffect(() => {
    if (!versionId) return
    let cancelled = false
    listSigningRequests({ annualReportVersionId: versionId })
      .then((list) =>
        Promise.all(
          list.map((r) =>
            r.state === 'completed' && (!r.signed_document_id || !r.evidence_document_id) ? getSigningRequest(r.signing_request_id).catch(() => r) : r,
          ),
        ),
      )
      .then(
        (requests) => {
          if (!cancelled) setState({ versionId, requests })
        },
        () => {
          // Unreadable requests read as none: the server still refuses a second track.
          if (!cancelled) setState({ versionId, requests: [] })
        },
      )
    return () => {
      cancelled = true
    }
  }, [versionId, reloadKey])
  if (!versionId) return []
  return state?.versionId === versionId ? state.requests : null
}

interface SlotAssignment {
  email: string
  /** A member of the company (picked, or the person at the screen). */
  userId: string | null
  personalNumber: string
  locking: boolean
}

const EMPTY: SlotAssignment = { email: '', userId: null, personalNumber: '', locking: false }

interface ArsredovisningBankIdSigningProps {
  fiscalPeriodId: string
  /** The locked version (ready_for_signature) the board signs. */
  versionId: string
  /** The version's slots, in roster order. */
  slots: SignatureRequest[]
  /** The version's BankID signing requests (useVersionSigningRequests); null while loading. */
  requests: SigningRequestView[] | null
  track: ArsredovisningSigningTrack
  /** Signing is open here (GET /api/signing/availability). */
  available: boolean
  /** A request was sent, reminded or cancelled: read the slots and the requests again. */
  onChanged: () => void
}

/**
 * Skriv under med BankID: the board signs the locked version, each member in
 * their own BankID, through a signing request that covers every pending slot
 * (lib/bokslut/arsredovisning/bankid-signing.ts). Per slot an address for the
 * mail, a member picked from the company, or "Det är jag" for the person at
 * the screen, and an optional personnummer lock. When the person at the
 * screen is the whole board, the signing is one sitting: sent without mail
 * and opened at once on the member signing page. Afterwards each slot's
 * status, Påminn, a new link and Avbryt (SigningRequestCard), and once
 * everyone has signed, the next step: the årsstämma, then Digital inlämning.
 * A version is signed one way: with evidence recorded by hand on a slot this
 * panel only says so.
 */
export function ArsredovisningBankIdSigning({ fiscalPeriodId, versionId, slots, requests, track, available, onChanged }: ArsredovisningBankIdSigningProps) {
  const t = useTranslations('annualReportSigning')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const [members, setMembers] = useState<CompanyMemberOption[]>([])
  const [assign, setAssign] = useState<Record<string, SlotAssignment>>({})
  const [message, setMessage] = useState('')
  const [days, setDays] = useState(String(SIGNING_DEFAULT_TTL_DAYS))
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [created, setCreated] = useState<{ result: CreatedSigningRequest; mineSignerId: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchCompanyMemberOptions().then(
      (list) => {
        if (!cancelled) setMembers(list)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [])

  const me = members.find((m) => m.is_current_user) ?? null
  const pending = useMemo(() => slots.filter((s) => s.status === 'pending'), [slots])
  const assignmentOf = (slotId: string): SlotAssignment => assign[slotId] ?? EMPTY
  const isMine = (slotId: string) => me !== null && assignmentOf(slotId).userId === me.user_id

  // One member per slot: the server refuses the same member twice in a request.
  function setMember(slotId: string, member: CompanyMemberOption | null) {
    setAssign((prev) => {
      // One person may hold two slots (styrelseledamot and VD): each slot is
      // its own signature, so picking someone for one slot leaves the others.
      const next: Record<string, SlotAssignment> = { ...prev }
      const current = next[slotId] ?? EMPTY
      // The person at the screen signs here: no mail, no lock to type (their own BankID login locks it when they have one).
      next[slotId] = member
        ? member.is_current_user
          ? { ...EMPTY, userId: member.user_id }
          : { ...current, userId: member.user_id, email: member.email }
        : { ...current, userId: null, email: '' }
      return next
    })
  }
  const update = (slotId: string, patch: Partial<SlotAssignment>) => setAssign((prev) => ({ ...prev, [slotId]: { ...(prev[slotId] ?? EMPTY), ...patch } }))

  const daysNumber = Number(days)
  const daysValid = Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= SIGNING_MAX_TTL_DAYS
  const rowErrors = useMemo(() => {
    const seen = new Set<string>()
    const errors: Record<string, { email: boolean; personalNumber: boolean }> = {}
    for (const slot of pending) {
      const a = assign[slot.id] ?? EMPTY
      const email = a.email.trim().toLowerCase()
      const duplicate = email !== '' && seen.has(email)
      if (email) seen.add(email)
      errors[slot.id] = {
        email: (email !== '' && !SIGNER_EMAIL_RE.test(email)) || duplicate,
        personalNumber: a.locking && a.personalNumber.trim() !== '' && !personalNumberValid(a.personalNumber),
      }
    }
    return errors
  }, [assign, pending])
  const formValid = daysValid && Object.values(rowErrors).every((e) => !e.email && !e.personalNumber)
  // The whole board is the person at the screen: one sitting, nobody to mail.
  const oneSitting = me !== null && pending.length > 0 && pending.every((s) => isMine(s.id))

  async function send() {
    setShowErrors(true)
    if (!formValid || busy) return
    setBusy(true)
    setError(null)
    try {
      // An open request past its expiry still blocks a new one: it is cancelled first.
      for (const expired of expiredBlockingRequests(requests ?? [])) {
        await cancelSigningRequest(expired.signing_request_id).catch(() => undefined) // still open: the request below then answers why
      }
      const result = await requestArsredovisningSigning(fiscalPeriodId, versionId, {
        signers: pending.map((slot) => {
          const a = assignmentOf(slot.id)
          const mine = isMine(slot.id)
          return {
            signatureId: slot.id,
            email: mine ? null : a.email.trim() || null,
            userId: a.userId,
            personalNumber: !mine && a.locking && a.personalNumber.trim() ? a.personalNumber.trim() : null,
          }
        }),
        message: message.trim() || null,
        expiresInDays: daysNumber,
        sendEmail: !oneSitting,
      })
      const mySlot = pending.find((s) => isMine(s.id))
      const mine = mySlot ? createdSignerForSlot(pending, result.signers, mySlot.id) : null
      if (oneSitting && mine) {
        router.push(`/signering/${mine.signer_id}`)
        return
      }
      setCreated({ result, mineSignerId: mine?.signer_id ?? null })
      onChanged()
    } catch (err) {
      setError(signingErrorBody(err) ?? err)
    } finally {
      setBusy(false)
    }
  }

  const help = (
    <HelpPopover>
      <div className="space-y-2">
        <p>{t('help_how')}</p>
        <p>{t('help_no_bankid')}</p>
        <p>{t('help_name_rule')}</p>
      </div>
    </HelpPopover>
  )
  const heading = (
    <div className="flex items-center gap-2">
      <BankIdMark />
      <h3 className="text-sm font-medium">{t('panel_title')}</h3>
      {help}
    </div>
  )

  // A version is signed one way: evidence by hand on a slot rules BankID out.
  if (track.kind === 'manual') {
    return (
      <div className="space-y-2 rounded-lg border border-border p-6">
        {heading}
        <p className="text-[13px] text-muted-foreground">{t('blocked_by_manual')}</p>
      </div>
    )
  }

  const list = requests ?? []
  const shown = list.filter((r) => r.state === 'open' || r.state === 'completed')
  // Without an open or a completed request, the newest closed one says what happened to it.
  const visible = shown.length > 0 ? shown : list.slice(0, 1)
  if (!available && visible.length === 0) return null

  const openRequest = track.kind === 'bankid' ? track.open : null
  const mySigner = openRequest && me ? (openRequest.signers.find((s) => s.user_id === me.user_id && s.status === 'pending') ?? null) : null
  const nameMismatch = visible.some((r) => r.signers.some((s) => s.last_error_code === 'SIGNING_NAME_MISMATCH'))
  const allSigned = slots.length > 0 && pending.length === 0 && slots.every((s) => s.status === 'signed')
  const canSend = available && requests !== null && !openRequest && pending.length > 0

  const mailed = pending.filter((s) => !isMine(s.id) && assignmentOf(s.id).email.trim()).length
  const links = pending.filter((s) => !isMine(s.id) && !assignmentOf(s.id).email.trim()).length
  const outcome = oneSitting
    ? t('outcome_one_sitting')
    : [
        mailed > 0 ? t('outcome_mailed', { count: mailed }) : null,
        links > 0 ? t('outcome_links', { count: links }) : null,
        pending.some((s) => isMine(s.id)) ? t('outcome_mine') : null,
        t('outcome_days', { days: daysValid ? daysNumber : SIGNING_DEFAULT_TTL_DAYS }),
      ]
        .filter(Boolean)
        .join(' ')

  return (
    <div className="space-y-6 rounded-lg border border-border p-6">
      <div className="space-y-2">
        {heading}
        <p className="text-[13px] text-muted-foreground">{t('panel_intro')}</p>
      </div>

      {allSigned && (
        <div className="space-y-2">
          <p className="text-[13px]">{t('all_signed')}</p>
          <p className="text-[13px] text-muted-foreground">{t('all_signed_next')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <a href={`#${annualReportStepAnchor('agm')}`} className={QUIET_LINK_CLASS}>
              {t('go_agm')}
            </a>
            <a href={`#${annualReportStepAnchor('filing')}`} className={QUIET_LINK_CLASS}>
              {t('go_filing')}
            </a>
          </div>
        </div>
      )}

      {created && (
        <div className="space-y-3">
          <p className="m-0 text-[13px]">{t('created_title')}</p>
          <ul className="m-0 list-none space-y-3 p-0 text-[13px]">
            {created.result.signers.map((s) => (
              <li key={s.signer_id} className="space-y-2">
                <p className="m-0" data-ph-mask="">
                  <span>{s.name}</span>
                  <span className="text-muted-foreground">
                    {` ${
                      s.signer_id === created.mineSignerId
                        ? t('created_mine')
                        : s.email_sent
                          ? t('created_mailed', { email: s.email ?? '' })
                          : s.email
                            ? t('created_mail_failed')
                            : t('created_link')
                    }`}
                  </span>
                </p>
                {s.url && s.signer_id !== created.mineSignerId ? <CopyLink url={s.url} label={t('link_label', { name: s.name })} /> : null}
              </li>
            ))}
          </ul>
          {created.result.signers.some((s) => s.url && s.signer_id !== created.mineSignerId) && (
            <p className="m-0 text-[12.5px] text-muted-foreground">{t('created_link_hint')}</p>
          )}
        </div>
      )}

      {available && mySigner && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0 text-[13px]">{t('your_turn')}</p>
          <Button asChild>
            <Link href={`/signering/${mySigner.signer_id}`}>{t('sign_now')}</Link>
          </Button>
        </div>
      )}

      {nameMismatch && <AttnLine>{t('name_mismatch_attn')}</AttnLine>}

      {visible.length > 0 && (
        <div className="stagger-enter space-y-6">
          {visible.map((r) => (
            <SigningRequestCard key={r.signing_request_id} request={r} available={available} onChanged={onChanged} />
          ))}
        </div>
      )}

      {canSend && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <ul className="m-0 list-none p-0">
            {pending.map((slot) => {
              const a = assignmentOf(slot.id)
              const mine = isMine(slot.id)
              const errors = rowErrors[slot.id] ?? { email: false, personalNumber: false }
              const pickable = members.filter((m) => !m.is_current_user && m.user_id !== a.userId)
              return (
                <li key={slot.id} className="space-y-2 border-b border-border py-3 first:pt-0 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <p className="m-0 min-w-0 text-[13px]" data-ph-mask="">
                      {slot.signer_name}
                      <span className="text-muted-foreground">{`, ${slot.role}`}</span>
                    </p>
                    {me &&
                      (mine ? (
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => setMember(slot.id, null)}>
                          {t('not_me')}
                        </button>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => setMember(slot.id, me)}>
                          {t('its_me')}
                        </Button>
                      ))}
                  </div>
                  {mine ? (
                    <p className="m-0 text-[12.5px] text-muted-foreground">{t('mine_hint')}</p>
                  ) : (
                    <>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          type="email"
                          value={a.email}
                          readOnly={a.userId !== null}
                          onChange={(e) => update(slot.id, { email: e.target.value })}
                          placeholder={t('email_placeholder')}
                          aria-label={t('email_label', { name: slot.signer_name })}
                          aria-invalid={(showErrors && errors.email) || undefined}
                          className="min-w-0 sm:max-w-sm"
                        />
                        {a.userId !== null ? (
                          <button type="button" className={QUIET_LINK_CLASS} onClick={() => setMember(slot.id, null)}>
                            {t('clear_member')}
                          </button>
                        ) : pickable.length > 0 ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button type="button" size="sm" variant="secondary">
                                {t('pick_member')}
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              {pickable.map((m) => (
                                <DropdownMenuItem key={m.user_id} onSelect={() => setMember(slot.id, m)}>
                                  <span data-ph-mask="">{m.email}</span>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </div>
                      {a.locking ? (
                        <div className="space-y-1">
                          <Input
                            inputMode="numeric"
                            autoComplete="off"
                            value={a.personalNumber}
                            onChange={(e) => update(slot.id, { personalNumber: e.target.value })}
                            placeholder={t('pn_placeholder')}
                            aria-label={t('pn_label', { name: slot.signer_name })}
                            aria-invalid={errors.personalNumber || undefined}
                            className="max-w-xs tabular-nums"
                          />
                          <p className="m-0 text-[12.5px] text-muted-foreground">{errors.personalNumber ? t('pn_invalid') : t('pn_hint')}</p>
                        </div>
                      ) : (
                        <button type="button" className={QUIET_LINK_CLASS} onClick={() => update(slot.id, { locking: true })}>
                          {t('pn_add')}
                        </button>
                      )}
                    </>
                  )}
                </li>
              )
            })}
          </ul>

          {!oneSitting && (
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="block space-y-2 text-[13px]">
                <span className="text-muted-foreground">{t('message_label')}</span>
                <Textarea value={message} maxLength={SIGNING_MESSAGE_MAX} rows={2} onChange={(e) => setMessage(e.target.value)} placeholder={t('message_placeholder')} />
              </label>
              <label className="block space-y-2 text-[13px]">
                <span className="text-muted-foreground">{t('days_label')}</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={SIGNING_MAX_TTL_DAYS}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  aria-invalid={!daysValid || undefined}
                  className="w-24 tabular-nums"
                />
              </label>
            </div>
          )}

          <p className="m-0 text-[12.5px] text-muted-foreground">{outcome}</p>
          <p className="m-0 text-[12.5px] text-muted-foreground">{t('name_rule_short')}</p>
          {showErrors && !formValid ? (
            <AttnLine>{t('form_invalid', { max: SIGNING_MAX_TTL_DAYS })}</AttnLine>
          ) : error != null ? (
            <AttnLine>{getErrorMessage(error, { locale, fallback: t('send_failed') })}</AttnLine>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={busy} disabled={busy || (showErrors && !formValid)}>
              {oneSitting ? t('sign_now') : t('send')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
