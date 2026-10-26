'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { SignerView, SigningRequestView } from '@/lib/signing/requests'
import { CopyLink } from './CopyLink'
import { cancelSigningRequest, remindSigner, signingErrorBody } from './signing-client'

/** Where a request stands, as one quiet word; a chip only where it went wrong (convention 5). */
export function SigningRequestState({ request }: { request: SigningRequestView }) {
  const t = useTranslations('signing')
  const signed = request.signers.filter((s) => s.status === 'signed').length
  switch (request.state) {
    case 'expired':
      return <Badge variant="warning">{t('state_expired')}</Badge>
    case 'declined':
      return <Badge variant="warning">{t('state_declined')}</Badge>
    case 'completed':
      return <span className="text-xs text-muted-foreground">{t('state_completed')}</span>
    case 'cancelled':
      return <span className="text-xs text-muted-foreground">{t('state_cancelled')}</span>
    default:
      return <span className="text-xs tabular-nums text-muted-foreground">{t('state_open_progress', { signed, total: request.signers.length })}</span>
  }
}

interface SigningRequestCardProps {
  request: SigningRequestView
  /** Signing is open here: remind is offered only then (a new link nobody can use helps no one). */
  available: boolean
  /** Something changed (reminded, cancelled): read the requests again. */
  onChanged: () => void
  /** The request's title and state line; off where the row above already says them (the Signeringar list). */
  showHeading?: boolean
}

/**
 * One signing request: who is asked and where each stands, Påminn for a
 * pending signer with an address (a new link; the old one stops working),
 * Avbryt signeringen while it is open, and once completed the signed PDF and
 * the evidence package, each an archive document of its own.
 */
export function SigningRequestCard({ request, available, onChanged, showHeading = true }: SigningRequestCardProps) {
  const t = useTranslations('signing')
  const locale = useLocale() as ErrorLocale
  const { formatDateLong } = useFormat()
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [reminding, setReminding] = useState<string | null>(null)
  /** New links a reminder made when its mail did not go out, by signer id. */
  const [freshLinks, setFreshLinks] = useState<Record<string, string>>({})
  const open = request.state === 'open'

  async function remind(signer: SignerView) {
    setReminding(signer.signer_id)
    try {
      const reminded = await remindSigner(request.signing_request_id, signer.signer_id)
      if (reminded.email_sent) {
        toast({ title: t('reminded', { email: signer.email ?? '' }) })
      } else if (reminded.url) {
        setFreshLinks((prev) => ({ ...prev, [signer.signer_id]: reminded.url! }))
        if (signer.email) toast({ title: t('remind_mail_failed'), variant: 'destructive' })
      }
      onChanged()
    } catch (error) {
      toast({ title: t('remind_failed'), description: getErrorMessage(signingErrorBody(error), { locale }), variant: 'destructive' })
    } finally {
      setReminding(null)
    }
  }

  async function cancel() {
    const ok = await confirm(
      {
        title: t('cancel_confirm_title'),
        description: t('cancel_confirm_body'),
        confirmLabel: t('cancel_confirm'),
        cancelLabel: t('cancel_keep'),
      },
      async () => {
        try {
          await cancelSigningRequest(request.signing_request_id)
        } catch (error) {
          toast({ title: t('cancel_failed'), description: getErrorMessage(signingErrorBody(error), { locale }), variant: 'destructive' })
          throw error
        }
      },
    )
    if (!ok) return
    toast({ title: t('cancelled') })
    onChanged()
  }

  const signerStatus = (s: SignerView) => {
    if (s.status === 'signed') return <span className="text-xs text-muted-foreground">{s.signed_at ? t('signer_signed_on', { date: formatDateLong(s.signed_at) }) : t('signer_signed')}</span>
    if (s.status === 'declined') return <Badge variant="warning">{t('signer_declined')}</Badge>
    if (s.last_error_code === 'SIGNING_SIGNER_MISMATCH') return <span className="text-xs text-muted-foreground">{t('signer_wrong_bankid')}</span>
    if (s.last_error_code === 'SIGNING_NAME_MISMATCH') return <span className="text-xs text-muted-foreground">{t('signer_name_mismatch')}</span>
    return <span className="text-xs text-muted-foreground">{t('signer_pending')}</span>
  }

  return (
    <div className="space-y-3">
      {showHeading && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="m-0 min-w-0 truncate text-[13px]" data-ph-mask="">
              {request.title}
            </p>
            <SigningRequestState request={request} />
          </div>
          <p className="m-0 text-[12.5px] text-muted-foreground">
            {open
              ? t('sent_open_until', { sent: formatDateLong(request.created_at), until: formatDateLong(request.expires_at) })
              : t('sent_on', { sent: formatDateLong(request.created_at) })}
          </p>
        </div>
      )}

      <ul className="m-0 list-none p-0 text-[13px]">
        {request.signers.map((s) => {
          const canRemind = available && open && s.status === 'pending' && !!s.email
          // Without an address the link was shown once, at sending: a new one replaces it.
          const canReissue = available && open && s.status === 'pending' && !s.email && !s.user_id
          const fresh = freshLinks[s.signer_id]
          return (
            <li key={s.signer_id} className="space-y-1 border-b border-border py-2 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="min-w-0" data-ph-mask="">
                  {s.name}
                  {s.email ? <span className="text-muted-foreground">{` ${s.email}`}</span> : null}
                  {s.lock !== 'none' ? <span className="ml-2 text-xs text-muted-foreground">{t('signer_locked')}</span> : null}
                </span>
                <span className="flex items-baseline gap-3">
                  {signerStatus(s)}
                  {canRemind && (
                    <button type="button" className={QUIET_LINK_CLASS} onClick={() => void remind(s)} disabled={reminding !== null}>
                      {reminding === s.signer_id ? t('reminding') : t('remind')}
                    </button>
                  )}
                  {canReissue && (
                    <button type="button" className={QUIET_LINK_CLASS} onClick={() => void remind(s)} disabled={reminding !== null}>
                      {reminding === s.signer_id ? t('reissuing') : t('reissue')}
                    </button>
                  )}
                </span>
              </div>
              {s.status === 'declined' && s.decline_reason ? (
                <p className="m-0 text-[12.5px] text-muted-foreground" data-ph-mask="">
                  {t('signer_decline_reason', { reason: s.decline_reason })}
                </p>
              ) : null}
              {s.status === 'pending' && !s.email && open ? (
                <p className="m-0 text-[12.5px] text-muted-foreground">{s.user_id ? t('signer_member_no_email') : t('signer_no_email')}</p>
              ) : null}
              {fresh ? (
                <div className="space-y-1 pt-1">
                  <p className="m-0 text-[12.5px] text-muted-foreground">{t('fresh_link_hint', { name: s.name })}</p>
                  <CopyLink url={fresh} label={t('link_label', { name: s.name })} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {(request.signed_document_id || request.evidence_document_id || request.state === 'completed' || open) && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          {request.signed_document_id && (
            <Link href={`/arkiv/dokument/${request.signed_document_id}`} className={QUIET_LINK_CLASS}>
              {t('signed_copy')}
            </Link>
          )}
          {request.evidence_document_id && (
            <Link href={`/arkiv/dokument/${request.evidence_document_id}`} className={QUIET_LINK_CLASS}>
              {t('evidence_package')}
            </Link>
          )}
          {request.state === 'completed' && (!request.signed_document_id || !request.evidence_document_id) && (
            <span className="text-[12.5px] text-muted-foreground">{t('sealing')}</span>
          )}
          {open && (
            <button type="button" className={QUIET_LINK_CLASS} onClick={() => void cancel()}>
              {t('cancel_request')}
            </button>
          )}
        </div>
      )}
      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}
