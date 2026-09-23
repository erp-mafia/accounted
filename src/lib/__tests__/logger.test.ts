import { describe, it, expect } from 'vitest'
import { createTestLogger } from '../logger'

// The sink element type is the (unexported) LogRecord from lib/logger.ts,
// recovered via Parameters<> so the test stays in sync with the real signature.
type Sink = Parameters<typeof createTestLogger>[1]

describe('logger', () => {
  it('emits records with module + msg + level + ts', () => {
    const sink: Sink = []
    const log = createTestLogger('test/module', sink)
    log.info('hello')

    expect(sink).toHaveLength(1)
    expect(sink[0]).toMatchObject({
      level: 'info',
      module: 'test/module',
      msg: 'hello',
    })
    expect(typeof sink[0].ts).toBe('string')
  })

  it('merges base context into every record', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink, { requestId: 'req_1' })
    log.info('hi')
    expect(sink[0].requestId).toBe('req_1')
  })

  it('child() returns a logger that merges extra context', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink, { requestId: 'req_1' })
    const child = log.child({ companyId: 'co_1', userId: 'u_1' })
    child.warn('oops')
    expect(sink[0]).toMatchObject({
      requestId: 'req_1',
      companyId: 'co_1',
      userId: 'u_1',
    })
  })

  it('treats Error args as the err field with name/message/code', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink)
    const err = new Error('boom')
    ;(err as Error & { code?: string }).code = '23505'
    log.error('insert failed', err)

    expect(sink[0].err).toMatchObject({ name: 'Error', message: 'boom', code: '23505' })
  })

  it('merges plain-object args into context', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink)
    log.info('done', { durationMs: 42, status: 200 })
    expect(sink[0]).toMatchObject({ durationMs: 42, status: 200 })
  })

  it('redacts sensitive keys recursively', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink)
    log.info('login', {
      user: 'alice',
      headers: { authorization: 'Bearer secret', cookie: 'sess=xxx' },
      payload: { password: 'hunter2', token: 'tok' },
    })
    const rec = sink[0] as {
      user: string
      headers: { authorization: string; cookie: string }
      payload: { password: string; token: string }
    }
    expect(rec.headers.authorization).toBe('[REDACTED]')
    expect(rec.headers.cookie).toBe('[REDACTED]')
    expect(rec.payload.password).toBe('[REDACTED]')
    expect(rec.payload.token).toBe('[REDACTED]')
    expect(rec.user).toBe('alice')
  })

  it('redacts personnummer-shaped strings while preserving UUIDs', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink)
    log.info('processing for 800101-1234', { uuid: '57484518-3409-4b29-9d23-5d22f08bda63' })
    expect(sink[0].msg).toBe('[REDACTED]')
    expect(sink[0].uuid).toBe('57484518-3409-4b29-9d23-5d22f08bda63')
  })

  it('routes non-object, non-Error args into details', () => {
    const sink: Sink = []
    const log = createTestLogger('m', sink)
    log.warn('legacy', 'string arg', 42)
    expect(sink[0].details).toEqual(['string arg', 42])
  })
})
