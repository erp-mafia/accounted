import { createRequire } from 'node:module'
import path from 'node:path'
import { registerInitLoader, type InitLoader } from '../../src/lib/initialized'

/**
 * Register the loader of lib/init for a script, as instrumentation.ts does for
 * the app. There is no instrumentation hook outside Next.js, and without a
 * loader the first event reaches no handler: no event_log row, no webhook, no
 * extension. Call it at the start of every script whose code posts through
 * the bookkeeping engine, emits an event or reads a registry lib/init fills.
 * The load still happens on the first event, not here.
 *
 * Such a script runs under the react-server condition, as the Next.js server
 * does:
 *
 *   node --import tsx --conditions react-server scripts/<script>.ts
 *   npx tsx --conditions react-server scripts/<script>.ts
 *
 * Without it `server-only`, which modules lib/init reaches import, resolves to
 * its throwing entry and lib/init cannot load. On the server the event bus logs
 * a failed load and retries it on the next event (lib/events/bus.ts); a script
 * would carry on posting with every event reaching no handler. So a script
 * stops instead, with exit code 1 and the fix in the message: a missing
 * condition here, before it has done anything, and any other failed load at
 * the first event or registry read. `npm run check:guards`
 * (script-init-condition) holds every scripted or documented invocation of
 * such a script to the condition.
 */
export function registerScriptInitLoader(): void {
  const script = scriptName()
  if (!resolvesReactServer()) exitScript(missingConditionMessage(script))
  registerInitLoader(
    fatalInitLoader(
      () => import('../../src/lib/init').then((m) => m.ensureInitialized()),
      (err) => exitScript(initLoadFailedMessage(script, err, resolvesReactServer())),
    ),
  )
}

/**
 * True when this process resolves imports under the react-server condition,
 * found out the way lib/init would: `server-only` loads (under react-server
 * its entry is empty) instead of throwing.
 */
export function resolvesReactServer(load: (id: string) => unknown = createRequire(import.meta.url)): boolean {
  try {
    load('server-only')
    return true
  } catch {
    return false
  }
}

/**
 * A loader of lib/init whose failure ends the script (`fail` never returns)
 * instead of rejecting into the event bus, which would log it and dispatch the
 * event to no handler.
 */
export function fatalInitLoader(load: InitLoader, fail: (err: unknown) => never): InitLoader {
  return async () => {
    try {
      await load()
    } catch (err) {
      fail(err)
    }
  }
}

export function missingConditionMessage(script: string): string {
  return [
    `${script} must run under the react-server condition, as the Next.js server does. Nothing was done.`,
    'Without it lib/init cannot load (server-only throws outside react-server): every event the script emits would',
    'reach no handler (no event_log row, no webhook, no extension) and the registries lib/init fills would stay empty.',
    `  fix: node --import tsx --conditions react-server ${script} ...`,
    `   or: npx tsx --conditions react-server ${script} ...`,
  ].join('\n')
}

export function initLoadFailedMessage(script: string, err: unknown, reactServer: boolean): string {
  const cause = err instanceof Error ? err.message : String(err)
  return [
    `${script}: lib/init failed to load, so events would reach no handler (no event_log row, no webhook, no extension).`,
    'Stopped instead of carrying on without them.',
    `  cause: ${cause}`,
    reactServer
      ? '  fix: the cause above (the react-server condition is in place)'
      : `  fix: node --import tsx --conditions react-server ${script} ...`,
  ].join('\n')
}

function scriptName(): string {
  const entry = process.argv[1]
  if (!entry) return 'this script'
  const relative = path.relative(process.cwd(), entry)
  return relative && !relative.startsWith('..') ? relative : entry
}

function exitScript(message: string): never {
  console.error(message)
  process.exit(1)
}
