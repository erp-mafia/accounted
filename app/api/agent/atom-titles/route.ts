import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// GET /api/agent/atom-titles?ids=slug1,slug2,...
//
// Resolves agent_atom_registry slugs → human titles for chip rendering in
// the settings företagsprofil panel. The registry is a globally-readable
// reference table (no per-company data), so this only needs an authenticated
// session, not a company scope. Returns { data: { [slug]: title } }; slugs
// with no matching row are simply omitted and the client falls back to a
// slug-derived label.
export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const idsParam = url.searchParams.get('ids') ?? ''
  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 50) // bound the IN list

  if (ids.length === 0) return NextResponse.json({ data: {} })

  const { data, error } = await supabase
    .from('agent_atom_registry')
    .select('id, title')
    .in('id', ids)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const titles: Record<string, string> = {}
  for (const row of (data ?? []) as { id: string; title: string | null }[]) {
    if (row.title) titles[row.id] = row.title
  }
  return NextResponse.json({ data: titles })
}
