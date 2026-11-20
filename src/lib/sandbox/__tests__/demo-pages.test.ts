import { describe, expect, it } from 'vitest'
import { demoPagesEnabled } from '../demo-pages'

describe('demoPagesEnabled', () => {
  it('answers in development and on a preview deployment', () => {
    expect(demoPagesEnabled({ NODE_ENV: 'development' })).toBe(true)
    expect(demoPagesEnabled({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toBe(true)
  })

  it('is closed on a production deployment and on a production build without Vercel', () => {
    expect(demoPagesEnabled({ NODE_ENV: 'production', VERCEL_ENV: 'production' })).toBe(false)
    expect(demoPagesEnabled({ NODE_ENV: 'production' })).toBe(false)
  })

  it('opens when the installation asks for it', () => {
    expect(demoPagesEnabled({ NODE_ENV: 'production', VERCEL_ENV: 'production', SANDBOX_DEMO_PAGES: 'true' })).toBe(true)
    expect(demoPagesEnabled({ NODE_ENV: 'production', SANDBOX_DEMO_PAGES: '1' })).toBe(false)
  })
})
