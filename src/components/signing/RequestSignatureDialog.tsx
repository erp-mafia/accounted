'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { PlusIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AttnLine } from '@/components/ui/attn-line'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { CreatedSigningRequest } from '@/lib/signing/requests'
import { SIGNING_DEFAULT_TTL_DAYS, SIGNING_MAX_SIGNERS, SIGNING_MAX_TTL_DAYS, SIGNING_MESSAGE_MAX, SIGNING_NAME_MAX, SIGNING_TITLE_MAX } from '@/lib/signing/types'
import { CopyLink } from './CopyLink'
import { UsageLimitDialog } from '@/components/settings/UsageLimitDialog'
import { createSigningRequest, fetchCompanyMemberOptions, signingErrorBody, signingErrorCode, type CompanyMemberOption } from './signing-client'
import { personalNumberValid, SIGNER_EMAIL_RE as EMAIL_RE } from './signer-fields'

interface SignerRow {
  key: number
  name: string
  email: string
  /** A member of the company: the row's address is theirs, and they can also sign from Att göra. */
  userId: string | null
  /** The typed personnummer that locks the row; shown only once asked for. */
  personalNumber: string
  locking: boolean
}

function emptyRow(key: number): SignerRow {
  return { key, name: '', email: '', userId: null, personalNumber: '', locking: false }
}

/** The file name without its extension: "Styrelseprotokoll 2026-10.pdf" reads "Styrelseprotokoll 2026-10". */
function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{2,5}$/i, '').trim().slice(0, SIGNING_TITLE_MAX)
}

interface RequestSignatureDialogProps {
  documentId: string
  fileName: string
  onOpenChange: (open: boolean) => void
  /** Called once the request exists, mailed or not. */
  onCreated?: (created: CreatedSigningRequest) => void
}

/**
 * Begär signering: an archived PDF out for BankID signing. A title (from the
 * file name), the signers (name and address, a member of the company picked
 * from the list, optionally locked to a personnummer), a message and how many
 * days it stays open. The outcome is said before it is sent: who gets a mail
 * and for how long. After: who got the mail, and the link to copy for each
 * signer no mail reached (the server answers it only for them).
 */
export function RequestSignatureDialog({ documentId, fileName, onOpenChange, onCreated }: RequestSignatureDialogProps) {
  const t = useTranslations('signing')
  const locale = useLocale() as ErrorLocale
  const nextKey = useRef(1)
  const [title, setTitle] = useState(() => titleFromFileName(fileName))
  const [rows, setRows] = useState<SignerRow[]>(() => [emptyRow(0)])
  const [message, setMessage] = useState('')
  const [days, setDays] = useState(String(SIGNING_DEFAULT_TTL_DAYS))
  const [members, setMembers] = useState<CompanyMemberOption[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [created, setCreated] = useState<CreatedSigningRequest | null>(null)
  // Stopped at the signings the month includes: the service to ask for more of.
  const [charge, setCharge] = useState<{ included: number; unitPriceOre: number } | null>(null)

  // The company's members for the picker; without them the dialog takes typed people only.
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

  const update = (key: number, patch: Partial<SignerRow>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const addRow = (patch: Partial<SignerRow> = {}) => {
    const key = nextKey.current++
    setRows((prev) => {
      // A single empty row is replaced by the picked member rather than left above it.
      const base = prev.length === 1 && !prev[0]!.name.trim() && !prev[0]!.email.trim() && Object.keys(patch).length > 0 ? [] : prev
      return [...base, { ...emptyRow(key), ...patch }]
    })
  }
  const removeRow = (key: number) => setRows((prev) => (prev.length === 1 ? [emptyRow(prev[0]!.key)] : prev.filter((r) => r.key !== key)))

  const pickedMembers = new Set(rows.map((r) => r.userId).filter(Boolean))
  const pickable = members.filter((m) => !pickedMembers.has(m.user_id))

  const daysNumber = Number(days)
  const daysValid = Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= SIGNING_MAX_TTL_DAYS
  const rowErrors = useMemo(() => {
    const seenEmails = new Set<string>()
    return rows.map((r) => {
      const email = r.email.trim().toLowerCase()
      const duplicate = email !== '' && seenEmails.has(email)
      if (email) seenEmails.add(email)
      return {
        name: !r.name.trim(),
        email: (email !== '' && !EMAIL_RE.test(email)) || duplicate,
        personalNumber: r.locking && r.personalNumber.trim() !== '' && !personalNumberValid(r.personalNumber),
      }
    })
  }, [rows])
  const formValid = title.trim() !== '' && daysValid && rowErrors.every((e) => !e.name && !e.email && !e.personalNumber)
  const mailed = rows.filter((r) => r.email.trim()).length

  async function submit() {
    setShowErrors(true)
    if (!formValid || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createSigningRequest({
        documentId,
        title: title.trim(),
        message: message.trim() || null,
        expiresInDays: daysNumber,
        signers: rows.map((r) => ({
          name: r.name.trim(),
          email: r.email.trim() || null,
          roleLabel: null,
          userId: r.userId,
          personalNumber: r.locking && r.personalNumber.trim() ? r.personalNumber.trim() : null,
        })),
      })
      setCreated(result)
      onCreated?.(result)
    } catch (err) {
      if (signingErrorCode(err) === 'USAGE_LIMIT_REACHED') {
        const details = (signingErrorBody(err) as { error?: { details?: { included?: number; unit_price_ore?: number } } } | null)?.error?.details
        setCharge({ included: details?.included ?? 0, unitPriceOre: details?.unit_price_ore ?? 0 })
      } else {
        setError(signingErrorBody(err) ?? err)
      }
    } finally {
      setBusy(false)
    }
  }

  const close = () => onOpenChange(false)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {created ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t('created_title')}</DialogTitle>
              <DialogDescription>{t('created_description', { title: created.title })}</DialogDescription>
            </DialogHeader>
            <ul className="m-0 list-none space-y-3 p-0 text-[13px]">
              {created.signers.map((s) => (
                <li key={s.signer_id} className="space-y-2 border-b border-border pb-3 last:border-b-0">
                  <p className="m-0" data-ph-mask="">
                    <span>{s.name}</span>
                    <span className="text-muted-foreground">
                      {` ${s.email_sent ? t('created_mailed', { email: s.email ?? '' }) : s.email ? t('created_mail_failed') : t('created_no_email')}`}
                    </span>
                  </p>
                  {s.url ? <CopyLink url={s.url} label={t('link_label', { name: s.name })} /> : null}
                </li>
              ))}
            </ul>
            {created.signers.some((s) => s.url) && <p className="text-[12.5px] text-muted-foreground">{t('created_link_hint')}</p>}
            <DialogFooter>
              <Button onClick={close}>{t('close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('dialog_title')}</DialogTitle>
              <DialogDescription>{t('dialog_description')}</DialogDescription>
            </DialogHeader>

            <label className="block space-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('field_title')}</span>
              <Input value={title} maxLength={SIGNING_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} aria-invalid={(showErrors && !title.trim()) || undefined} />
            </label>

            <fieldset className="m-0 space-y-2 border-0 p-0">
              <legend className="mb-2 text-[13px] text-muted-foreground">{t('field_signers')}</legend>
              {rows.map((r, i) => {
                const errors = rowErrors[i]!
                const member = r.userId ? members.find((m) => m.user_id === r.userId) : null
                return (
                  <div key={r.key} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-start gap-2">
                      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
                        <Input
                          value={r.name}
                          maxLength={SIGNING_NAME_MAX}
                          onChange={(e) => update(r.key, { name: e.target.value })}
                          placeholder={t('signer_name_placeholder')}
                          aria-label={t('signer_name_label', { n: i + 1 })}
                          aria-invalid={(showErrors && errors.name) || undefined}
                          className="min-w-0"
                        />
                        <Input
                          type="email"
                          value={r.email}
                          readOnly={member != null}
                          onChange={(e) => update(r.key, { email: e.target.value })}
                          placeholder={t('signer_email_placeholder')}
                          aria-label={t('signer_email_label', { n: i + 1 })}
                          aria-invalid={(showErrors && errors.email) || undefined}
                          className="min-w-0"
                        />
                      </div>
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeRow(r.key)} aria-label={t('signer_remove', { n: i + 1 })}>
                        <XMarkIcon className="h-4 w-4" />
                      </Button>
                    </div>
                    {member && <p className="m-0 text-[12.5px] text-muted-foreground">{t('signer_is_member')}</p>}
                    {r.locking ? (
                      <div className="space-y-1">
                        <Input
                          inputMode="numeric"
                          autoComplete="off"
                          value={r.personalNumber}
                          onChange={(e) => update(r.key, { personalNumber: e.target.value })}
                          placeholder={t('signer_pn_placeholder')}
                          aria-label={t('signer_pn_label', { n: i + 1 })}
                          aria-invalid={errors.personalNumber || undefined}
                          className="max-w-xs tabular-nums"
                        />
                        <p className="m-0 text-[12.5px] text-muted-foreground">{errors.personalNumber ? t('signer_pn_invalid') : t('signer_pn_hint')}</p>
                      </div>
                    ) : (
                      <button type="button" className={QUIET_LINK_CLASS} onClick={() => update(r.key, { locking: true })}>
                        {t('signer_pn_add')}
                      </button>
                    )}
                  </div>
                )
              })}
              {/* One way to add a signer: the company's members to pick from, then anyone else by name and
                  address. Two buttons side by side ("person", "medlem") left the difference to guess. */}
              {rows.length < SIGNING_MAX_SIGNERS &&
                (pickable.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="secondary" size="sm">
                        <PlusIcon className="h-4 w-4" />
                        {t('signer_add')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-[260px]">
                      <DropdownMenuLabel className="text-[12.5px] font-normal text-muted-foreground">{t('signer_add_members_label')}</DropdownMenuLabel>
                      {pickable.map((m) => (
                        <DropdownMenuItem key={m.user_id} onSelect={() => addRow({ userId: m.user_id, email: m.email })}>
                          <span data-ph-mask="">{m.is_current_user ? t('member_you', { email: m.email }) : m.email}</span>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => addRow()}>{t('signer_add_other')}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Button type="button" variant="secondary" size="sm" onClick={() => addRow()}>
                    <PlusIcon className="h-4 w-4" />
                    {t('signer_add')}
                  </Button>
                ))}
            </fieldset>

            <label className="block space-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('field_message')}</span>
              <Textarea value={message} maxLength={SIGNING_MESSAGE_MAX} rows={3} onChange={(e) => setMessage(e.target.value)} placeholder={t('field_message_placeholder')} />
            </label>

            <label className="block space-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('field_days')}</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={SIGNING_MAX_TTL_DAYS}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                aria-invalid={!daysValid || undefined}
                aria-describedby="signing-days-hint"
                className="w-24 tabular-nums"
              />
              <span id="signing-days-hint" className="block text-[12.5px] text-muted-foreground">
                {t('field_days_hint', { max: SIGNING_MAX_TTL_DAYS })}
              </span>
            </label>

            <p className="text-[12.5px] text-muted-foreground">
              {mailed === rows.length
                ? t('outcome_all_mailed', { count: rows.length, days: daysValid ? daysNumber : SIGNING_DEFAULT_TTL_DAYS })
                : t('outcome_some_links', { count: rows.length, mailed, days: daysValid ? daysNumber : SIGNING_DEFAULT_TTL_DAYS })}
            </p>
            {showErrors && !formValid ? (
              <AttnLine>{t('form_invalid', { max: SIGNING_MAX_TTL_DAYS })}</AttnLine>
            ) : error != null ? (
              <AttnLine>{getErrorMessage(error, { locale, fallback: t('create_failed') })}</AttnLine>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={close} disabled={busy}>
                {t('cancel')}
              </Button>
              <Button type="submit" loading={busy} disabled={busy || (showErrors && !formValid)}>
                {t('send')}
              </Button>
            </DialogFooter>
          </form>
        )}
        {charge && (
          <UsageLimitDialog
            kind="signing"
            included={charge.included}
            unitPriceOre={charge.unitPriceOre}
            open
            onOpenChange={(next) => {
              if (!next) setCharge(null)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
