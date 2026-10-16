import { createLogger } from '@/lib/logger'
import { globalSingleton } from '@/lib/global-singleton'

/**
 * lib/init (the core event handlers, the Peppol transports, the payments
 * provider, the extension context factory and every enabled extension) is
 * loaded by whatever runs the process, never by the code that needs it:
 *
 * - Under Next.js, instrumentation.ts register() registers the loader when
 *   the server boots and starts it in the background. It is the only module
 *   in the app that imports lib/init, so no route, page or server action
 *   compiles lib/init and every extension into its own graph
 *   (`npm run check:guards`: static-init-import, lazy-init-reach).
 * - Outside Next.js (a script, the pg-real and tool-pg suites, the unit test
 *   setup) the process registers it at its start with registerInitLoader().
 *
 * The event bus awaits whenInitialized() before its first dispatch, and every
 * registry lib/init fills awaits it before answering (the extension registry,
 * the agent tool registry, the email, mail-search, Peppol and payments
 * getters), so none of them can be read before lib/init has filled it.
 *
 * Concurrent callers share one load. A failed load is not cached: the next
 * caller tries again. With no loader registered, whenInitialized() resolves
 * at once without initialising and warns once per process.
 *
 * The state lives on globalThis (lib/global-singleton.ts): instrumentation is
 * an entry of its own, so the copy of this module it registers the loader in
 * is not the copy a route awaits.
 */
export type InitLoader = () => Promise<void>

interface InitLoaderState {
  load: InitLoader | null
  loading: Promise<void> | null
  warnedUnregistered: boolean
}

const state = globalSingleton(
  'initLoader',
  (): InitLoaderState => ({ load: null, loading: null, warnedUnregistered: false }),
)

const log = createLogger('init')

/**
 * Register what loads lib/init in this process. Called once at the process
 * start: by instrumentation.ts under Next.js, and by every script, worker or
 * test suite outside it whose code emits events or reads a registry:
 *
 *   registerInitLoader(() => import('@/lib/init').then((m) => m.ensureInitialized()))
 *
 * Registering again replaces the loader and forgets a load in progress.
 */
export function registerInitLoader(load: InitLoader): void {
  state.load = load
  state.loading = null
}

/** Resolves once lib/init has run in this process; see the module comment. */
export function whenInitialized(): Promise<void> {
  const load = state.load
  if (!load) {
    if (!state.warnedUnregistered) {
      state.warnedUnregistered = true
      log.warn(
        'no init loader registered: events reach no core or extension handler and the registries stay empty. ' +
          'Next.js registers it in instrumentation.ts; a script or worker that emits events or reads a registry ' +
          'calls registerInitLoader() at its start.',
      )
    }
    return Promise.resolve()
  }
  if (!state.loading) {
    const attempt: Promise<void> = Promise.resolve()
      .then(load)
      .catch((err: unknown) => {
        if (state.loading === attempt) state.loading = null
        throw err
      })
    state.loading = attempt
  }
  return state.loading
}

/**
 * Start the load without waiting for it: instrumentation.ts calls this at
 * boot, so the first event rarely waits for the extensions and server
 * readiness never does. A failure is logged here; the first event or registry
 * read retries it.
 */
export function startInitializing(): void {
  whenInitialized().catch((err: unknown) => {
    log.error('initialisation at startup failed; the next event or registry read retries it', err)
  })
}
