import { loadExtensions } from '@/lib/extensions/loader'
import { setContextFactory } from '@/lib/extensions/registry'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { registerSupplierInvoiceHandler } from '@/lib/bookkeeping/handlers/supplier-invoice-handler'
import { registerAttestNotificationHandler } from '@/lib/supplier-invoices/attest-notify'
import { registerEventLogHandler } from '@/lib/events/handlers/event-log-handler'
import { registerDocumentReadHandler } from '@/lib/events/handlers/document-read-handler'
import { registerAgentFeedbackRelayHandler } from '@/lib/events/handlers/agent-feedback-relay-handler'
import { registerWebhookHandler } from '@/lib/webhooks/handler'
import { registerSuggestionDetectorHandler } from '@/lib/suggestions/handler'
import { registerConfiguredPeppolTransports } from '@/lib/invoices/transports'
import { registerConnectPaymentsProvider } from '@/lib/payments/initiation/connect'
import { ensureObservability } from '@/lib/analytics/ensure-observability'
import { createLogger } from '@/lib/logger'
import { globalSingleton } from '@/lib/global-singleton'
// What every server entry gets before its first line (a fork's branding
// override, the PostHog sink): extension code runs in this module's graph,
// which instrumentation.ts loads, not in the graph of the route it serves.
import '@/lib/server-baseline'

const log = createLogger('init')

// Per process, not per module copy: the bus and the registries this fills are
// process-wide (lib/global-singleton.ts), so a second copy of this module that
// initialised again would subscribe every handler twice.
const initState = globalSingleton('initDone', () => ({ initialized: false }))

const REQUIRED_CORE_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_APP_URL',
  'CRON_SECRET',
] as const

// Each entry is one logical requirement; if multiple names are listed, the
// requirement is satisfied when ANY of them is set. Mirrors the runtime
// fallback in extensions/general/enable-banking/lib/jwt.ts (_PRODUCTION ||
// base) so Vercel prod (which only sets the _PRODUCTION variants) doesn't
// warn on every cold start.
// AI features run Claude via AWS Bedrock (see lib/agent/composer/client.ts and
// lib/documents/inbox-extraction/extract-invoice-fields.ts), so the
// static AWS keys are what actually gates them. The assistant's client can
// fall back to the AWS credential provider chain (instance profile, IRSA),
// but document extraction requires both static keys, so this log-only warning
// stays useful even on AWS infrastructure.
const REQUIRED_EXTENSION_VARS: ReadonlyArray<readonly string[]> = [
  ['ENABLE_BANKING_APP_ID_PRODUCTION', 'ENABLE_BANKING_APP_ID'],
  ['ENABLE_BANKING_PRIVATE_KEY_PRODUCTION', 'ENABLE_BANKING_PRIVATE_KEY'],
  ['AWS_ACCESS_KEY_ID'],
  ['AWS_SECRET_ACCESS_KEY'],
  // whatsapp-inbox extension (Meta Cloud API + phone PII at rest)
  ['WHATSAPP_ACCESS_TOKEN'],
  ['WHATSAPP_PHONE_NUMBER_ID'],
  ['WHATSAPP_APP_SECRET'],
  ['WHATSAPP_VERIFY_TOKEN'],
  ['WHATSAPP_PHONE_HASH_KEY'],
  ['WHATSAPP_PHONE_ENCRYPTION_KEY'],
] as const

function validateEnvironment(): void {
  // During builds (CI, Docker, Vercel), env vars may be absent or set to
  // placeholder sentinels. Skip validation so Next.js page collection
  // doesn't fail: real validation happens at runtime.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl || supabaseUrl.startsWith('__')) return

  const missing: string[] = []

  for (const v of REQUIRED_CORE_VARS) {
    if (!process.env[v]) missing.push(v)
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const missingExt: string[] = []
  for (const aliases of REQUIRED_EXTENSION_VARS) {
    if (!aliases.some((v) => !!process.env[v])) {
      missingExt.push(aliases.join(' or '))
    }
  }

  if (missingExt.length > 0) {
    log.warn(`Missing extension environment variables (extensions needing them may not work): ${missingExt.join(', ')}`)
  }
}

/**
 * Ensure the system is initialized (extensions loaded, context factory wired,
 * core event handlers registered).
 * Imported by one module in the app: instrumentation.ts registers the loader
 * that runs this (lib/initialized.ts) and starts it when the server boots.
 * eventBus.emit() and every getter of a registry filled here wait for that
 * load. Outside Next.js the process registers the loader itself. `npm run
 * check:guards` (static-init-import) keeps every other import of this module,
 * static or dynamic, out of the app. validateEnvironment() runs first, before
 * anything subscribes to the bus, so a failed first init leaves nothing behind
 * and the next caller retries cleanly.
 * Idempotent: safe to call multiple times.
 */
export function ensureInitialized(): void {
  if (initState.initialized) return

  validateEnvironment()
  setContextFactory(createExtensionContext)
  // PostHog Error Tracking, gated on the token; lib/server-baseline.ts calls
  // the same function for the route wrappers and the root layout, so entries
  // get it without this init.
  ensureObservability()
  registerSupplierInvoiceHandler()
  // The attest mail to each attester when an invoice that needs attest is registered.
  registerAttestNotificationHandler()
  registerEventLogHandler()
  registerDocumentReadHandler()
  registerAgentFeedbackRelayHandler()
  registerWebhookHandler()
  // Suggestion detectors (lib/suggestions): the events that can call for a
  // package switch (an employee registered, a till or webshop connected)
  // stage it for a person to approve. Never an automatic change.
  registerSuggestionDetectorHandler()
  // Peppol Access Point adapters are registered from the environment here;
  // every reader goes through the async getters, which load this init first.
  registerConfiguredPeppolTransports()
  // Bank payments reach the payment initiation provider only through Accounted
  // Connect, hosted and self-hosted alike: the adapter registers when this
  // installation has a connector key, and with none every payments door
  // answers unavailable.
  registerConnectPaymentsProvider()
  loadExtensions()

  initState.initialized = true
}
