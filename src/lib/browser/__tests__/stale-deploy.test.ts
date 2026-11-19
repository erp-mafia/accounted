import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  STALE_DEPLOY_EVENT,
  installStaleDeployListener,
  isStaleDeployError,
  onStaleDeploy,
} from '../stale-deploy'

/** What Next.js throws for an action id the server does not know. */
function unrecognizedAction(): Error {
  const error = new Error(
    'Server Action "40ee42ba28e83ffc034978f5b7595f544930be9e37" was not found on the server.',
  )
  error.name = 'UnrecognizedActionError'
  return error
}

function rejectionEvent(reason: unknown): Event {
  return Object.assign(new Event('unhandledrejection'), { reason })
}

function errorEvent(error: unknown): Event {
  return Object.assign(new Event('error'), { error })
}

function setup() {
  const win = new EventTarget() as unknown as Window
  const stale = vi.fn()
  const uninstall = installStaleDeployListener(win)
  const unsubscribe = onStaleDeploy(win, stale)
  return { win, stale, uninstall, unsubscribe }
}

describe('stale deploy detection', () => {
  it('recognises the error Next.js throws for an unknown Server Action', () => {
    expect(isStaleDeployError(unrecognizedAction())).toBe(true)
    expect(isStaleDeployError(new Error('Server Action failed'))).toBe(false)
    expect(isStaleDeployError('UnrecognizedActionError')).toBe(false)
    expect(isStaleDeployError(null)).toBe(false)
  })

  it('an unhandled rejection from a dead click announces the stale deploy', () => {
    const { win, stale } = setup()
    win.dispatchEvent(rejectionEvent(unrecognizedAction()))
    expect(stale).toHaveBeenCalledTimes(1)
  })

  it('an uncaught error carrying it does too', () => {
    const { win, stale } = setup()
    win.dispatchEvent(errorEvent(unrecognizedAction()))
    expect(stale).toHaveBeenCalledTimes(1)
  })

  it('ordinary failures do not prompt a reload', () => {
    const { win, stale } = setup()
    win.dispatchEvent(rejectionEvent(new TypeError('Failed to fetch')))
    win.dispatchEvent(errorEvent(new Error('Minified React error #418')))
    expect(stale).not.toHaveBeenCalled()
  })

  it('uninstall and unsubscribe stop listening', () => {
    const { win, stale, uninstall, unsubscribe } = setup()
    uninstall()
    win.dispatchEvent(rejectionEvent(unrecognizedAction()))
    expect(stale).not.toHaveBeenCalled()
    unsubscribe()
    win.dispatchEvent(new Event(STALE_DEPLOY_EVENT))
    expect(stale).not.toHaveBeenCalled()
  })
})

// No component tests in this repo: pin the two wiring points by source so a
// refactor cannot silently drop either end of the signal.
describe('stale deploy wiring', () => {
  const SRC = path.resolve(__dirname, '../../..')

  it('every page installs the listener before hydration', () => {
    const src = readFileSync(path.join(SRC, 'instrumentation-client.ts'), 'utf8')
    expect(src).toMatch(/installStaleDeployListener\(window\)/)
  })

  it('DeployReloadPrompt shows its reload card on the announcement', () => {
    const src = readFileSync(path.join(SRC, 'components/system/DeployReloadPrompt.tsx'), 'utf8')
    expect(src).toMatch(/onStaleDeploy\(window, \(\) => \{\s+setLiveBuildId\(\(known\) => known \?\? ''\)[\s\S]{0,120}setCardDue\(true\)/)
  })

  it('Ladda om shows that it is working and reloads once, however often it is clicked', () => {
    const src = readFileSync(path.join(SRC, 'components/system/DeployReloadPrompt.tsx'), 'utf8')
    // The old page stays on screen until the new document answers: without
    // the loading state the click looked dead, and each repeat restarted it.
    expect(src).toMatch(/loading=\{reloading\}/)
    expect(src).toMatch(/if \(reloading\) return\s+setReloading\(true\)\s+window\.location\.reload\(\)/)
    expect(src.match(/window\.location\.reload\(\)/g)).toHaveLength(1)
  })
})
