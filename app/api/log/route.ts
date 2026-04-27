import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false }, { status: 401 })

  try {
    const { message, extra } = await request.json()

    const sanitize = (s: unknown) =>
      typeof s === 'string' ? s.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 500) : ''

    // This console.error runs server-side → visible in Vercel Logs
    console.error('[onboarding]', sanitize(message), extra ? sanitize(JSON.stringify(extra)) : '')

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
}
