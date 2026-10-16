import { registerInitLoader } from '../../src/lib/initialized'

/**
 * Register the loader of lib/init for a script, as instrumentation.ts does for
 * the app. There is no instrumentation hook outside Next.js, and without a
 * loader the first event reaches no handler: no event_log row, no webhook, no
 * extension. Call it at the start of every script whose code posts through
 * the bookkeeping engine, emits an event or reads a registry lib/init fills.
 * The load still happens on the first event, not here.
 */
export function registerScriptInitLoader(): void {
  registerInitLoader(() => import('../../src/lib/init').then((m) => m.ensureInitialized()))
}
