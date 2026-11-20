/**
 * The message namespaces the ROOT NextIntlClientProvider (src/app/layout.tsx)
 * hands to client components.
 *
 * Every page inlines its client provider's messages into the HTML, so passing
 * the full catalog from the root layout (about 0.8 MB per locale) made every
 * page, the public login and invoice links included, carry every string of the
 * app. The root now passes only these top-level namespaces: what client code
 * on the pages outside the dashboard reads (auth, public, invite, sandbox,
 * root error pages, and the root layout's own toaster and deploy prompt).
 * Layouts whose pages read the rest render AllMessagesProvider
 * (src/components/providers/AllMessagesProvider.tsx) around their subtree.
 *
 * scripts/checks/__tests__/root-client-translations.test.ts derives the set
 * from the import graph and fails when a client component served by the root
 * provider reads a namespace missing here (it would render raw keys in
 * production), reads the whole catalog, or when an entry here is no longer
 * read at all. Server components are unaffected either way: getTranslations
 * and server-side useTranslations read the full catalog on the server.
 *
 * One blind spot: an element created on a dashboard page but rendered by a
 * root-level host (the Toaster renders a toast's title, description and
 * action) runs under the root provider. Pass such hosts translated strings,
 * never a component that calls useTranslations itself.
 */
export const ROOT_CLIENT_NAMESPACES = [
  'auth',
  'common',
  'invite',
  'mfa',
  'register',
  'reset_password',
  'support_link',
] as const

/** Only the top-level `namespaces` of `messages`; missing ones are skipped. */
export function pickNamespaces<T extends Record<string, unknown>>(
  messages: T,
  namespaces: readonly string[],
): Partial<T> {
  const picked: Partial<T> = {}
  for (const namespace of namespaces) {
    const key = namespace as keyof T
    if (Object.hasOwn(messages, key)) picked[key] = messages[key]
  }
  return picked
}
