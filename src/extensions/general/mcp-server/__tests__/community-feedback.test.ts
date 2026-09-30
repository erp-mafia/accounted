import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/agent-skills/community', async (original) => ({ ...(await original<object>()), recordCommunityFeedback: vi.fn() }))

import { recordCommunityFeedback } from '@/lib/agent-skills/community'
import { tools } from '../server'

const feedback = tools.find((t) => t.name === 'gnubok_feedback')!
const supabase = {} as never
let actor = 0
const call = (args: Record<string, unknown>) => feedback.execute(args, 'company-a', 'user-a', supabase, { type: 'api_key', id: `key-${++actor}` } as never)

describe('gnubok_feedback: "fungerade det?" on a community skill is an upvote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(recordCommunityFeedback).mockResolvedValue({ vote: true })
  })

  it('turns a yes into an upvote through the same service as the Agentinstruktioner page', async () => {
    const result = await call({ context: 'Användaren: ja, det fungerade.', skill_slug: 'community/stang-dagskassan', upvote: true, sentiment: 'positive' })
    expect(result).toMatchObject({ recorded: true })
    expect(recordCommunityFeedback).toHaveBeenCalledWith(supabase, { companyId: 'company-a', userId: 'user-a', slug: 'community/stang-dagskassan', vote: true })
  })

  it('records no vote for a no', async () => {
    await call({ context: 'Nej.', skill_slug: 'community/stang-dagskassan', upvote: false })
    expect(recordCommunityFeedback).not.toHaveBeenCalled()
  })

  it('keeps the upvote even when telemetry is rate-limited', async () => {
    const sameActor = { type: 'api_key', id: 'key-rate-limited' } as never
    await feedback.execute({ context: 'Tool feedback first.' }, 'company-a', 'user-a', supabase, sameActor)
    const result = await feedback.execute({ context: 'Ja.', skill_slug: 'community/stang-dagskassan', upvote: true }, 'company-a', 'user-a', supabase, sameActor)
    expect(result).toMatchObject({ recorded: true })
    expect(recordCommunityFeedback).toHaveBeenCalledTimes(1)
  })

  it('refuses an upvote without a community skill, and an unknown one', async () => {
    await expect(call({ context: 'Ja.', upvote: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(call({ context: 'Ja.', skill_slug: 'month-end-close', upvote: true })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    vi.mocked(recordCommunityFeedback).mockResolvedValue(null)
    await expect(call({ context: 'Ja.', skill_slug: 'community/gone', upvote: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('leaves ordinary feedback untouched', async () => {
    await call({ context: 'A tool description misled me.', skill_slug: 'community/stang-dagskassan' })
    expect(recordCommunityFeedback).not.toHaveBeenCalled()
  })
})
