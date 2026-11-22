import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { beforeEach, vi } from 'vitest'

// The unit project runs with `isolate: false`: one worker process runs many
// test files in turn instead of starting a new process for each. Most of a
// unit file's time used to be that start (Node, Vitest and every package the
// file imports, loaded again), so this is where the suite's speed comes from.
//
// This file is the first setup file, and setup files run again before every
// test file, so it gives each file the isolation a new process gave it:
//
//   * Modules and mocks: reset as Vitest resets them between files when
//     `isolate` is on (vitest/dist chunks/base: `mocker.reset()` and
//     `resetModules(evaluatedModules, true)`), and a mocked module's node
//     also forgets its mock. Every module under src/ is evaluated again and
//     every `vi.mock` meets an empty registry.
//   * The set in which Vitest keeps every mock function for
//     `vi.clearAllMocks()` (@vitest/spy's REGISTERED_MOCKS) is emptied, as a
//     new process started it empty. Kept across files it grows without end:
//     every clearAllMocks() walks every mock the worker ever made, and the
//     old mocks keep earlier files' modules alive.
//   * The app's own singletons on globalThis (`__accounted_*`: the event bus,
//     the extension registry, the request trace store, ...) are removed, so
//     the modules evaluated again create them anew.
//   * Globals a previous file changed or stubbed, environment variables,
//     console methods and fake timers are put back to what the worker's first
//     file started with.
//   * Registries the app fills inside a package (@react-pdf's Font, which
//     src/lib/invoices/pdf-fonts.ts and src/lib/pdf/bundled-fonts.ts register
//     into) go back to what the package itself put there, once the worker
//     has loaded it.
//
// What stays loaded is what Vitest loads natively: the packages in
// node_modules. A global a package defines when it loads (tslib's helpers,
// zod's registry, Next.js's async storages) stays with it, because the
// package does not load again to define it a second time.
//
// It reads three Vitest internals. If one is missing (a Vitest upgrade moved
// it) it throws, so the suite fails instead of letting files share mocks.
//
// A test that fails only beside other files (it passes alone) meets state an
// earlier file left behind. Its first failure prints the files its worker ran
// before it and the command that replays them in that order
// (tests/unit/replay.config.ts).

type ModuleNode = {
  meta?: unknown
  promise?: unknown
  exports?: unknown
  evaluated: boolean
  importers: Set<string>
}

type Baseline = {
  files: string[]
  mocks: Set<unknown>
  envObject: NodeJS.ProcessEnv
  env: Record<string, string | undefined>
  globals: Map<PropertyKey, PropertyDescriptor>
  console: Map<PropertyKey, PropertyDescriptor>
}

type WorkerGlobals = {
  __vitest_worker__?: {
    filepath?: string
    evaluatedModules?: { idToModuleMap?: Map<string, ModuleNode>; invalidateModule?: (node: ModuleNode) => void }
  }
  __vitest_mocker__?: { reset?: () => void }
  __unitIsolationBaseline?: Baseline
  AsyncLocalStorage?: unknown
}

const g = globalThis as unknown as WorkerGlobals & Record<PropertyKey, unknown>

const evaluatedModules = g.__vitest_worker__?.evaluatedModules
const modules = evaluatedModules?.idToModuleMap
const invalidate = evaluatedModules?.invalidateModule?.bind(evaluatedModules)
const mocker = g.__vitest_mocker__
if (!modules || !invalidate || typeof mocker?.reset !== 'function') {
  throw new Error(
    'tests/unit/isolate-modules.ts: Vitest internals __vitest_worker__.evaluatedModules or __vitest_mocker__.reset are missing. ' +
      'Without them test files would share mocks; check the Vitest upgrade.',
  )
}

// Vitest's own modules stay, as in its own reset; so does this file, which is
// running while the reset happens.
const keep = [/\/vitest\/dist\//, /vitest-virtual-\w+\/dist/, /@vitest\/dist/, /tests\/unit\/isolate-modules\.ts/]

mocker.reset()
modules.forEach((node, id) => {
  if (keep.some((re) => re.test(id))) return
  // A mocked module's node keeps the mock (meta.mockedModule) and with it the
  // factory's result, which holds the previous file's modules: forgotten
  // here, a worker kept every file it ran and grew to its heap limit.
  if (node.meta && typeof node.meta === 'object' && 'mockedModule' in node.meta) invalidate(node)
  node.promise = undefined
  node.exports = undefined
  node.evaluated = false
  node.importers.clear()
})

const snapshot = (target: object) => {
  const out = new Map<PropertyKey, PropertyDescriptor>()
  for (const key of Reflect.ownKeys(target)) {
    const d = Object.getOwnPropertyDescriptor(target, key)
    if (d) out.set(key, d)
  }
  return out
}

// The packages loaded so far, from the ids of the modules Vitest has seen.
const loaded = (pkg: string) => {
  for (const id of modules.keys()) if (id.includes(`/node_modules/${pkg}/`)) return true
  return false
}

// The flags count too: a test that only makes a global read-only or hidden
// changes it for every file after it.
const sameDescriptor = (a: PropertyDescriptor, b: PropertyDescriptor) =>
  Object.is(a.value, b.value) &&
  a.get === b.get &&
  a.set === b.set &&
  a.writable === b.writable &&
  a.enumerable === b.enumerable &&
  a.configurable === b.configurable

const restore = (target: object, saved: Map<PropertyKey, PropertyDescriptor>, skip: (key: PropertyKey) => boolean) => {
  for (const [key, d] of saved) {
    if (skip(key)) continue
    const now = Object.getOwnPropertyDescriptor(target, key)
    if (now && sameDescriptor(now, d)) continue
    if (now && !now.configurable) continue
    Object.defineProperty(target, key, d)
  }
}

// @vitest/spy does not export its registry of mocks, so it is found by what
// it holds: the one Set that a new vi.fn() is added to.
const findRegisteredMocks = (): Set<unknown> => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const add = Set.prototype.add
  const receivers: Set<unknown>[] = []
  let probe: unknown
  Set.prototype.add = function (this: Set<unknown>, value: unknown) {
    if (typeof value === 'function') receivers.push(this)
    return add.call(this, value)
  }
  try {
    probe = vi.fn()
  } finally {
    Set.prototype.add = add
  }
  const found = receivers.find((set) => set.has(probe))
  if (!found) {
    throw new Error(
      'tests/unit/isolate-modules.ts: could not find the set @vitest/spy keeps every mock in (REGISTERED_MOCKS). ' +
        'Without emptying it test files would slow each other down; check the Vitest upgrade.',
    )
  }
  found.delete(probe)
  return found
}

const isVitestGlobal = (key: PropertyKey) => typeof key === 'string' && key.startsWith('__vitest')
const isAppSingleton = (key: PropertyKey) => typeof key === 'string' && key.startsWith('__accounted_')

if (!g.__unitIsolationBaseline) {
  // What Next.js's server does before anything else loads
  // (next/dist/server/node-environment-baseline.js). Without it, whichever
  // file first loads Next's async storages decides for the whole worker
  // whether they work.
  if (typeof g.AsyncLocalStorage !== 'function') g.AsyncLocalStorage = AsyncLocalStorage

  const baseline: Baseline = {
    files: [],
    mocks: findRegisteredMocks(),
    envObject: process.env,
    env: { ...process.env },
    globals: snapshot(globalThis),
    console: snapshot(console),
  }
  Object.defineProperty(globalThis, '__unitIsolationBaseline', { value: baseline, enumerable: false })
} else {
  const baseline = g.__unitIsolationBaseline
  // Vitest restored the previous file's spies after it ran; the mocks
  // themselves go now.
  baseline.mocks.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()

  // Some tests replace the whole object (`process.env = { ...saved }`). The
  // real one goes back first: Vitest's stubEnv writes through `process.env`
  // but its unstubAllEnvs deletes from the object it captured at start-up,
  // so on a replaced object a stub from the next file would never come off.
  if (process.env !== baseline.envObject) process.env = baseline.envObject
  vi.unstubAllEnvs()
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline.env)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(baseline.env)) {
    if (process.env[key] !== value) process.env[key] = value
  }

  for (const key of Reflect.ownKeys(globalThis)) {
    if (isAppSingleton(key) && !baseline.globals.has(key)) delete g[key]
  }
  restore(globalThis, baseline.globals, (key) => isVitestGlobal(key) || key === '__unitIsolationBaseline')
  restore(console, baseline.console, () => false)

  if (loaded('@react-pdf/renderer')) {
    // A new store holds what @react-pdf registers itself when it loads
    // (Helvetica, Times, Courier) and nothing the app registered: what a new
    // process had. Font.clear() would drop the standard fonts too.
    const { Font } = await import('@react-pdf/renderer')
    const fresh = new (Font.constructor as new () => typeof Font)()
    Font.fontFamilies = fresh.fontFamilies
    Font.emojiSource = fresh.emojiSource
    Font.hyphenationCallback = fresh.hyphenationCallback
  }
}

const ran = (g.__unitIsolationBaseline as Baseline).files
const current = g.__vitest_worker__?.filepath
if (current) ran.push(path.relative(process.cwd(), current))
let explained = false
beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    if (explained || ran.length < 2) return
    explained = true
    const quoted = ran.map((f) => `'${f}'`).join(' ')
    console.error(
      `\nThis file ran after ${ran.length - 1} other file(s) in the same worker. If the test passes alone, replay them in order:\n` +
        `  REPLAY_FILES='${ran.join(',')}' npx vitest run --config tests/unit/replay.config.ts --project unit --maxWorkers=1 --no-file-parallelism ${quoted}\n`,
    )
  })
})
