import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { tools } from '../server'

/**
 * crm#1336: a relayed report becomes a support ticket whose reply is mailed
 * to the user the connection acts as. The result must tell the agent to let
 * that person know, so our reply is not a surprise.
 */
const feedback = tools.find((t) => t.name === 'gnubok_feedback')!
let actor = 0
const call = (args: Record<string, unknown>) =>
  feedback.execute(args, 'company-a', 'user-a', {} as never, { type: 'api_key', id: `key-result-${++actor}` } as never) as Promise<{
    recorded: boolean
    message: string
  }>

describe('gnubok_feedback result: tell the user when the report goes to the team', () => {
  beforeEach(() => {
    eventBus.clear()
    vi.stubEnv('AGENT_FEEDBACK_RELAY', 'true')
    vi.stubEnv('SUPPORT_RECIPIENT_EMAIL', 'support@example.test')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('asks the agent to tell the user, and says where a reply goes, when the report is relayed', async () => {
    const result = await call({ context: 'A tool returned an empty list for a period that has sales.' })
    expect(result.recorded).toBe(true)
    expect(result.message).toContain('Tell the user')
    expect(result.message).toContain('e-mail to the address of the Accounted user this connection belongs to')
  })

  it('also for praise that carries a suggestion (it is relayed too)', async () => {
    const result = await call({ context: 'Worked well.', sentiment: 'positive', suggestion: 'Add a dry run to X.' })
    expect(result.message).toContain('Tell the user')
  })

  it('keeps the triage message for bare praise, which is never relayed', async () => {
    const result = await call({ context: 'Worked well.', sentiment: 'positive' })
    expect(result.message).not.toContain('Tell the user')
    expect(result.message).toContain('product-team triage')
  })

  it('keeps the triage message when the relay is off (self-hosted)', async () => {
    vi.stubEnv('AGENT_FEEDBACK_RELAY', '')
    const result = await call({ context: 'A tool description misled me.' })
    expect(result.message).not.toContain('Tell the user')
    expect(result.message).toContain('product-team triage')
  })
})
