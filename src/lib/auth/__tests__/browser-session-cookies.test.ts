import { describe, it, expect } from 'vitest'
import {
  authCookieNames,
  cookieExpiryVariants,
  duplicateAuthCookieNames,
  scrubAuthCookies,
} from '../browser-session-cookies'

const AUTH = 'sb-abc-auth-token'

describe('authCookieNames', () => {
  it('keeps only sb- cookies, in order, duplicates included', () => {
    const cookie = `gnubok-company-id=x; ${AUTH}.0=a; ph_x=1; ${AUTH}.1=b; ${AUTH}.0=c`
    expect(authCookieNames(cookie)).toEqual([`${AUTH}.0`, `${AUTH}.1`, `${AUTH}.0`])
  })

  it('returns nothing for an empty cookie string', () => {
    expect(authCookieNames('')).toEqual([])
  })
})

describe('duplicateAuthCookieNames', () => {
  it('names an auth cookie the browser holds twice', () => {
    expect(duplicateAuthCookieNames(`${AUTH}=old; other=1; ${AUTH}=new`)).toEqual([AUTH])
  })

  it('is empty for a healthy chunked session', () => {
    expect(duplicateAuthCookieNames(`${AUTH}.0=a; ${AUTH}.1=b`)).toEqual([])
  })
})

describe('cookieExpiryVariants', () => {
  it('covers every ancestor path and every domain attribute', () => {
    const variants = cookieExpiryVariants(AUTH, 'app.accounted.se', '/settings/bank')
    const pathsAndDomains = variants.map((v) => {
      const path = /Path=([^;]+)/.exec(v)?.[1]
      const domain = /Domain=([^;]+)/.exec(v)?.[1] ?? null
      return `${path}|${domain}`
    })
    expect(pathsAndDomains).toEqual([
      '/|null', '/|app.accounted.se', '/|accounted.se',
      '/settings|null', '/settings|app.accounted.se', '/settings|accounted.se',
      '/settings/bank|null', '/settings/bank|app.accounted.se', '/settings/bank|accounted.se',
    ])
    for (const v of variants) {
      expect(v.startsWith(`${AUTH}=; Max-Age=0;`)).toBe(true)
    }
  })

  it('never writes a Domain for localhost or an IP address', () => {
    expect(cookieExpiryVariants(AUTH, 'localhost', '/').every((v) => !v.includes('Domain'))).toBe(true)
    expect(cookieExpiryVariants(AUTH, '127.0.0.1', '/').every((v) => !v.includes('Domain'))).toBe(true)
  })
})

describe('scrubAuthCookies', () => {
  it('writes an expiry for every variant of every distinct auth cookie and leaves other cookies alone', () => {
    const writes: string[] = []
    const doc = {
      get cookie() {
        return `${AUTH}=old; gnubok-company-id=x; ${AUTH}=new; sb-abc-auth-token-code-verifier=v`
      },
      set cookie(value: string) {
        writes.push(value)
      },
    }
    const scrubbed = scrubAuthCookies(doc, { hostname: 'app.accounted.se', pathname: '/' })
    expect(scrubbed).toBe(2)
    // 1 path x 3 domain variants x 2 names
    expect(writes).toHaveLength(6)
    expect(writes.some((w) => w.startsWith('gnubok-company-id'))).toBe(false)
  })
})
