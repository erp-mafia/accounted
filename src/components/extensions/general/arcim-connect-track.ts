'use client'

import { captureAnalyticsEvent } from '@/lib/analytics/client'

/**
 * The migration connect funnel. The server already records that a connect
 * step opened (a status-0 provider_consents row) and whether it got a token;
 * only the browser knows whether the customer pressed the provider button and
 * how that attempt ended. No names, e-mails, ids or free text in properties:
 * the provider and the outcome only. Never throws.
 */
export type MigrationConnectOutcome = 'success' | 'provider_error' | 'cancelled' | 'window_closed'

function capture(event: string, properties: Record<string, string>): void {
  captureAnalyticsEvent(event, properties)
}

/** The provider login, Lundify activation or credential submit was pressed. */
export function trackMigrationConnectClicked(provider: string): void {
  capture('migration_connect_clicked', { provider })
}

/** How a pressed connect ended. */
export function trackMigrationConnectFinished(provider: string, outcome: MigrationConnectOutcome): void {
  capture('migration_connect_finished', { provider, outcome })
}
