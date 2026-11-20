import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { isTrustedPopupMessage } from '@/lib/hooks/use-oauth-popup'

const APP = 'https://app.accounted.se'
const ownOrigin = (origin: string) => origin === APP

describe('isTrustedPopupMessage', () => {
  const popup = {} as Window
  const otherWindow = {} as Window

  it('accepts a message from the opened window on an allowed origin', () => {
    expect(isTrustedPopupMessage({ origin: APP, source: popup }, popup, ownOrigin)).toBe(true)
  })

  it('refuses a same-origin message from another window', () => {
    expect(isTrustedPopupMessage({ origin: APP, source: otherWindow }, popup, ownOrigin)).toBe(false)
  })

  it('refuses the opened window posting from a foreign origin', () => {
    expect(isTrustedPopupMessage({ origin: 'https://evil.example', source: popup }, popup, ownOrigin)).toBe(false)
  })

  it('refuses everything while no window has been opened', () => {
    expect(isTrustedPopupMessage({ origin: APP, source: null }, null, ownOrigin)).toBe(false)
  })
})

/**
 * Every OAuth popup listener goes through useOAuthPopup, so none can check
 * the origin and forget the source (or the other way round). The MCP widgets
 * are inline scripts for the host's iframe, not app windows: out of scope.
 */
describe('postMessage listeners', () => {
  const SRC = path.resolve(__dirname, '../../..')
  const HOOK = path.join(SRC, 'lib/hooks/use-oauth-popup.ts')
  const WIDGETS = path.join(SRC, 'extensions/general/mcp-server/widgets')

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        return name === '__tests__' || full === WIDGETS ? [] : sources(full)
      }
      return /\.tsx?$/.test(name) ? [full] : []
    })
  }

  it('live only in useOAuthPopup', () => {
    const offenders = sources(SRC)
      .filter((file) => file !== HOOK)
      .filter((file) => /addEventListener\(\s*['"]message['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file))
    expect(offenders).toEqual([])
  })
})
