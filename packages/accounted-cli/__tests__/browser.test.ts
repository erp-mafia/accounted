import { describe, expect, it, vi } from 'vitest'
import { openBrowser } from '../lib/browser.mjs'

const URL_WITH_AMPERSANDS =
  'https://app.accounted.se/api/mcp-oauth/authorize?response_type=code&state=a&code_challenge=b'

function fakeSpawn() {
  const child = { on: vi.fn(), unref: vi.fn() }
  const spawn = vi.fn(() => child)
  return { spawn, child }
}

describe('openBrowser', () => {
  it.each([
    ['linux', 'xdg-open', [URL_WITH_AMPERSANDS]],
    ['darwin', 'open', [URL_WITH_AMPERSANDS]],
    // `start` is a cmd builtin and would cut the URL at the first &.
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', URL_WITH_AMPERSANDS]],
  ])('%s: passes the whole URL as one argument, without a shell', (platform, command, args) => {
    const { spawn, child } = fakeSpawn()
    expect(openBrowser(URL_WITH_AMPERSANDS, { platform, spawn: spawn as never })).toBe(true)
    expect(spawn).toHaveBeenCalledWith(command, args, { stdio: 'ignore', detached: true, shell: false })
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child.unref).toHaveBeenCalled()
  })

  it('reports failure quietly when nothing can be started', () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT')
    })
    expect(openBrowser(URL_WITH_AMPERSANDS, { platform: 'linux', spawn: spawn as never })).toBe(false)
  })
})
