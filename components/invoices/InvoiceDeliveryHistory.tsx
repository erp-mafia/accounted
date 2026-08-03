'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { ExternalLink, Mail, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
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

// Green is reserved for a confirmed arrival. "Skickad" without a delivery
// report is a neutral, honest in-between state.
const outcomeVariant: Record<DeliveryOutcome, 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  sent: 'secondary',
  delivered: 'success',
  delayed: 'warning',
  complained: 'warning',
  bounced: 'destructive',
  failed: 'destructive',
  suppressed: 'destructive',
  marked_sent: 'outline',
}

export function InvoiceDeliveryHistory({
  deliveries,
  showLegacyEmptyState,
}: InvoiceDeliveryHistoryProps) {
  const t = useTranslations('invoice_detail')
  const format = useFormatter()

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
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" />
          {t('delivery_history_title')}
        </CardTitle>
        <CardDescription>{t('delivery_history_description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {deliveries.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t('delivery_history_legacy_title')}</p>
            <p className="mt-1">{t('delivery_history_legacy_description')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {deliveries.map((delivery) => {
              const occurredAt = delivery.sent_at || delivery.failed_at || delivery.created_at
              const isManual = delivery.channel === 'manual'
              const outcome = outcomeOf(delivery)
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
                <details key={delivery.id} className="group rounded-lg border bg-card">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      {isManual ? <Send className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {isManual ? t('delivery_channel_manual') : t('delivery_channel_email')}
                      </span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatTimestamp(occurredAt)}
                      </span>
                    </span>
                    <Badge variant={outcomeVariant[outcome]}>
                      {t(`delivery_status_${outcome}`)}
                    </Badge>
                  </summary>

                  <div className="px-4 pb-4">
                    <Separator className="mb-4" />
                    {isManual ? (
                      <p className="text-sm text-muted-foreground">
                        {t('delivery_manual_unknown_details')}
                      </p>
                    ) : (
                      <div className="space-y-4 text-sm">
                        <dl className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
                          <dt className="text-muted-foreground">{t('delivery_to_label')}</dt>
                          <dd className="break-words">{delivery.to_addresses.join(', ')}</dd>
                          {delivery.cc_addresses.length > 0 && (
                            <>
                              <dt className="text-muted-foreground">{t('delivery_cc_label')}</dt>
                              <dd className="break-words">{delivery.cc_addresses.join(', ')}</dd>
                            </>
                          )}
                        </dl>

                        {isEmailSend && (
                          <div className="rounded-lg border bg-muted/30 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">
                                {t('delivery_provider_status_label')}
                              </span>
                              <span>{t(`delivery_status_${outcome}`)}</span>
                              {delivery.provider_status_at && (
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {formatTimestamp(delivery.provider_status_at)}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {hasRecipientStatuses
                                ? t('delivery_recipient_statuses_summary')
                                : t(`delivery_status_explanation_${outcome}`)}
                            </p>
                            {hasRecipientStatuses && (
                              <div className="mt-3 border-t pt-3">
                                <p className="mb-2 text-xs font-medium">
                                  {t('delivery_recipient_statuses_label')}
                                </p>
                                <ul className="space-y-2">
                                  {recipientRows.map((recipient) => (
                                    <li
                                      key={recipient.reference}
                                      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                                    >
                                      <span className="min-w-0 break-all text-xs">
                                        <span className="text-muted-foreground">
                                          {recipient.label}:
                                        </span>{' '}
                                        {recipient.address}
                                      </span>
                                      {recipient.outcome ? (
                                        <span className="flex items-center gap-2">
                                          {recipient.outcome.status === 'delivered' ? (
                                            <span className="text-xs text-muted-foreground">
                                              {t('delivery_status_delivered')}
                                            </span>
                                          ) : (
                                            <Badge variant={outcomeVariant[recipient.outcome.status]}>
                                              {t(`delivery_status_${recipient.outcome.status}`)}
                                            </Badge>
                                          )}
                                          <span className="text-xs text-muted-foreground tabular-nums">
                                            {formatTimestamp(recipient.outcome.status_at)}
                                          </span>
                                        </span>
                                      ) : (
                                        <span className="text-xs text-muted-foreground">
                                          {t('delivery_recipient_status_unknown')}
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {delivery.provider_status_detail && (
                              <p className="mt-2 break-words text-xs text-muted-foreground">
                                {t('delivery_provider_reason_label')}: {delivery.provider_status_detail}
                              </p>
                            )}
                            {recipientCount > 1
                              && delivery.provider_status
                              && !hasRecipientStatuses && (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {t('delivery_status_whole_send_note')}
                              </p>
                            )}
                          </div>
                        )}

                        {delivery.document_attachment_id && (
                          <Button asChild variant="outline" size="sm" className="max-w-full">
                            <a
                              href={`/api/documents/${delivery.document_attachment_id}/inline`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              <span className="truncate">
                                {t('delivery_open_pdf', {
                                  filename: delivery.attachment_filename || t('delivery_pdf_fallback'),
                                })}
                              </span>
                            </a>
                          </Button>
                        )}

                        {(delivery.provider || delivery.error_code) && (
                          <dl className="grid gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-[8rem_minmax(0,1fr)]">
                            {delivery.provider && (
                              <>
                                <dt>{t('delivery_provider_label')}</dt>
                                <dd>{delivery.provider}</dd>
                              </>
                            )}
                            {delivery.error_code && (
                              <>
                                <dt>{t('delivery_error_label')}</dt>
                                <dd>{delivery.error_code}</dd>
                              </>
                            )}
                          </dl>
                        )}
                      </div>
                    )}
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
