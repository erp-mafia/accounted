'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn } from '@/lib/utils'
import {
  INVOICE_EMAIL_BODY_MAX_LENGTH,
  INVOICE_EMAIL_SUBJECT_MAX_LENGTH,
} from '@/lib/api/schemas'
import { useInvoiceEmailPreview } from './use-editor-previews'

export interface EmailTextOverride {
  subject: string
  body: string
}

interface EditorEmailPreviewProps {
  /** The preview-email request body; null while the tab is not shown. */
  requestBody: string | null
  /** This send's own subject and message; null = the company's or the stock texts. */
  override: EmailTextOverride | null
  onOverrideChange: (override: EmailTextOverride | null) => void
  /** Extra copies for this send (owner/admin only, as in SendInvoiceDialog). */
  canAddCopies: boolean
  extraCcText: string
  onExtraCcTextChange: (value: string) => void
  extraCcError: string | null
}

const ROW_CLASS = 'grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-4 py-2'
const LABEL_CLASS = 'text-muted-foreground'

/**
 * The Mejl tab: the email this send goes out with, rendered by the real
 * invoice email template (POST /api/invoices/preview-email). The subject and
 * message become editable for this one invoice; the texts keep their
 * placeholders so the send fills in the number it allocates.
 */
export function EditorEmailPreview({
  requestBody,
  override,
  onOverrideChange,
  canAddCopies,
  extraCcText,
  onExtraCcTextChange,
  extraCcError,
}: EditorEmailPreviewProps) {
  const t = useTranslations('invoice_editor_shell')
  // Mounted only while email goes out: the pane disables the Mejl tab, with
  // the reason, whenever it does not (EditorPreviewPane emailDisabledReason).
  const { preview, loading, error } = useInvoiceEmailPreview(requestBody)
  const [copiesOpen, setCopiesOpen] = useState(extraCcText.trim().length > 0)

  if (!preview) {
    return (
      <div className="space-y-3 rounded-lg border border-border bg-background p-6" aria-busy="true">
        {error ? (
          <p className="text-[13px] text-muted-foreground">{t('email_failed')}</p>
        ) : (
          <>
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex min-h-full flex-col rounded-lg border border-border bg-background transition-opacity duration-150',
        loading && 'opacity-80',
      )}
      aria-busy={loading}
    >
      <div className="border-b border-border px-6 py-4 text-[13px]" data-ph-mask="">
        <div className={ROW_CLASS}>
          <span className={LABEL_CLASS}>{t('email_from')}</span>
          <span className="truncate">
            {preview.from.address ? `${preview.from.name} <${preview.from.address}>` : preview.from.name}
          </span>
        </div>
        {preview.reply_to && (
          <div className={ROW_CLASS}>
            <span className={LABEL_CLASS}>{t('email_reply_to')}</span>
            <span className="truncate">{preview.reply_to}</span>
          </div>
        )}
        <div className={ROW_CLASS}>
          <span className={LABEL_CLASS}>{t('email_to')}</span>
          <span className="flex flex-wrap items-center gap-2">
            {preview.to.length > 0 ? (
              preview.to.map((address) => <RecipientChip key={address} address={address} />)
            ) : (
              <span className="text-muted-foreground">{t('email_no_recipient')}</span>
            )}
            {canAddCopies && !copiesOpen && (
              <button
                type="button"
                className={cn(QUIET_LINK_CLASS, 'inline-flex items-center gap-1')}
                onClick={() => setCopiesOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('email_add_copy')}
              </button>
            )}
          </span>
        </div>
        {(preview.cc.length > 0 || copiesOpen) && (
          <div className={ROW_CLASS}>
            <span className={LABEL_CLASS}>{t('email_cc')}</span>
            <span className="flex flex-col gap-2">
              {preview.cc.length > 0 && (
                <span className="flex flex-wrap gap-2">
                  {preview.cc.map((address) => (
                    <RecipientChip key={address} address={address} />
                  ))}
                </span>
              )}
              {copiesOpen && (
                <>
                  <Input
                    value={extraCcText}
                    onChange={(event) => onExtraCcTextChange(event.target.value)}
                    placeholder={t('email_copy_placeholder')}
                    aria-label={t('email_add_copy')}
                    aria-invalid={!!extraCcError}
                    className="h-9 text-[13px]"
                  />
                  {extraCcError && <span className="text-[12.5px] text-destructive">{extraCcError}</span>}
                </>
              )}
            </span>
          </div>
        )}
        <div className={ROW_CLASS}>
          <span className={LABEL_CLASS}>{t('email_subject')}</span>
          {override ? (
            <Input
              value={override.subject}
              maxLength={INVOICE_EMAIL_SUBJECT_MAX_LENGTH}
              onChange={(event) => onOverrideChange({ ...override, subject: event.target.value })}
              aria-label={t('email_subject')}
              className="h-9 text-[13px]"
            />
          ) : (
            <span className="font-medium">{preview.subject}</span>
          )}
        </div>
        {override && (
          <div className={ROW_CLASS}>
            <span className={LABEL_CLASS}>{t('email_message')}</span>
            <Textarea
              value={override.body}
              maxLength={INVOICE_EMAIL_BODY_MAX_LENGTH}
              onChange={(event) => onOverrideChange({ ...override, body: event.target.value })}
              aria-label={t('email_message')}
              className="min-h-24 text-[13px]"
            />
          </div>
        )}
        <div className="flex justify-end pt-1">
          {override ? (
            <button type="button" className={QUIET_LINK_CLASS} onClick={() => onOverrideChange(null)}>
              {t('email_edit_reset')}
            </button>
          ) : (
            <button
              type="button"
              className={QUIET_LINK_CLASS}
              onClick={() => onOverrideChange({ ...preview.editable })}
            >
              {t('email_edit')}
            </button>
          )}
        </div>
      </div>
      {/* The template's own HTML, sandboxed: no scripts, no navigation. */}
      <iframe
        title={t('email_frame_title')}
        srcDoc={preview.html}
        sandbox=""
        className="min-h-[420px] w-full flex-1 rounded-b-lg"
      />
    </div>
  )
}

function RecipientChip({ address }: { address: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full bg-secondary px-3 text-[12.5px]">
      {address}
    </span>
  )
}
