import { loadExtensions } from '@/lib/extensions/loader'
import { setContextFactory } from '@/lib/extensions/registry'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import { registerSupplierInvoiceHandler } from '@/lib/bookkeeping/handlers/supplier-invoice-handler'
import { registerEventLogHandler } from '@/lib/events/handlers/event-log-handler'
import { registerWebhookHandler } from '@/lib/webhooks/handler'
import { registerConfiguredPeppolTransports } from '@/lib/invoices/transports'
import { registerObservabilitySink } from '@/lib/observability'
import { postHogSink } from '@/lib/analytics/posthog-observability'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'
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
 * Called from API routes that emit events.
 * Idempotent: safe to call multiple times.
 */
export function ensureInitialized(): void {
  if (initialized) return

  validateEnvironment()
  setContextFactory(createExtensionContext)
  // Turns lib/observability from a no-op into PostHog Error Tracking. Gated,
  // so with no token (core, CI, self-hosted) the sink stays the no-op and
  // PostHog is never constructed and never contacted. Note the SDK is still
  // BUNDLED in those builds: the imports are static, so the bytes ship even
  // though nothing initialises. Making that a true zero would mean dynamic
  // imports at every posthog call site, which is a deliberate non-goal here.
  if (isAnalyticsEnabled()) registerObservabilitySink(postHogSink)
  registerSupplierInvoiceHandler()
  registerEventLogHandler()
  registerWebhookHandler()
  // Peppol Access Point adapters are registered from the environment here so
  // every route that reports transport availability sees the same answer.
  registerConfiguredPeppolTransports()
  loadExtensions()

  initialized = true
}
