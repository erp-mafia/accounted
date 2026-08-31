'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { useBranding } from '@/lib/branding/brand-context'
import type { InvoiceDelivery, InvoiceDeliveryProviderStatus } from '@/types'

export type InvoiceDeliveryView = Pick<
  InvoiceDelivery,
  | 'id'
  | 'channel'
  | 'to_addresses'
  | 'cc_addresses'
  | 'provider'
  | 'provider_status'
  | 'provider_status_at'
  | 'provider_status_detail'
  | 'provider_recipient_statuses'
  | 'error_code'
  | 'document_attachment_id'
  | 'attachment_filename'
  | 'sent_at'
  | 'failed_at'
  | 'created_at'
> & {
  status: 'pending' | 'sent' | 'failed' | 'marked_sent'
}

interface InvoiceDeliveryHistoryProps {
  deliveries: InvoiceDeliveryView[]
  showLegacyEmptyState: boolean
}

/**
 * What the row actually says happened. The send status alone stops at
 * "handed to the provider", which is why an accepted-but-bounced invoice used
 * to read as a plain success. When the provider has reported back, its
 * outcome is what the row shows.
 */
type DeliveryOutcome =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'marked_sent'
  | InvoiceDeliveryProviderStatus

function outcomeOf(delivery: InvoiceDeliveryView): DeliveryOutcome {
  if (delivery.status === 'sent' && delivery.provider_status) return delivery.provider_status
  return delivery.status
}

// Chips mark exceptions (convention 5): a confirmed arrival, a plain handoff
// and a manual mark read as muted text; only the outcomes that need a second
// look get a chip. Green is never chrome here.
const outcomeVariant: Partial<Record<DeliveryOutcome, 'warning' | 'destructive'>> = {
  delayed: 'warning',
  complained: 'warning',
  bounced: 'destructive',
  failed: 'destructive',
  suppressed: 'destructive',
}

export function InvoiceDeliveryHistory({
  deliveries,
  showLegacyEmptyState,
}: InvoiceDeliveryHistoryProps) {
  const t = useTranslations('invoice_detail')
  const format = useFormatter()
  const { appName } = useBranding()

  if (deliveries.length === 0 && !showLegacyEmptyState) return null

  const formatTimestamp = (value: string) =>
    format.dateTime(new Date(value), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })

  return (
    <DetailSection
      kicker={t('delivery_history_title')}
      help={<HelpPopover>{t('delivery_history_description')}</HelpPopover>}
    >
      {deliveries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('delivery_history_legacy_description')}</p>
      ) : (
        <div className="divide-y divide-border">
          {deliveries.map((delivery) => {
            const occurredAt = delivery.sent_at || delivery.failed_at || delivery.created_at
            const isManual = delivery.channel === 'manual'
            const outcome = outcomeOf(delivery)
            const outcomeChip = outcomeVariant[outcome]
            const isEmailSend = !isManual && delivery.status === 'sent'
            const recipientCount =
              delivery.to_addresses.length + delivery.cc_addresses.length
            const recipientStatuses = delivery.provider_recipient_statuses ?? {}
            const hasRecipientStatuses = Object.keys(recipientStatuses).length > 0
            const recipientRows = [
              ...delivery.to_addresses.map((address, index) => ({
                address,
                label: t('delivery_to_label'),
                reference: `to:${index + 1}`,
                outcome: recipientStatuses[`to:${index + 1}`],
              })),
              ...delivery.cc_addresses.map((address, index) => ({
                address,
                label: t('delivery_cc_label'),
                reference: `cc:${index + 1}`,
                outcome: recipientStatuses[`cc:${index + 1}`],
              })),
            ]

            return (
              <details key={delivery.id} className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 py-2 text-sm transition-colors duration-150 hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90" />
                  <span className="tabular-nums text-muted-foreground">{formatTimestamp(occurredAt)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {isManual ? t('delivery_channel_manual') : t('delivery_channel_email')}
                  </span>
                  {outcomeChip ? (
                    <Badge variant={outcomeChip}>{t(`delivery_status_${outcome}`)}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(`delivery_status_${outcome}`)}</span>
                  )}
                </summary>

                <div className="pb-4 pl-6 pt-1">
                  {isManual ? (
                    <p className="text-sm text-muted-foreground">
                      {t('delivery_manual_unknown_details', { appName })}
                    </p>
                  ) : (
                    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
                      <dt className="text-muted-foreground">{t('delivery_to_label')}</dt>
                      <dd className="break-words">{delivery.to_addresses.join(', ')}</dd>
                      {delivery.cc_addresses.length > 0 && (
                        <>
                          <dt className="text-muted-foreground">{t('delivery_cc_label')}</dt>
                          <dd className="break-words">{delivery.cc_addresses.join(', ')}</dd>
                        </>
                      )}
                      {isEmailSend && (
                        <>
                          <dt className="text-muted-foreground">{t('delivery_provider_status_label')}</dt>
                          <dd>
                            <span className="flex flex-wrap items-center gap-2">
                              <span>{t(`delivery_status_${outcome}`)}</span>
                              {delivery.provider_status_at && (
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {formatTimestamp(delivery.provider_status_at)}
                                </span>
                              )}
                            </span>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {hasRecipientStatuses
                                ? t('delivery_recipient_statuses_summary')
                                : t(`delivery_status_explanation_${outcome}`)}
                            </p>
                            {delivery.provider_status_detail && (
                              <p className="mt-1 break-words text-xs text-muted-foreground">
                                {t('delivery_provider_reason_label')}: {delivery.provider_status_detail}
                              </p>
                            )}
                            {recipientCount > 1
                              && delivery.provider_status
                              && !hasRecipientStatuses && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {t('delivery_status_whole_send_note')}
                              </p>
                            )}
                          </dd>
                        </>
                      )}
                      {isEmailSend && hasRecipientStatuses && (
                        <>
                          <dt className="text-muted-foreground">{t('delivery_recipient_statuses_label')}</dt>
                          <dd>
                            <ul className="space-y-1">
                              {recipientRows.map((recipient) => (
                                <li
                                  key={recipient.reference}
                                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs"
                                >
                                  <span className="min-w-0 break-all">
                                    <span className="text-muted-foreground">{recipient.label}:</span>{' '}
                                    {recipient.address}
                                  </span>
                                  {recipient.outcome ? (
                                    <span className="flex items-center gap-2">
                                      {outcomeVariant[recipient.outcome.status] ? (
                                        <Badge variant={outcomeVariant[recipient.outcome.status]}>
                                          {t(`delivery_status_${recipient.outcome.status}`)}
                                        </Badge>
                                      ) : (
                                        <span className="text-muted-foreground">
                                          {t(`delivery_status_${recipient.outcome.status}`)}
                                        </span>
                                      )}
                                      <span className="text-muted-foreground tabular-nums">
                                        {formatTimestamp(recipient.outcome.status_at)}
                                      </span>
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">
                                      {t('delivery_recipient_status_unknown')}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </dd>
                        </>
                      )}
                      {delivery.document_attachment_id && (
                        <>
                          <dt className="text-muted-foreground">{t('delivery_pdf_label')}</dt>
                          <dd>
                            <a
                              href={`/api/documents/${delivery.document_attachment_id}/inline`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex max-w-full items-center gap-1 hover:underline"
                            >
                              <span className="truncate">
                                {delivery.attachment_filename || t('delivery_pdf_fallback')}
                              </span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                            </a>
                          </dd>
                        </>
                      )}
                      {delivery.provider && (
                        <>
                          <dt className="text-muted-foreground">{t('delivery_provider_label')}</dt>
                          <dd className="text-muted-foreground">{delivery.provider}</dd>
                        </>
                      )}
                      {delivery.error_code && (
                        <>
                          <dt className="text-muted-foreground">{t('delivery_error_label')}</dt>
                          <dd className="text-muted-foreground">{delivery.error_code}</dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
              </details>
            )
          })}
        </div>
      )}
    </DetailSection>
  )
}
