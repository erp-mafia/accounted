import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { registerEmailService, type EmailService } from '@/lib/email/service'
import { notifyPublishedAuthors, notifyReviewersOfSubmission } from '../community-notify'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const sendEmail = vi.fn()
const configured = vi.fn(() => true)
registerEmailService({ sendEmail, isConfigured: configured } as unknown as EmailService)

const getUserById = vi.fn()
const service = Object.assign(supabase, { auth: { admin: { getUserById } } })

const published = { id: 'sub-1', name: 'Bokför SaaS', author_handle: 'anna', created_by: 'user-1', published_atom_id: 'community/bokfor-saas' }
const page = (status: number) => vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch

beforeEach(() => {
  vi.clearAllMocks(); reset()
  configured.mockReturnValue(true)
  sendEmail.mockResolvedValue({ success: true })
  getUserById.mockImplementation(async (id: string) => ({ data: { user: { email: `${id}@example.se` } } }))
  delete process.env.COMMUNITY_REVIEWER_USER_IDS
})

describe('notifyPublishedAuthors', () => {
  it('waits while the page is not live on accounted.se, without claiming the row', async () => {
    enqueue({ data: [published] })
    const fetchImpl = page(404)
    expect(await notifyPublishedAuthors(service as never, fetchImpl)).toEqual({ notified: [], waiting: ['sub-1'], failed: [] })
    expect(fetchImpl).toHaveBeenCalledWith('https://www.accounted.se/instruktioner/bokfor-saas', expect.objectContaining({ method: 'HEAD' }))
    expect(findCall('company_skills', 'update')).toBeUndefined()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('claims the row and emails the author once the page is live, with shares to LinkedIn and X', async () => {
    enqueue({ data: [published] })
    enqueue({ data: [{ id: 'sub-1' }] }) // claimed
    expect(await notifyPublishedAuthors(service as never, page(200))).toEqual({ notified: ['sub-1'], waiting: [], failed: [] })
    expect(findCall('company_skills', 'update')?.[0]).toEqual({ published_notified_at: expect.any(String) })
    expect(findCalls('company_skills', 'is')).toContainEqual(['published_notified_at', null])
    expect(getUserById).toHaveBeenCalledWith('user-1')
    const mail = sendEmail.mock.calls[0][0]
    expect(mail).toMatchObject({ to: 'user-1@example.se', subject: 'Bokför SaaS är publicerad' })
    expect(mail.html).toContain('https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fwww.accounted.se%2Finstruktioner%2Fbokfor-saas')
    expect(mail.html).toContain('https://x.com/intent/post?text=')
    expect(mail.text).toContain('https://www.accounted.se/instruktioner/bokfor-saas#dela')
    expect(mail.html).toContain('href="https://www.accounted.se/instruktioner/bokfor-saas#dela"')
  })

  it('sends nothing when another run claimed the row first', async () => {
    enqueue({ data: [published] })
    enqueue({ data: [] })
    expect((await notifyPublishedAuthors(service as never, page(200))).notified).toEqual([])
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('releases the claim when the email fails, so the next run tries again', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'down' })
    enqueue({ data: [published] })
    enqueue({ data: [{ id: 'sub-1' }] }) // claimed
    enqueue({ data: null }) // released
    expect(await notifyPublishedAuthors(service as never, page(200))).toEqual({ notified: [], waiting: [], failed: ['sub-1'] })
    expect(findCalls('company_skills', 'update').map((call) => call[0])).toEqual([{ published_notified_at: expect.any(String) }, { published_notified_at: null }])
  })

  it('does nothing without an email service', async () => {
    configured.mockReturnValue(false)
    expect(await notifyPublishedAuthors(service as never, page(200))).toEqual({ notified: [], waiting: [], failed: [] })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('notifyReviewersOfSubmission', () => {
  const submission = { title: 'Bokför SaaS <b>', handle: 'anna', kind: 'workflow' as const }

  it('emails every named reviewer, with the review page and the title escaped', async () => {
    process.env.COMMUNITY_REVIEWER_USER_IDS = 'rev-1, rev-2'
    await notifyReviewersOfSubmission(service as never, submission, 'https://app.accounted.se/skills/granskning')
    const mail = sendEmail.mock.calls[0][0]
    expect(mail.to).toEqual(['rev-1@example.se', 'rev-2@example.se'])
    expect(mail.subject).toBe('Att granska: Bokför SaaS <b>')
    expect(mail.html).toContain('Bokför SaaS &lt;b&gt;')
    expect(mail.html).toContain('https://app.accounted.se/skills/granskning')
  })

  it('sends nothing when nobody reviews, and never throws', async () => {
    await notifyReviewersOfSubmission(service as never, submission, 'https://app.accounted.se/skills/granskning')
    expect(sendEmail).not.toHaveBeenCalled()
    process.env.COMMUNITY_REVIEWER_USER_IDS = 'rev-1'
    getUserById.mockRejectedValue(new Error('auth down'))
    await expect(notifyReviewersOfSubmission(service as never, submission, 'https://app.accounted.se/skills/granskning')).resolves.toBeUndefined()
  })
})
