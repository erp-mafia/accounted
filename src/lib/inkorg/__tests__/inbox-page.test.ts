import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPABILITY } from '@/lib/entitlements/keys'

const { hasCapabilityMock, definitionMock } = vi.hoisted(() => ({
  hasCapabilityMock: vi.fn(),
  definitionMock: vi.fn(),
}))
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))
vi.mock('@/lib/extensions/sectors', () => ({
  getExtensionDefinition: (...args: unknown[]) => definitionMock(...args),
}))

import {
  companyInboxReads,
  inboxIsNewPage,
  inkorgHrefFromWorkspaceQuery,
  isInboxWorkspace,
  whyNotNewInbox,
  type InboxPageReads,
  type NotNewInboxReason,
} from '../inbox-page'

const supabase = {} as SupabaseClient
const BOTH = [true, false] as const

interface Facts {
  inRollout: boolean
  extensionExists: boolean
  sandboxLocked: boolean
  hasCapability: boolean
}

/** Every combination of the four things the rule reads. */
const EVERY_CASE: Facts[] = BOTH.flatMap((inRollout) =>
  BOTH.flatMap((extensionExists) =>
    BOTH.flatMap((sandboxLocked) => BOTH.map((hasCapability) => ({ inRollout, extensionExists, sandboxLocked, hasCapability }))),
  ),
)

function readsOf(facts: Facts) {
  const sandboxLocked = vi.fn(() => facts.sandboxLocked)
  const hasCapability = vi.fn(async () => facts.hasCapability)
  const reads: InboxPageReads = { inRollout: facts.inRollout, extensionExists: facts.extensionExists, sandboxLocked, hasCapability }
  return { reads, sandboxLocked, hasCapability }
}

/** The answer written out by hand, check by check, to hold the rule against. */
function expected(facts: Facts): NotNewInboxReason | null {
  if (!facts.inRollout) return 'outside_rollout'
  if (!facts.extensionExists) return 'no_extension'
  if (facts.sandboxLocked) return 'sandbox_lock'
  if (!facts.hasCapability) return 'no_capability'
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  definitionMock.mockReturnValue({ sector: 'general', slug: 'invoice-inbox' })
  hasCapabilityMock.mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('whyNotNewInbox: which page is a company\'s inbox', () => {
  it('covers all sixteen cases', () => {
    expect(EVERY_CASE).toHaveLength(16)
    expect(new Set(EVERY_CASE.map((c) => JSON.stringify(c))).size).toBe(16)
  })

  it.each(EVERY_CASE)('rollout $inRollout, extension $extensionExists, sandbox lock $sandboxLocked, capability $hasCapability', async (facts) => {
    const { reads } = readsOf(facts)
    expect(await whyNotNewInbox(reads)).toBe(expected(facts))
    expect(await inboxIsNewPage(reads)).toBe(expected(facts) === null)
  })

  it('is the new page in exactly one case: in the rollout, the extension installed, no sandbox lock, the capability held', async () => {
    const yes: Facts[] = []
    for (const facts of EVERY_CASE) if (await inboxIsNewPage(readsOf(facts).reads)) yes.push(facts)
    expect(yes).toEqual([{ inRollout: true, extensionExists: true, sandboxLocked: false, hasCapability: true }])
  })

  it('reads nothing for a company outside the rollout or an installation without the extension', async () => {
    for (const facts of EVERY_CASE.filter((c) => !c.inRollout || !c.extensionExists)) {
      const { reads, sandboxLocked, hasCapability } = readsOf(facts)
      await whyNotNewInbox(reads)
      expect(sandboxLocked).not.toHaveBeenCalled()
      expect(hasCapability).not.toHaveBeenCalled()
    }
  })

  it('asks the sandbox lock before the capability, and not the capability behind a lock', async () => {
    const locked = readsOf({ inRollout: true, extensionExists: true, sandboxLocked: true, hasCapability: true })
    expect(await whyNotNewInbox(locked.reads)).toBe('sandbox_lock')
    expect(locked.hasCapability).not.toHaveBeenCalled()
    const open = readsOf({ inRollout: true, extensionExists: true, sandboxLocked: false, hasCapability: false })
    expect(await whyNotNewInbox(open.reads)).toBe('no_capability')
    expect(open.sandboxLocked).toHaveBeenCalledTimes(1)
    expect(open.hasCapability).toHaveBeenCalledTimes(1)
  })
})

/**
 * The two routes, as they use the rule (app/(dashboard)/inkorg/page.tsx and
 * app/(dashboard)/e/[sector]/[slug]/page.tsx): the new page's route sends
 * the request to the workspace for every reason but a missing extension
 * (which is a 404 there), and the workspace's route sends it to the new page
 * only when there is no reason. The routes themselves are walked in
 * app/(dashboard)/__tests__/inbox-routes.test.ts.
 */
describe('the rule cannot send a request back and forth', () => {
  const newPageRedirects = (why: NotNewInboxReason | null) => why !== null && why !== 'no_extension'
  const workspaceRedirects = (why: NotNewInboxReason | null) => why === null

  it.each(EVERY_CASE)('at most one redirect: rollout $inRollout, extension $extensionExists, sandbox lock $sandboxLocked, capability $hasCapability', async (facts) => {
    const why = await whyNotNewInbox(readsOf(facts).reads)
    // Never both: whichever route a request is sent to, that route stays.
    expect(newPageRedirects(why) && workspaceRedirects(why)).toBe(false)
    for (const start of ['new', 'workspace'] as const) {
      let at: 'new' | 'workspace' = start
      let hops = 0
      while (hops < 4 && (at === 'new' ? newPageRedirects(why) : workspaceRedirects(why))) {
        at = at === 'new' ? 'workspace' : 'new'
        hops += 1
      }
      expect(hops, `from the ${start} address`).toBeLessThanOrEqual(1)
      // Where it ends is the company's inbox, whichever address was asked for.
      if (why === null) expect(at).toBe('new')
      else if (why !== 'no_extension') expect(at).toBe('workspace')
    }
  })
})

describe('companyInboxReads: the rule\'s reads for one company', () => {
  const sandbox = (value: boolean) => vi.fn(async () => value)

  it('is in the rollout only for a listed company, and never without one', () => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', 'company-1')
    expect(companyInboxReads(supabase, 'company-1', sandbox(false)).inRollout).toBe(true)
    expect(companyInboxReads(supabase, 'company-2', sandbox(false)).inRollout).toBe(false)
    expect(companyInboxReads(supabase, null, sandbox(false)).inRollout).toBe(false)
    vi.stubEnv('INKORG_V2_COMPANY_IDS', '*')
    expect(companyInboxReads(supabase, 'company-2', sandbox(false)).inRollout).toBe(true)
    expect(companyInboxReads(supabase, null, sandbox(false)).inRollout).toBe(false)
    expect(companyInboxReads(supabase, undefined, sandbox(false)).inRollout).toBe(false)
  })

  it('asks the installation for the invoice-inbox extension', () => {
    expect(companyInboxReads(supabase, 'company-1', sandbox(false)).extensionExists).toBe(true)
    expect(definitionMock).toHaveBeenCalledWith('general', 'invoice-inbox')
    definitionMock.mockReturnValue(undefined)
    expect(companyInboxReads(supabase, 'company-1', sandbox(false)).extensionExists).toBe(false)
  })

  it('reads the sandbox lock from the caller\'s settings read, and only when asked', async () => {
    const isSandbox = sandbox(true)
    const reads = companyInboxReads(supabase, 'company-1', isSandbox)
    expect(isSandbox).not.toHaveBeenCalled()
    expect(await reads.sandboxLocked()).toBe(true)
    expect(await companyInboxReads(supabase, 'company-1', sandbox(false)).sandboxLocked()).toBe(false)
  })

  it('reads the capability the extension needs for the company, and only when asked', async () => {
    const reads = companyInboxReads(supabase, 'company-1', sandbox(false))
    expect(hasCapabilityMock).not.toHaveBeenCalled()
    expect(await reads.hasCapability()).toBe(true)
    expect(hasCapabilityMock).toHaveBeenCalledWith(supabase, 'company-1', CAPABILITY.ai)
    hasCapabilityMock.mockResolvedValue(false)
    expect(await companyInboxReads(supabase, 'company-1', sandbox(false)).hasCapability()).toBe(false)
  })

  it('holds no capability without a company, and reads nothing for it', async () => {
    expect(await companyInboxReads(supabase, null, sandbox(false)).hasCapability()).toBe(false)
    expect(hasCapabilityMock).not.toHaveBeenCalled()
  })

  it('answers the new page for a listed, paying company and the reason for every other', async () => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', 'company-1')
    expect(await whyNotNewInbox(companyInboxReads(supabase, 'company-1', sandbox(false)))).toBeNull()
    expect(await whyNotNewInbox(companyInboxReads(supabase, 'company-2', sandbox(false)))).toBe('outside_rollout')
    expect(await whyNotNewInbox(companyInboxReads(supabase, 'company-1', sandbox(true)))).toBe('sandbox_lock')
    hasCapabilityMock.mockResolvedValue(false)
    expect(await whyNotNewInbox(companyInboxReads(supabase, 'company-1', sandbox(false)))).toBe('no_capability')
    definitionMock.mockReturnValue(undefined)
    expect(await whyNotNewInbox(companyInboxReads(supabase, 'company-1', sandbox(false)))).toBe('no_extension')
  })
})

describe('isInboxWorkspace', () => {
  it('is the invoice-inbox workspace alone', () => {
    expect(isInboxWorkspace('general', 'invoice-inbox')).toBe(true)
    expect(isInboxWorkspace('general', 'arcim-migration')).toBe(false)
    expect(isInboxWorkspace('other', 'invoice-inbox')).toBe(false)
  })
})

describe('inkorgHrefFromWorkspaceQuery: what the redirect carries over', () => {
  it('is the new page itself for an address without parameters', () => {
    expect(inkorgHrefFromWorkspaceQuery({})).toBe('/inkorg')
  })

  it('keeps the document to open as the new page\'s focus', () => {
    expect(inkorgHrefFromWorkspaceQuery({ fokus: 'item-1' })).toBe('/inkorg?fokus=item-1')
    expect(inkorgHrefFromWorkspaceQuery({ fokus: 'forsta' })).toBe('/inkorg?fokus=forsta')
  })

  it('keeps the view, and the list to return to beside a document', () => {
    expect(inkorgHrefFromWorkspaceQuery({ view: 'missing' })).toBe('/inkorg?view=missing')
    const href = inkorgHrefFromWorkspaceQuery({ tillbaka: '/att-bokfora?filter=att-matcha', fokus: 'item-1', view: 'door:email' })
    const url = new URL(href, 'https://app.example')
    expect(url.pathname).toBe('/inkorg')
    expect([...url.searchParams.keys()]).toEqual(['view', 'fokus', 'tillbaka'])
    expect(url.searchParams.get('view')).toBe('door:email')
    expect(url.searchParams.get('fokus')).toBe('item-1')
    expect(url.searchParams.get('tillbaka')).toBe('/att-bokfora?filter=att-matcha')
  })

  it('drops the list to return to when no document is asked for: the new page reads it only beside one', () => {
    expect(inkorgHrefFromWorkspaceQuery({ tillbaka: '/att-bokfora' })).toBe('/inkorg')
    expect(inkorgHrefFromWorkspaceQuery({ tillbaka: '/att-bokfora', view: 'missing' })).toBe('/inkorg?view=missing')
  })

  it('drops every parameter the new page does not read', () => {
    expect(inkorgHrefFromWorkspaceQuery({ utm_source: 'mail', item: 'item-1', id: 'item-1', inbox_item_id: 'item-1', tab: 'done' })).toBe('/inkorg')
    expect(inkorgHrefFromWorkspaceQuery({ utm_source: 'mail', fokus: 'item-1', next: 'https://elsewhere.example' })).toBe('/inkorg?fokus=item-1')
  })

  it('takes the first value of a repeated parameter and leaves out an empty one', () => {
    expect(inkorgHrefFromWorkspaceQuery({ fokus: ['item-1', 'item-2'], view: ['missing', 'door:email'] })).toBe('/inkorg?view=missing&fokus=item-1')
    expect(inkorgHrefFromWorkspaceQuery({ fokus: '', view: undefined })).toBe('/inkorg')
    expect(inkorgHrefFromWorkspaceQuery({ fokus: [] })).toBe('/inkorg')
  })

  it('keeps a value one value: it cannot add a parameter, a fragment or another address', () => {
    const href = inkorgHrefFromWorkspaceQuery({ fokus: 'item-1&view=missing#top', view: 'portal:Exempel Å & Ö' })
    expect(href.startsWith('/inkorg?')).toBe(true)
    expect(href).not.toContain('#')
    const url = new URL(href, 'https://app.example')
    expect(url.pathname).toBe('/inkorg')
    expect(url.hash).toBe('')
    expect(url.searchParams.get('fokus')).toBe('item-1&view=missing#top')
    expect(url.searchParams.get('view')).toBe('portal:Exempel Å & Ö')
    expect(url.searchParams.getAll('view')).toHaveLength(1)
  })
})
