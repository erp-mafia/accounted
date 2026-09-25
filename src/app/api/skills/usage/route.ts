import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadSkillUsage } from '@/lib/agent-skills/usage'

export const GET = withRouteContext('skills.usage', async (_request, { supabase, companyId }) => {
  const usage = await loadSkillUsage(supabase, companyId)
  return NextResponse.json({ data: usage }, { headers: { 'Cache-Control': 'private, no-store' } })
})
