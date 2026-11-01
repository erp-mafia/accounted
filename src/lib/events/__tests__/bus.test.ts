import { describe, it, expect, beforeEach, vi } from 'vitest'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

import { eventBus } from '../bus'
import type { JournalEntry } from '@/types'

const fakeEntry = { id: 'e1' } as JournalEntry

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('EventBus', () => {
  it('on() subscribes a handler and returns an unsubscribe function', () => {
    const handler = vi.fn()
    const unsub = eventBus.on('journal_entry.drafted', handler)

    expect(typeof unsub).toBe('function')
  })

  it('emit() calls all handlers for that event type', async () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    eventBus.on('journal_entry.committed', handler1)
    eventBus.on('journal_entry.committed', handler2)

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler1).toHaveBeenCalledWith({ entry: fakeEntry, userId: 'u1', companyId: 'company-1' })
    expect(handler2).toHaveBeenCalledWith({ entry: fakeEntry, userId: 'u1', companyId: 'company-1' })
  })

  it('emit() uses Promise.allSettled: a failing handler does not crash others', async () => {
    const failingHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const goodHandler = vi.fn()

    eventBus.on('journal_entry.committed', failingHandler)
    eventBus.on('journal_entry.committed', goodHandler)

    // Should not throw
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })

    expect(failingHandler).toHaveBeenCalled()
    expect(goodHandler).toHaveBeenCalled()
  })

  it('a failing handler is logged as an error with the event type and the handler name', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    Object.defineProperty(failing, 'name', { value: 'attest-notify' })
    eventBus.on('journal_entry.committed', failing)

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })

    expect(logMock.error).toHaveBeenCalledWith('handler failed', expect.any(Error), expect.objectContaining({
      eventType: 'journal_entry.committed',
      handler: 'attest-notify',
      companyId: 'company-1',
    }))
  })

  it('a handler that throws synchronously neither reaches the emitter nor skips the handlers after it', async () => {
    const throwing = vi.fn(() => {
      throw new Error('sync boom')
    })
    Object.defineProperty(throwing, 'name', { value: 'sync-consumer' })
    const after = vi.fn()
    eventBus.on('journal_entry.committed', throwing)
    eventBus.on('journal_entry.committed', after)

    await expect(eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })).resolves.toBeUndefined()

    expect(after).toHaveBeenCalledOnce()
    expect(logMock.error).toHaveBeenCalledWith('handler failed', expect.any(Error), expect.objectContaining({
      eventType: 'journal_entry.committed',
      handler: 'sync-consumer',
    }))
  })

  it('emit() with no handlers is a no-op', async () => {
    // Should not throw
    await eventBus.emit({
      type: 'journal_entry.drafted',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })
  })

  it('unsubscribe removes the handler, future emits do not call it', async () => {
    const handler = vi.fn()
    const unsub = eventBus.on('journal_entry.committed', handler)

    unsub()

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('clear() removes all handlers', async () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    eventBus.on('journal_entry.committed', handler1)
    eventBus.on('journal_entry.drafted', handler2)

    eventBus.clear()

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })
    await eventBus.emit({
      type: 'journal_entry.drafted',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })

    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).not.toHaveBeenCalled()
  })

  it('handlers for different event types do not interfere', async () => {
    const committedHandler = vi.fn()
    const draftedHandler = vi.fn()

    eventBus.on('journal_entry.committed', committedHandler)
    eventBus.on('journal_entry.drafted', draftedHandler)

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: fakeEntry, userId: 'u1', companyId: 'company-1' },
    })

    expect(committedHandler).toHaveBeenCalledOnce()
    expect(draftedHandler).not.toHaveBeenCalled()
  })
})
