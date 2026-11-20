import { describe, expect, it } from 'vitest'
import { configDir, mcpUrl, resolveCompany, resolveServer } from '../lib/config.mjs'
import { UsageError } from '../lib/errors.mjs'
import { COMPANY } from './helpers'

describe('resolveServer', () => {
  it('defaults to the hosted app', () => {
    expect(resolveServer(undefined)).toEqual({ origin: 'https://app.accounted.se', insecure: false })
    expect(resolveServer('  ')).toEqual({ origin: 'https://app.accounted.se', insecure: false })
  })

  it('accepts the app address with or without a trailing slash', () => {
    expect(resolveServer('https://books.example.se/').origin).toBe('https://books.example.se')
  })

  it('accepts the full MCP URL the accounted-mcp bridge documents', () => {
    const server = resolveServer('https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted')
    expect(server.origin).toBe('https://app.accounted.se')
  })

  it('refuses a company in the URL instead of silently dropping the pin', () => {
    expect(() =>
      resolveServer(`https://app.accounted.se/api/extensions/ext/mcp-server/mcp?company=${COMPANY}`)
    ).toThrow(UsageError)
  })

  it('refuses other paths, schemes and credentials in the URL', () => {
    expect(() => resolveServer('https://app.accounted.se/settings')).toThrow(UsageError)
    expect(() => resolveServer('ftp://app.accounted.se')).toThrow(UsageError)
    expect(() => resolveServer('https://user:pass@app.accounted.se')).toThrow(UsageError)
    expect(() => resolveServer('not a url')).toThrow(UsageError)
  })

  it('flags plain http except on loopback, and keeps a LAN self-host working', () => {
    expect(resolveServer('http://localhost:3000')).toEqual({ origin: 'http://localhost:3000', insecure: false })
    expect(resolveServer('http://127.0.0.1:3000').insecure).toBe(false)
    expect(resolveServer('http://192.168.1.20:3000')).toEqual({ origin: 'http://192.168.1.20:3000', insecure: true })
  })
})

describe('resolveCompany', () => {
  it('passes a UUID through, lower-cased', () => {
    expect(resolveCompany(COMPANY.toUpperCase())).toBe(COMPANY)
  })

  it('treats unset or empty as no pin', () => {
    expect(resolveCompany(undefined)).toBeUndefined()
    expect(resolveCompany(' ')).toBeUndefined()
  })

  it('fails closed on anything that is not a company id', () => {
    expect(() => resolveCompany('Acme AB')).toThrow(UsageError)
    expect(() => resolveCompany('11111111-1111-4111-8111')).toThrow(UsageError)
  })
})

describe('mcpUrl', () => {
  it('asks for the accounted_* tool names and adds the pin when given', () => {
    expect(mcpUrl('https://app.accounted.se', undefined)).toBe(
      'https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted'
    )
    expect(mcpUrl('https://app.accounted.se', COMPANY)).toBe(
      `https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted&company=${COMPANY}`
    )
  })
})

describe('configDir', () => {
  it('uses XDG_CONFIG_HOME when it is absolute', () => {
    expect(configDir({ env: { XDG_CONFIG_HOME: '/x/config' }, platform: 'linux', homedir: '/home/a' })).toBe(
      '/x/config/accounted'
    )
    expect(configDir({ env: { XDG_CONFIG_HOME: 'relative' }, platform: 'linux', homedir: '/home/a' })).toBe(
      '/home/a/.config/accounted'
    )
  })

  it('uses ~/.config on macOS too', () => {
    expect(configDir({ env: {}, platform: 'darwin', homedir: '/Users/a' })).toBe('/Users/a/.config/accounted')
  })

  it('uses %APPDATA% on Windows', () => {
    expect(configDir({ env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, platform: 'win32', homedir: 'C:\\Users\\a' })).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\accounted'
    )
    expect(configDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\a' })).toBe(
      'C:\\Users\\a\\AppData\\Roaming\\accounted'
    )
  })
})
