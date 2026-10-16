/**
 * Process-wide state survives a second copy of the module that holds it.
 *
 * A production server holds more than one copy of a module (one per
 * Turbopack layer), and lib/init now loads from instrumentation.ts, an entry
 * of its own. So the copy of the event bus, the registries and the
 * AsyncLocalStorage scopes that lib/init and extension code use is not the
 * copy a route uses. vi.resetModules() makes the second copy here: whatever
 * is imported before it plays the instrumentation graph, whatever after it
 * the route's graph. Every test starts from a fresh process
 * (resetGlobalSingletons).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FiscalPeriod } from '@/types'
import type { Extension } from '@/lib/extensions/types'
import { globalSingleton, resetGlobalSingletons } from '@/lib/global-singleton'

const lockedEvent = {
  type: 'period.locked' as const,
  payload: { period: { id: 'period-1' } as FiscalPeriod, userId: 'user-1', companyId: 'company-1' },
}

beforeEach(() => {
  vi.resetModules()
  resetGlobalSingletons()
})

/** What lib/init's graph holds: its own copies of the bus, the registries and the loader. */
async function instrumentationGraph() {
  const initialized = await import('@/lib/initialized')
  const { eventBus } = await import('@/lib/events/bus')
  const registry = await import('@/lib/extensions/registry')
  return { initialized, eventBus, registry }
}

/** A second copy of every module, as a route's graph holds it. */
async function routeGraph() {
  vi.resetModules()
  const { eventBus } = await import('@/lib/events/bus')
  const { extensionRegistry } = await import('@/lib/extensions/registry')
  return { eventBus, extensionRegistry }
}

describe('globalSingleton', () => {
  it('creates the value once and hands every later caller the same one', () => {
    const create = vi.fn(() => ({ n: 1 }))
    const first = globalSingleton('test-value', create)
    const second = globalSingleton('test-value', () => ({ n: 2 }))

    expect(second).toBe(first)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('keeps the value on globalThis under a namespaced key', () => {
    const value = globalSingleton('test-value', () => ({}))
    expect((globalThis as Record<string, unknown>)['__accounted_test-value']).toBe(value)
  })

  it('resetGlobalSingletons forgets only the namespaced values', () => {
    const store = globalThis as Record<string, unknown>
    store.unrelatedGlobal = 'kept'
    const before = globalSingleton('test-value', () => ({}))
    resetGlobalSingletons()

    expect(globalSingleton('test-value', () => ({}))).not.toBe(before)
    expect(store.unrelatedGlobal).toBe('kept')
    delete store.unrelatedGlobal
  })
})

describe('the event bus and the registries across module copies', () => {
  it('an extension handler that init registers in its graph receives the event a route emits through its own copy', async () => {
    const init = await instrumentationGraph()
    const extensionHandler = vi.fn()
    const coreHandler = vi.fn()
    init.initialized.registerInitLoader(async () => {
      init.eventBus.on('period.locked', coreHandler)
      init.registry.extensionRegistry.register({
        id: 'fake-ext',
        name: 'fake-ext',
        version: '1.0.0',
        eventHandlers: [{ eventType: 'period.locked', handler: extensionHandler }],
      } as unknown as Extension)
    })

    const route = await routeGraph()
    expect(route.eventBus).toBe(init.eventBus)
    await route.eventBus.emit(lockedEvent)

    expect(coreHandler).toHaveBeenCalledWith(lockedEvent.payload)
    expect(extensionHandler).toHaveBeenCalledTimes(1)
    expect((await route.extensionRegistry.get('fake-ext'))?.id).toBe('fake-ext')
  })

  it('the context factory init sets is the one every copy of the registry builds handler contexts with', async () => {
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ supabase: true }) }))
    const init = await instrumentationGraph()
    const route = await routeGraph()
    const extensionHandler = vi.fn()
    // The registry is created by the route's copy here, the factory set
    // through init's copy afterwards: the handler wrapper must still see it.
    route.extensionRegistry.register({
      id: 'fake-ext',
      name: 'fake-ext',
      version: '1.0.0',
      eventHandlers: [{ eventType: 'period.locked', handler: extensionHandler }],
    } as unknown as Extension)
    init.registry.setContextFactory(() => ({ marker: 'ctx' }) as never)

    await route.eventBus.emit(lockedEvent)

    expect(extensionHandler).toHaveBeenCalledWith(lockedEvent.payload, { marker: 'ctx' })
    vi.doUnmock('@/lib/supabase/server')
  })

  it('the services and providers init registers are the ones a route reads', async () => {
    const email = await import('@/lib/email/service')
    const mail = await import('@/lib/mail-search/service')
    const peppol = await import('@/lib/invoices/peppol-transport')
    const payments = await import('@/lib/payments/initiation/provider')
    const tools = await import('@/lib/agent/tools/registry')
    const emailService = { sendEmail: vi.fn(), isConfigured: () => true }
    const mailService = { search: vi.fn(), fetchAttachment: vi.fn(), isConfigured: () => true }
    const transport = { provider: 'connector' } as unknown as import('@/lib/invoices/peppol-transport').PeppolTransport
    const provider = { id: 'open_payments', isAvailableFor: () => true } as unknown as import('@/lib/payments/initiation/provider').PaymentInitiationProvider
    const tool = { name: 'accounted_list_accounts' } as unknown as import('@/lib/agent/tools/types').AgentTool
    email.registerEmailService(emailService)
    mail.registerMailSearchService(mailService)
    peppol.registerPeppolTransport(transport)
    payments.registerPaymentInitiationProvider(provider)
    tools.registerAgentToolLoader(async () => [tool])

    vi.resetModules()
    const routeEmail = await import('@/lib/email/service')
    const routeMail = await import('@/lib/mail-search/service')
    const routePeppol = await import('@/lib/invoices/peppol-transport')
    const routePayments = await import('@/lib/payments/initiation/provider')
    const routeTools = await import('@/lib/agent/tools/registry')
    expect(routeEmail).not.toBe(email)

    expect(await routeEmail.getEmailService()).toBe(emailService)
    expect(await routeMail.getMailSearchService()).toBe(mailService)
    expect(await routePeppol.getPeppolTransport('connector')).toBe(transport)
    expect(await routePayments.getPaymentInitiationProvider('company-1')).toBe(provider)
    expect(await routeTools.agentToolRegistry.get('accounted_list_accounts')).toBe(tool)
  })

  it('eventBus.clear() empties the one handler table every copy shares', async () => {
    const init = await instrumentationGraph()
    const handler = vi.fn()
    init.eventBus.on('period.locked', handler)
    const route = await routeGraph()

    route.eventBus.clear()
    await init.eventBus.emit(lockedEvent)

    expect(handler).not.toHaveBeenCalled()
  })
})

describe('request scopes across module copies', () => {
  it('the actor a route opens is the actor extension code commits with, even where its graph never bound the storage', async () => {
    const { runWithActor } = await import('@/lib/bookkeeping/actor-context-node')
    vi.resetModules()
    // Extension code's copy: imports actor-context only, never the node half.
    const { getActor } = await import('@/lib/bookkeeping/actor-context')

    const seen = await runWithActor({ type: 'user' }, async () => getActor())

    expect(seen).toEqual({ type: 'user' })
    expect(getActor()).toBeUndefined()
  })

  it('the AI meter, the execution budget, the staging batch and the committing operation reach every copy', async () => {
    const meterA = await import('@/lib/ai/meter')
    const budgetA = await import('@/lib/http/execution-budget')
    const batchA = await import('@/lib/pending-operations/batch-context')
    const commitA = await import('@/lib/pending-operations/commit-scope')
    vi.resetModules()
    const meterB = await import('@/lib/ai/meter')
    const budgetB = await import('@/lib/http/execution-budget')
    const batchB = await import('@/lib/pending-operations/batch-context')
    const commitB = await import('@/lib/pending-operations/commit-scope')

    const seen = await meterA.withAiMeter({ feature: 'document_read', companyId: 'company-1' }, () =>
      budgetA.withExecutionDeadline(Date.now() + 60_000, 'sync', () =>
        batchA.runWithStagingBatch('batch-1', () =>
          commitA.runInOperationCommit('op-1', async () => ({
            meter: meterB.currentAiMeter(),
            budget: budgetB.currentExecutionBudget()?.stage,
            batch: batchB.currentStagingBatchId(),
            operation: commitB.committingOperationId(),
          })),
        ),
      ),
    )

    expect(seen).toEqual({
      meter: { feature: 'document_read', companyId: 'company-1' },
      budget: 'sync',
      batch: 'batch-1',
      operation: 'op-1',
    })
  })
})
