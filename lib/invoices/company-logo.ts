import type { SupabaseClient } from '@supabase/supabase-js'
import {
  LOGO_ALLOWED_MIME_TYPES,
  LOGO_EXTENSION_BY_MIME_TYPE,
  type LogoMimeType,
} from './branding-constants'

export const LOGO_BUCKET = 'logos'
export const SIGNED_LOGO_UPLOAD_TTL_SECONDS = 2 * 60 * 60

type LogoStorageBucket = ReturnType<SupabaseClient['storage']['from']>

const MIME_TYPE_BY_EXTENSION = Object.fromEntries(
  Object.entries(LOGO_EXTENSION_BY_MIME_TYPE).map(([mimeType, extension]) => [extension, mimeType]),
) as Record<string, LogoMimeType>

export function isLogoMimeType(value: string): value is LogoMimeType {
  return (LOGO_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
}

export function createLogoStoragePath(
  companyId: string,
  mimeType: LogoMimeType,
  uploadId = crypto.randomUUID(),
): string {
  return `${companyId}/logo-upload-${uploadId}.${LOGO_EXTENSION_BY_MIME_TYPE[mimeType]}`
}

/**
 * Only paths minted by the public API are accepted by the completion route.
 * This prevents an API key from activating another company's object or an
 * unrelated file that happens to live in the public logos bucket.
 */
export function getLogoMimeTypeForUploadPath(
  companyId: string,
  storagePath: string,
): LogoMimeType | null {
  const prefix = `${companyId}/logo-upload-`
  if (!storagePath.startsWith(prefix)) return null

  const fileName = storagePath.slice(prefix.length)
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(png|jpg|svg|webp)$/i.exec(fileName)
  if (!match) return null

  return MIME_TYPE_BY_EXTENSION[match[2].toLowerCase()] ?? null
}

/**
 * Remove superseded logo objects after the settings row points at the new
 * logo. Cleanup is deliberately best-effort so a storage outage can never
 * roll the company back to a broken logo URL.
 */
export async function cleanupPreviousCompanyLogos(
  bucket: LogoStorageBucket,
  companyId: string,
  keepStoragePath: string,
): Promise<unknown | null> {
  const { data: existing, error: listError } = await bucket.list(companyId)
  if (listError) return listError

  const keepName = keepStoragePath.slice(`${companyId}/`.length)
  const supersededPaths = (existing ?? [])
    .filter((file) => file.name !== keepName)
    .map((file) => `${companyId}/${file.name}`)

  if (supersededPaths.length === 0) return null

  const { error: removeError } = await bucket.remove(supersededPaths)
  return removeError
}
