/**
 * lib/init (the core event handlers, the Peppol transports, the payments
 * provider, the extension context factory and every enabled extension) loads
 * on first use: the first event emitted (lib/events/bus.ts) or the first read
 * of a registry that init fills (the extension registry, the agent tool
 * registry, the email, mail-search, Peppol and payments getters). Nothing
 * calls it at module scope, so a request that neither emits nor reads one of
 * those registries never loads an extension.
 *
 * Concurrent first callers share one load. A failed load is not cached: the
 * next caller tries again.
 */
let loading: Promise<void> | null = null

export function whenInitialized(): Promise<void> {
  loading ??= import('@/lib/init')
    .then(({ ensureInitialized }) => ensureInitialized())
    .catch((err: unknown) => {
      loading = null
      throw err
    })
  return loading
}
