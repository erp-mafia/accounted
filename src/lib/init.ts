import { loadExtensions } from '@/lib/extensions/loader'
import { setContextFactory } from '@/lib/extensions/registry'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { registerSupplierInvoiceHandler } from '@/lib/bookkeeping/handlers/supplier-invoice-handler'
import { registerEventLogHandler } from '@/lib/events/handlers/event-log-handler'
import { registerDocumentReadHandler } from '@/lib/events/handlers/document-read-handler'
import { registerAgentFeedbackRelayHandler } from '@/lib/events/handlers/agent-feedback-relay-handler'
import { registerWebhookHandler } from '@/lib/webhooks/handler'
import { registerConfiguredPeppolTransports } from '@/lib/invoices/transports'
import { registerConnectPaymentsProvider } from '@/lib/payments/initiation/connect'
import { ensureObservability } from '@/lib/analytics/ensure-observability'
import { createLogger } from '@/lib/logger'

const log = createLogger('init')

let initialized = false

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
// extensions/general/invoice-inbox/lib/extract-invoice-fields.ts), so the
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
 * Never imported statically by an entry point: lib/initialized.ts loads this
 * module on first use, from eventBus.emit() and from every getter of a
 * registry filled here, so a request that does neither loads no extension.
 * `npm run check:guards` (static-init-import) keeps it out of every entry's
 * static import graph. validateEnvironment() runs first, before anything
 * subscribes to the bus, so a failed first init leaves nothing behind and the
 * next caller retries cleanly.
 * Idempotent: safe to call multiple times.
 */
export function ensureInitialized(): void {
  if (initialized) return

  validateEnvironment()
  setContextFactory(createExtensionContext)
  // PostHog Error Tracking, gated on the token; lib/server-baseline.ts calls
  // the same function for the route wrappers and the root layout, so entries
  // get it without this init.
  ensureObservability()
  registerSupplierInvoiceHandler()
  registerEventLogHandler()
  registerDocumentReadHandler()
  registerAgentFeedbackRelayHandler()
  registerWebhookHandler()
  // Peppol Access Point adapters are registered from the environment here;
  // every reader goes through the async getters, which load this init first.
  registerConfiguredPeppolTransports()
  // Bank payments reach the payment initiation provider only through Accounted
  // Connect, hosted and self-hosted alike: the adapter registers when this
  // installation has a connector key, and with none every payments door
  // answers unavailable.
  registerConnectPaymentsProvider()
  loadExtensions()

  initialized = true
}
