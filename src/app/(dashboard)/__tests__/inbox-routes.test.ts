import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The two inbox addresses, /inkorg (the new page) and /e/general/invoice-inbox
// (the workspace), as their routes answer them. Both ask one rule
// (lib/inkorg/inbox-page.ts): for a company whose inbox is the new page the
// workspace's address leads to the new page, for every other company the new
// page's address leads to the workspace, and neither sends a request back.
// Walked here over every case of the rule, from both addresses, through the
// real route functions.

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}))
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }))

vi.mock('@/components/inkorg/InkorgPage', () => ({ InkorgPage: () => null }))
vi.mock('@/components/extensions/ExtensionWorkspaceLoader', () => ({ default: () => null }))
vi.mock('@/components/extensions/ExtensionUpsellState', () => ({ ExtensionUpsellState: () => null }))
vi.mock('@/components/extensions/ExtensionSandboxLockState', () => ({ ExtensionSandboxLockState: () => null }))

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  companyId: 'company-1' as string | null,
  extensionExists: true,
  sandbox: false,
  capability: true,
}))
const reads = vi.hoisted(() => ({
  settings: vi.fn(),
  hasCapability: vi.fn(),
  loadCompanyCapabilities: vi.fn(),
}))

vi.mock('@/lib/extensions/sectors', () => ({
  getExtensionDefinition: (sector: string, slug: string) =>
    slug === 'invoice-inbox' && !state.extensionExists ? undefined : { sector, slug, name: slug, description: slug, icon: 'Inbox' },
}))
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => reads.hasCapability(...args),
}))
vi.mock('@/lib/modules/capabilities', () => ({
  loadCompanyCapabilities: (...args: unknown[]) => reads.loadCompanyCapabilities(...args),
}))
vi.mock('@/lib/inkorg/startable', () => ({ inkorgCompany: () => ({ startable: {}, ownerAccount: null }) }))
vi.mock('@/lib/company/entity-type', () => ({ resolveCompanyEntityType: async () => 'aktiebolag' }))

const supabase = {}
vi.mock('../request-context', () => ({
  getDashboardAuthContext: async () => ({ supabase, user: state.user }),
  getDashboardCompanyId: async () => state.companyId,
  getDashboardSettings: () => reads.settings(),
  redirectInvoicerOffPage: async () => undefined,
}))

const { default: InkorgRoute } = await import('../inkorg/page')
const { default: ExtensionWorkspacePage } = await import('../e/[sector]/[slug]/page')
const { InkorgPage } = await import('@/components/inkorg/InkorgPage')
const { default: ExtensionWorkspaceLoader } = await import('@/components/extensions/ExtensionWorkspaceLoader')
const { ExtensionUpsellState } = await import('@/components/extensions/ExtensionUpsellState')
const { ExtensionSandboxLockState } = await import('@/components/extensions/ExtensionSandboxLockState')

const NEW_PAGE = '/inkorg'
const WORKSPACE = '/e/general/invoice-inbox'

type Shown = 'new inbox' | 'workspace' | 'paywall' | 'sandbox lock' | 'not found'

/** One request to one address: what the route shows, or where it sends the request. */
async function request(address: string): Promise<{ shown: Shown } | { to: string }> {
  const url = new URL(address, 'https://app.example')
  try {
    if (url.pathname === NEW_PAGE) {
      const page = await InkorgRoute()
      expect(page.type).toBe(InkorgPage)
      return { shown: 'new inbox' }
    }
    const [, , sector, slug] = url.pathname.split('/')
    const query: Record<string, string | string[]> = {}
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key)
      query[key] = values.length > 1 ? values : values[0]
    }
    const page = await ExtensionWorkspacePage({ params: Promise.resolve({ sector, slug }), searchParams: Promise.resolve(query) })
    if (page.type === ExtensionWorkspaceLoader) return { shown: 'workspace' }
    if (page.type === ExtensionUpsellState) return { shown: 'paywall' }
    expect(page.type).toBe(ExtensionSandboxLockState)
    return { shown: 'sandbox lock' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'NEXT_NOT_FOUND') return { shown: 'not found' }
    if (message.startsWith('NEXT_REDIRECT:')) return { to: message.slice('NEXT_REDIRECT:'.length) }
    throw err
  }
}

/** A request followed through its redirects: every address it passed and what the last one showed. */
async function follow(start: string): Promise<{ trail: string[]; shown: Shown }> {
  const trail = [start]
  for (let hop = 0; hop < 6; hop += 1) {
    const answer = await request(trail[trail.length - 1])
    if ('shown' in answer) return { trail, shown: answer.shown }
    trail.push(answer.to)
  }
  throw new Error(`The request never arrived: ${trail.join(' -> ')}`)
}

const BOTH = [true, false] as const
const EVERY_CASE = BOTH.flatMap((inRollout) =>
  BOTH.flatMap((extensionExists) => BOTH.flatMap((sandbox) => BOTH.map((capability) => ({ inRollout, extensionExists, sandbox, capability })))),
)
type Case = (typeof EVERY_CASE)[number]

function arrange({ inRollout, extensionExists, sandbox, capability }: Case) {
  vi.stubEnv('INKORG_V2_COMPANY_IDS', inRollout ? 'company-1' : 'company-2')
  state.extensionExists = extensionExists
  state.sandbox = sandbox
  state.capability = capability
}

/** What a company in this case sees as its inbox, by the rule as it stood before the two routes shared it. */
function inboxOf({ inRollout, extensionExists, sandbox, capability }: Case): { address: string; shown: Shown } {
  if (!extensionExists) return { address: inRollout ? 'either' : WORKSPACE, shown: 'not found' }
  if (sandbox) return { address: WORKSPACE, shown: 'sandbox lock' }
  if (!capability) return { address: WORKSPACE, shown: 'paywall' }
  return inRollout ? { address: NEW_PAGE, shown: 'new inbox' } : { address: WORKSPACE, shown: 'workspace' }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'user-1' }
  state.companyId = 'company-1'
  state.extensionExists = true
  state.sandbox = false
  state.capability = true
  reads.settings.mockImplementation(async () => ({ data: { is_sandbox: state.sandbox, entity_type: 'aktiebolag', accounting_method: 'accrual' }, error: null }))
  reads.hasCapability.mockImplementation(async () => state.capability)
  reads.loadCompanyCapabilities.mockResolvedValue(null)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the two inbox addresses lead to the company\'s one inbox', () => {
  it('walks all sixteen cases of the rule', () => {
    expect(EVERY_CASE).toHaveLength(16)
  })

  describe.each(EVERY_CASE)('rollout $inRollout, extension $extensionExists, sandbox $sandbox, capability $capability', (facts) => {
    it.each([NEW_PAGE, WORKSPACE])('a request for %s arrives after at most one redirect, at the company\'s inbox', async (start) => {
      arrange(facts)
      const { trail, shown } = await follow(start)
      const inbox = inboxOf(facts)
      expect(trail.length, trail.join(' -> ')).toBeLessThanOrEqual(2)
      expect(shown).toBe(inbox.shown)
      // Without the extension neither page exists: in the rollout each address says so itself.
      expect(trail[trail.length - 1]).toBe(inbox.address === 'either' ? start : inbox.address)
      // An address never appears twice: nothing was sent back where it came from.
      expect(new Set(trail).size).toBe(trail.length)
    })

    it('the two addresses never redirect to each other', async () => {
      arrange(facts)
      const fromNewPage = await request(NEW_PAGE)
      const fromWorkspace = await request(WORKSPACE)
      expect('to' in fromNewPage && 'to' in fromWorkspace).toBe(false)
    })
  })
})

describe('/e/general/invoice-inbox for a company whose inbox is the new page', () => {
  beforeEach(() => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', 'company-1')
  })

  it('redirects to /inkorg', async () => {
    expect(await request(WORKSPACE)).toEqual({ to: '/inkorg' })
  })

  it('carries the document to open, the view and the way back, and drops every other parameter', async () => {
    expect(await request(`${WORKSPACE}?fokus=item-1`)).toEqual({ to: '/inkorg?fokus=item-1' })
    expect(await request(`${WORKSPACE}?utm_source=mail&view=missing&item=item-9`)).toEqual({ to: '/inkorg?view=missing' })
    const sent = await request(`${WORKSPACE}?tillbaka=%2Fatt-bokfora%3Ffilter%3Datt-matcha&fokus=item-1&fokus=item-2&ref=x`)
    expect(sent).toEqual({ to: '/inkorg?fokus=item-1&tillbaka=%2Fatt-bokfora%3Ffilter%3Datt-matcha' })
    // The address it is sent to opens the new page, with nothing left to redirect.
    expect(await follow(`${WORKSPACE}?fokus=item-1`)).toEqual({ trail: [`${WORKSPACE}?fokus=item-1`, '/inkorg?fokus=item-1'], shown: 'new inbox' })
  })

  it('still sends a signed-out visitor to the login page first', async () => {
    state.user = null
    expect(await request(WORKSPACE)).toEqual({ to: '/login' })
    expect(await request(NEW_PAGE)).toEqual({ to: '/login' })
    expect(reads.hasCapability).not.toHaveBeenCalled()
  })

  it('leaves another extension\'s workspace where it is, and asks nothing about the inbox for it', async () => {
    expect(await request('/e/general/arcim-migration?fokus=item-1')).toEqual({ shown: 'workspace' })
    expect(reads.hasCapability).not.toHaveBeenCalled()
    expect(reads.settings).not.toHaveBeenCalled()
  })
})

describe('a company whose inbox is the workspace: both routes as before', () => {
  beforeEach(() => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', 'company-2')
  })

  it('/inkorg redirects to the workspace without reading anything', async () => {
    expect(await request(NEW_PAGE)).toEqual({ to: WORKSPACE })
    expect(reads.settings).not.toHaveBeenCalled()
    expect(reads.hasCapability).not.toHaveBeenCalled()
    expect(reads.loadCompanyCapabilities).not.toHaveBeenCalled()
  })

  it('the workspace opens with the one capability read it always made, whatever its address carries', async () => {
    expect(await request(`${WORKSPACE}?fokus=item-1`)).toEqual({ shown: 'workspace' })
    expect(reads.hasCapability).toHaveBeenCalledTimes(1)
  })

  it('no company is no rollout: /inkorg redirects and the workspace shows its paywall', async () => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', '*')
    state.companyId = null
    expect(await request(NEW_PAGE)).toEqual({ to: WORKSPACE })
    expect(await request(WORKSPACE)).toEqual({ shown: 'paywall' })
    expect(reads.hasCapability).not.toHaveBeenCalled()
  })

  it('a company in the rollout that the new page sends back stays on the workspace', async () => {
    vi.stubEnv('INKORG_V2_COMPANY_IDS', 'company-1')
    state.sandbox = true
    expect(await follow(NEW_PAGE)).toEqual({ trail: [NEW_PAGE, WORKSPACE], shown: 'sandbox lock' })
    expect(await follow(WORKSPACE)).toEqual({ trail: [WORKSPACE], shown: 'sandbox lock' })
    state.sandbox = false
    state.capability = false
    expect(await follow(NEW_PAGE)).toEqual({ trail: [NEW_PAGE, WORKSPACE], shown: 'paywall' })
    expect(await follow(WORKSPACE)).toEqual({ trail: [WORKSPACE], shown: 'paywall' })
  })
})
