/**
 * One value per process, however many copies of the calling module the
 * process holds.
 *
 * A production server holds more than one copy of a module: Turbopack
 * compiles a module once per layer (route handlers, pages, the
 * instrumentation hook), and every copy keeps its own module-level state. Since
 * lib/init loads from instrumentation.ts (lib/initialized.ts), the handlers it
 * registers and the services it fills live in the instrumentation copy, while
 * a route reads them through its own copy. State that one copy fills and
 * another reads therefore lives on globalThis, one key per value, namespaced
 * `__accounted_<name>`: the event bus's handler table, the registries lib/init
 * fills, the init loader itself, and the AsyncLocalStorage scopes a route opens
 * and extension code reads. The first copy to ask creates the value; every
 * later copy gets the same one.
 *
 * Dependency-free on purpose: client bundles, the instrumentation hook and
 * scripts all import it.
 */
const PREFIX = '__accounted_'

type GlobalStore = Record<string, unknown>

export function globalSingleton<T>(name: string, create: () => T): T {
  const store = globalThis as unknown as GlobalStore
  const key = PREFIX + name
  if (!(key in store)) store[key] = create()
  return store[key] as T
}

/**
 * Tests only: forget every value globalSingleton() holds, so a test that
 * re-imports modules after vi.resetModules() gets fresh state there too.
 * Without the reset the new module copies would find the old values.
 */
export function resetGlobalSingletons(): void {
  const store = globalThis as unknown as GlobalStore
  for (const key of Object.keys(store)) {
    if (key.startsWith(PREFIX)) delete store[key]
  }
}
