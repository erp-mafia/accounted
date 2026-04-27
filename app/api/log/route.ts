import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false }, { status: 401 })

  try {
    const { message, extra } = await request.json()

    // This console.error runs server-side → visible in Vercel Logs
    console.error('[onboarding]', message, extra ? JSON.stringify(extra) : '')

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
}
