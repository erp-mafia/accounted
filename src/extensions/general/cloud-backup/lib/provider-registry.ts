/**
 * The cloud backup destinations this build knows about.
 *
 * Order matters: it is the order the providers are listed in the UI and the
 * order the cron walks them. Google Drive stays first because it shipped
 * first and every existing connection points at it.
 */
import { googleDriveProvider } from './google-provider'
import { dropboxProvider } from './dropbox-provider'
import type { CloudStorageProvider } from './cloud-provider'
import type { CloudProviderId } from '../types'

export const CLOUD_PROVIDERS: readonly CloudStorageProvider[] = [
  googleDriveProvider,
  dropboxProvider,
]

/** The destination assumed when a request names none: the original target. */
export const DEFAULT_PROVIDER_ID: CloudProviderId = 'google_drive'

export function getProvider(id: string | null | undefined): CloudStorageProvider | null {
  if (!id) return getProvider(DEFAULT_PROVIDER_ID)
  return CLOUD_PROVIDERS.find((p) => p.id === id) ?? null
}

/**
 * Resolve the provider named by a request's `?provider=` parameter.
 * Absent means Google Drive, so links and clients written before Dropbox
 * existed keep hitting the destination they meant.
 */
export function providerFromRequest(request: Request): CloudStorageProvider | null {
  return getProvider(new URL(request.url).searchParams.get('provider'))
}
