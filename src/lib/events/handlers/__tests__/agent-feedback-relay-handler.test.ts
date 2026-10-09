import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getUserById = vi.fn()
const maybeSingle = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({
    auth: { admin: { getUserById } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  })),
}))
const sendEmail = vi.fn()
const isConfigured = vi.fn()
vi.mock('@/lib/email/service', () => ({ getEmailService: () => ({ sendEmail, isConfigured }) }))
vi.mock('@/lib/branding/service', () => ({ getBranding: () => ({ appName: 'Accounted' }) }))

import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { composeAgentFeedbackMail, registerAgentFeedbackRelayHandler } from '../agent-feedback-relay-handler'

const feedback = (over: Partial<EventPayload<'agent.feedback'>> = {}): EventPayload<'agent.feedback'> => ({
  context: 'Preview showed the wrong account.',
  sentiment: 'negative',
  suggestion: 'Show the lines before approval.',
  toolName: 'gnubok_mark_invoice_as_paid',
  skillSlug: null,
  sessionId: 'sess-1',
  actorType: 'api_key',
  actorId: 'key-1',
  actorLabel: 'Claude (Anthropic)',
  userId: '11111111-1111-4111-8111-111111111111',
  companyId: 'co-1',
  ...over,
})

const emit = (payload: EventPayload<'agent.feedback'>) => eventBus.emit({ type: 'agent.feedback', payload })

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.stubEnv('AGENT_FEEDBACK_RELAY', 'true')
  vi.stubEnv('SUPPORT_RECIPIENT_EMAIL', 'support@example.test')
  isConfigured.mockReturnValue(true)
  sendEmail.mockResolvedValue({ success: true })
  getUserById.mockResolvedValue({ data: { user: { email: 'owner@example.test' } } })
  maybeSingle.mockResolvedValue({ data: { name: 'Exempel AB' } })
  registerAgentFeedbackRelayHandler()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agent feedback relay', () => {
  it('relays an agent report to the desk in the support form format, replying to the key owner', async () => {
    await emit(feedback())
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const mail = sendEmail.mock.calls[0][0]
    expect(mail.to).toBe('support@example.test')
    expect(mail.replyTo).toBe('owner@example.test')
    expect(mail.subject).toBe('[accounted support] Din AI-agents rapport till Accounted (Exempel AB)')
    expect(mail.text).toMatch(/^Från: owner@example\.test\nUser ID: 11111111-1111-4111-8111-111111111111\nÄmne: Din AI-agents rapport till Accounted \(Exempel AB\)\nKälla: agent-feedback\n\n/)
    expect(mail.text).toMatch(/Källa: agent-feedback\n\nSkickat .* av kundens AI-agent \(Claude \(Anthropic\)\) via feedbackverktyget, inte skrivet av personen själv\./)
    expect(mail.text).toContain('Preview showed the wrong account.')
    expect(mail.text).toContain('Förslag:\nShow the lines before approval.')
    expect(mail.text).toContain('Klient: Claude (Anthropic) (api_key)')
  })

  it('sends nothing unless the relay is switched on (self-hosted, previews)', async () => {
    vi.stubEnv('AGENT_FEEDBACK_RELAY', '')
    await emit(feedback())
    vi.stubEnv('AGENT_FEEDBACK_RELAY', 'false')
    await emit(feedback())
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('needs an explicit support address: the branding default would mail a self-hoster\'s reports to Accounted', async () => {
    vi.stubEnv('SUPPORT_RECIPIENT_EMAIL', '')
    await emit(feedback())
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('relays praise only when it carries a suggestion', async () => {
    await emit(feedback({ sentiment: 'positive', suggestion: null }))
    expect(sendEmail).not.toHaveBeenCalled()
    await emit(feedback({ sentiment: 'positive', suggestion: 'Also show the VAT lines.' }))
    await emit(feedback({ sentiment: 'neutral', suggestion: null }))
    expect(sendEmail).toHaveBeenCalledTimes(2)
  })

  it('leaves the chat thumbs-up/down as telemetry', async () => {
    await emit(feedback({ actorType: 'user', toolName: null, suggestion: null }))
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing when email is not configured or the reporter has no address', async () => {
    isConfigured.mockReturnValue(false)
    await emit(feedback())
    isConfigured.mockReturnValue(true)
    getUserById.mockResolvedValue({ data: { user: { email: null } } })
    await emit(feedback())
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('never fails the feedback call when the lookup or the send fails', async () => {
    getUserById.mockRejectedValue(new Error('auth unavailable'))
    await expect(emit(feedback())).resolves.toBeUndefined()
    getUserById.mockResolvedValue({ data: { user: { email: 'owner@example.test' } } })
    sendEmail.mockResolvedValue({ success: false, error: 'rate limited' })
    await expect(emit(feedback())).resolves.toBeUndefined()
  })
})

describe('composeAgentFeedbackMail', () => {
  it('falls back to the company id, keeps the skill in the body, and escapes the html copy', () => {
    const mail = composeAgentFeedbackMail(
      feedback({ toolName: null, skillSlug: 'payroll-monthly', suggestion: null, context: 'a <b> tag' }),
      { email: 'owner@example.test', companyName: null },
    )
    expect(mail.subject).toBe('Din AI-agents rapport till Accounted (co-1)')
    expect(mail.text).toContain('Skill: payroll-monthly')
    expect(mail.text).not.toContain('Förslag:')
    expect(mail.html).toContain('a &lt;b&gt; tag')
  })
})
