/**
 * Support recipient: server-side only.
 * Used by the /api/support/contact route. Never exposed to the client.
 *
 * Resolution order (evaluated lazily so a fork's branding extension,
 * registered by lib/server-baseline.ts or lib/init, can override the default):
 *   SUPPORT_RECIPIENT_EMAIL env var  →  branding service
 */
import { getBranding } from '@/lib/branding/service'

export function getSupportRecipientEmail(): string {
  return process.env.SUPPORT_RECIPIENT_EMAIL || getBranding().supportEmail
}
