/**
 * Support recipient: server-side only.
 * Used by the /api/support/contact route. Never exposed to the client.
 *
 * Resolution order (evaluated lazily so extensions registered via
 * ensureInitialized() can override the branding default):
 *   SUPPORT_RECIPIENT_EMAIL env var  →  branding service
 */
import { getBranding } from '@/lib/branding/service'

export function getSupportRecipientEmail(): string {
  return process.env.SUPPORT_RECIPIENT_EMAIL || getBranding().supportEmail
}
