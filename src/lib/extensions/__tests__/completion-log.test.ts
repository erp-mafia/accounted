import { describe, it, expect } from 'vitest'
import { noteCompletionLog, readCompletionLog, shouldWriteCompletionLog } from '../completion-log'

describe('completion-log notes', () => {
  it('is empty for a request nobody noted', () => {
    expect(readCompletionLog(new Request('https://x.test/a'))).toBeUndefined()
  })

  it('merges fields across notes and keeps quiet once set', () => {
    const request = new Request('https://x.test/a')
    noteCompletionLog(request, { fields: { mcpMethod: 'tools/list', tool: null } })
    noteCompletionLog(request, { fields: { apiKeyId: 'k1' }, quiet: true })
    noteCompletionLog(request, { fields: { tool: 't' } })
    expect(readCompletionLog(request)).toEqual({
      fields: { mcpMethod: 'tools/list', tool: 't', apiKeyId: 'k1' },
      quiet: true,
    })
  })

  it('keeps notes per request object', () => {
    const a = new Request('https://x.test/a')
    const b = new Request('https://x.test/a')
    noteCompletionLog(a, { quiet: true })
    expect(readCompletionLog(b)).toBeUndefined()
  })
})

describe('shouldWriteCompletionLog', () => {
  it('writes every call nobody marked quiet, whatever the status', () => {
    expect(shouldWriteCompletionLog(undefined, 200)).toBe(true)
    expect(shouldWriteCompletionLog({ fields: { tool: 't' } }, 401)).toBe(true)
  })

  it('drops a quiet call unless it failed with a 5xx', () => {
    expect(shouldWriteCompletionLog({ quiet: true }, 202)).toBe(false)
    expect(shouldWriteCompletionLog({ quiet: true }, 405)).toBe(false)
    expect(shouldWriteCompletionLog({ quiet: true }, 500)).toBe(true)
    expect(shouldWriteCompletionLog({ quiet: false }, 200)).toBe(true)
  })
})
