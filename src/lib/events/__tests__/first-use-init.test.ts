/**
 * The first event emitted, or the first read of a registry lib/init fills,
 * waits for the registered loader of lib/init (lib/initialized.ts;
 * instrumentation.ts registers it in the app). These pin the contract: one
 * load however many callers race for it, a failed load retried by the next
 * caller, the handlers it wires receiving the very first event, and emit()
 * resolving only after they ran.
 *
 * Each test loads fresh copies of the bus, the registries and
 * lib/initialized.ts (vi.resetModules, plus resetGlobalSingletons for the
 * state they keep on globalThis) and registers the loader instrumentation.ts
 * registers, so every test starts uninitialised; lib/init itself is the
 * hoisted mock below, whose implementation each test sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FiscalPeriod } from '@/types'
import type { Extension } from '@/lib/extensions/types'
import { resetGlobalSingletons } from '@/lib/global-singleton'

const init = vi.hoisted(() => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/init', () => init)

const period = { id: 'period-1' } as FiscalPeriod
const lockedEvent = {
  type: 'period.locked' as const,
  payload: { period, userId: 'user-1', companyId: 'company-1' },
}

async function freshProcess() {
  vi.resetModules()
  resetGlobalSingletons()
  const { registerInitLoader } = await import('@/lib/initialized')
  registerInitLoader(() => import('@/lib/init').then((m) => m.ensureInitialized()))
}

async function fresh() {
  await freshProcess()
  const { eventBus } = await import('@/lib/events/bus')
  const { extensionRegistry } = await import('@/lib/extensions/registry')
  return { eventBus, extensionRegistry }
}

function fakeExtension(id: string, handler: (payload: unknown) => unknown): Extension {
  return {
    id,
    name: id,
    version: '1.0.0',
    eventHandlers: [{ eventType: 'period.locked', handler }],
  } as unknown as Extension
}

beforeEach(() => {
  init.ensureInitialized.mockReset()
})

describe('eventBus.emit on first use', () => {
  it('initialises once when several first events race', async () => {
    const { eventBus } = await fresh()

    await Promise.all([eventBus.emit(lockedEvent), eventBus.emit(lockedEvent), eventBus.emit(lockedEvent)])
    await eventBus.emit(lockedEvent)

    expect(init.ensureInitialized).toHaveBeenCalledTimes(1)
  })

  it('delivers the first event to the handlers that init registers, extensions included', async () => {
    const { eventBus, extensionRegistry } = await fresh()
    const coreHandler = vi.fn()
    const extensionHandler = vi.fn()
    init.ensureInitialized.mockImplementation(() => {
      eventBus.on('period.locked', coreHandler)
      extensionRegistry.register(fakeExtension('fake-ext', extensionHandler))
    })

    await eventBus.emit(lockedEvent)

    expect(coreHandler).toHaveBeenCalledWith(lockedEvent.payload)
    // The registry wraps extension handlers to add a context; with no context
    // factory wired the context is undefined.
    expect(extensionHandler).toHaveBeenCalledWith(lockedEvent.payload, undefined)
  })

  it('resolves only after init and every handler have finished', async () => {
    const { eventBus } = await fresh()
    let finishHandler!: () => void
    let handlerDone = false
    init.ensureInitialized.mockImplementation(() => {
      eventBus.on('period.locked', () =>
        new Promise<void>((resolve) => {
          finishHandler = () => {
            handlerDone = true
            resolve()
          }
        }),
      )
    })

    let emitted = false
    const emitting = eventBus.emit(lockedEvent).then(() => {
      emitted = true
    })
    await vi.waitFor(() => expect(finishHandler).toBeTypeOf('function'))
    expect(emitted).toBe(false)

    finishHandler()
    await emitting
    expect(handlerDone).toBe(true)
  })

  it('retries a failed init on the next event and never throws at the emitter', async () => {
    const { eventBus } = await fresh()
    const handler = vi.fn()
    init.ensureInitialized
      .mockImplementationOnce(() => {
        throw new Error('missing env')
      })
      .mockImplementation(() => {
        eventBus.on('period.locked', handler)
      })

    await expect(eventBus.emit(lockedEvent)).resolves.toBeUndefined()
    expect(handler).not.toHaveBeenCalled()

    await eventBus.emit(lockedEvent)
    expect(init.ensureInitialized).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('registry reads on first use', () => {
  it('the extension registry initialises before answering, with no event emitted', async () => {
    const { extensionRegistry } = await fresh()
    init.ensureInitialized.mockImplementation(() => {
      extensionRegistry.register(fakeExtension('skatteverket', vi.fn()))
    })

    expect((await extensionRegistry.get('skatteverket'))?.id).toBe('skatteverket')
    expect((await extensionRegistry.getAll()).map((e) => e.id)).toEqual(['skatteverket'])
    expect(init.ensureInitialized).toHaveBeenCalledTimes(1)
  })

  it('the service getters initialise before answering', async () => {
    await freshProcess()
    const email = await import('@/lib/email/service')
    const mail = await import('@/lib/mail-search/service')
    const peppol = await import('@/lib/invoices/peppol-transport')
    const payments = await import('@/lib/payments/initiation/provider')
    const { agentToolRegistry, registerAgentToolLoader } = await import('@/lib/agent/tools/registry')
    const emailService = { sendEmail: vi.fn(), isConfigured: () => true }
    const mailService = { search: vi.fn(), fetchAttachment: vi.fn(), isConfigured: () => true }
    const transport = { provider: 'connector' } as unknown as import('@/lib/invoices/peppol-transport').PeppolTransport
    const provider = { id: 'open_payments', isAvailableFor: () => true } as unknown as import('@/lib/payments/initiation/provider').PaymentInitiationProvider
    const tool = { name: 'accounted_list_accounts' } as unknown as import('@/lib/agent/tools/types').AgentTool
    init.ensureInitialized.mockImplementation(() => {
      email.registerEmailService(emailService)
      mail.registerMailSearchService(mailService)
      peppol.registerPeppolTransport(transport)
      payments.registerPaymentInitiationProvider(provider)
      registerAgentToolLoader(async () => [tool])
    })

    expect(await email.getEmailService()).toBe(emailService)
    expect(await mail.getMailSearchService()).toBe(mailService)
    expect(await peppol.getPeppolTransport('connector')).toBe(transport)
    expect(await payments.getPaymentInitiationProvider('company-1')).toBe(provider)
    expect(await agentToolRegistry.get('accounted_list_accounts')).toBe(tool)
    expect(init.ensureInitialized).toHaveBeenCalledTimes(1)
  })

  it('a failed init is retried by the next read', async () => {
    const { extensionRegistry } = await fresh()
    init.ensureInitialized
      .mockImplementationOnce(() => {
        throw new Error('missing env')
      })
      .mockImplementation(() => {
        extensionRegistry.register(fakeExtension('skatteverket', vi.fn()))
      })

    await expect(extensionRegistry.get('skatteverket')).rejects.toThrow('missing env')
    expect((await extensionRegistry.get('skatteverket'))?.id).toBe('skatteverket')
    expect(init.ensureInitialized).toHaveBeenCalledTimes(2)
  })
})
