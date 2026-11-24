import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAgentItemPageEnabled, isAgentsPageEnabled, isOwnItemSegment } from '../flag'

afterEach(() => vi.unstubAllEnvs())

describe('isAgentsPageEnabled', () => {
  it('hides the page on Vercel production when no companies are listed', () => {
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(isAgentsPageEnabled('company-a')).toBe(false)
  })

  it('shows it on previews and locally when no companies are listed', () => {
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', '')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(isAgentsPageEnabled('company-a')).toBe(true)
    vi.stubEnv('VERCEL_ENV', '')
    expect(isAgentsPageEnabled('company-a')).toBe(true)
  })

  it('shows it to listed companies only, or to everyone with *', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', 'company-a, company-b')
    expect(isAgentsPageEnabled('company-b')).toBe(true)
    expect(isAgentsPageEnabled('company-c')).toBe(false)
    expect(isAgentsPageEnabled(null)).toBe(false)
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', '*')
    expect(isAgentsPageEnabled('company-c')).toBe(true)
  })
})

const OWN_ID = '11111111-1111-4111-8111-111111111111'
const OWN_ITEM_SEGMENTS: readonly string[] = ['ny', `own-${OWN_ID}`, `egen.${OWN_ID}`]
const OTHER_SEGMENTS: readonly string[] = ['bookkeep', 'kunskap.horizontal.swedish-vat', 'analys.kassaprognos', 'community.some-item', 'av.someone', 'nyhet', 'egen', 'own']

describe('isOwnItemSegment', () => {
  it('names the page that adds an item, an own flow and own knowledge or an own analysis', () => {
    for (const segment of OWN_ITEM_SEGMENTS) expect(isOwnItemSegment(segment), segment).toBe(true)
  })

  it('names no other page', () => {
    for (const segment of OTHER_SEGMENTS) expect(isOwnItemSegment(segment), segment).toBe(false)
  })
})

describe('isAgentItemPageEnabled', () => {
  /** Each switch on for company-a or off for it, on Vercel production (where an unset Agenter switch means off). */
  function switches({ agents, picture }: { agents: boolean; picture: boolean }) {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', agents ? 'company-a' : '')
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', picture ? 'company-a' : '')
  }

  it('opens every page where the Agenter page is on, with or without the picture', () => {
    for (const picture of [true, false]) {
      switches({ agents: true, picture })
      for (const segment of [...OWN_ITEM_SEGMENTS, ...OTHER_SEGMENTS]) expect(isAgentItemPageEnabled('company-a', segment), segment).toBe(true)
    }
  })

  it('opens an own item\'s pages, and no other, where only the picture is on', () => {
    switches({ agents: false, picture: true })
    for (const segment of OWN_ITEM_SEGMENTS) expect(isAgentItemPageEnabled('company-a', segment), segment).toBe(true)
    for (const segment of OTHER_SEGMENTS) expect(isAgentItemPageEnabled('company-a', segment), segment).toBe(false)
  })

  it('opens no page where both are off', () => {
    switches({ agents: false, picture: false })
    for (const segment of [...OWN_ITEM_SEGMENTS, ...OTHER_SEGMENTS]) expect(isAgentItemPageEnabled('company-a', segment), segment).toBe(false)
  })

  it('answers per company: another company\'s picture opens nothing', () => {
    switches({ agents: false, picture: true })
    for (const segment of OWN_ITEM_SEGMENTS) expect(isAgentItemPageEnabled('company-b', segment), segment).toBe(false)
    for (const segment of OWN_ITEM_SEGMENTS) expect(isAgentItemPageEnabled(null, segment), segment).toBe(false)
  })
})

describe('the doors that follow the Agenter page switch', () => {
  /** Every source file under a directory, tests left out. */
  function sourceFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) found.push(...sourceFiles(full))
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full)
    }
    return found
  }

  it('no API route reads the switch itself: an own item is listed, saved, changed, shared and removed whatever it says', () => {
    const api = join(__dirname, '..', '..', '..', 'app', 'api')
    const readers = sourceFiles(api).filter((file) => readFileSync(file, 'utf8').includes('isAgentsPageEnabled'))
    expect(readers, 'a route that must follow the Agenter page switch asks isAgentItemPageEnabled, so a company with the agent picture is let through').toEqual([])
  })
})
