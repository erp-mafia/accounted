/**
 * What a server entry needs before its first line runs, without loading an
 * extension: a fork's branding override (getBranding() is synchronous, so the
 * override must be registered up front) and the PostHog error sink. Imported
 * for its side effects by the route wrappers (withRouteContext,
 * withCronContext, withApiV1); the root layout does the same for pages.
 * Everything else lib/init sets up loads on first use (lib/initialized.ts).
 */
import '@/lib/extensions/_generated/branding-list'
import { ensureObservability } from '@/lib/analytics/ensure-observability'

ensureObservability()
