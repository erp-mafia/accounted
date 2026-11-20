import type { ReactNode } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'

/**
 * Hands every client component below it the full message catalog. The root
 * layout ships only ROOT_CLIENT_NAMESPACES (src/i18n/root-client-namespaces.ts)
 * so public and auth pages do not inline about 0.8 MB of translations; the
 * layouts whose pages read the rest (dashboard, onboarding, companies) render
 * this around their whole tree.
 *
 * A server component, so next-intl's server provider fills in locale, time
 * zone and formats from src/i18n/request.ts, the same values the root provider
 * gets. A nested provider REPLACES the parent's messages rather than merging
 * (use-intl's IntlProvider only falls back to the parent's when `messages` is
 * undefined), which is fine here: the full catalog is a superset of the root
 * list.
 *
 * scripts/checks/root-client-translations.mjs treats any layout importing this
 * component as covering its directory, so only route files outside these
 * subtrees have to fit the root list.
 */
export async function AllMessagesProvider({ children }: { children: ReactNode }) {
  const messages = await getMessages()
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
}
