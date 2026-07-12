/**
 * READ-ONLY: inspect the actual schema of public.skatteverket_tokens in prod.
 * Confirms whether the UNIQUE(user_id) constraint exists and under what name.
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  // Try a row-count query to see if the table exists at all
  const { count, error: countErr } = await supabase
    .from('skatteverket_tokens')
    .select('*', { count: 'exact', head: true })
  console.log('Table reachable:', !countErr, 'row count:', count, 'error:', countErr?.message ?? 'none')

  // Use the postgrest schema endpoint to introspect via the OpenAPI spec
  const { data: openapiResp, error: openapiErr } = await supabase
    .from('skatteverket_tokens')
    .select('id, user_id, expires_at, refresh_count, scope')
    .limit(1)
  console.log('Sample select error:', openapiErr?.message ?? 'none', ', rows:', openapiResp?.length ?? 0)

  // Fetch from pg_constraint via a dedicated RPC if available, else via raw query
  // Supabase JS doesn't expose raw SQL, so we use a workaround: try to provoke
  // the constraint name from the upsert error itself with a dummy row.
  console.log('\nProbing existing rows to count duplicates per user_id…')
  const { data: rows, error: rowsErr } = await supabase
    .from('skatteverket_tokens')
    .select('id, user_id, created_at')
    .order('created_at', { ascending: false })
  if (rowsErr) {
    console.error('rows fetch failed:', rowsErr.message)
    return
  }
  const byUser = new Map<string, number>()
  for (const r of rows ?? []) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + 1)
  console.log(`  ${rows?.length ?? 0} total rows across ${byUser.size} distinct user_ids`)
  const dupes = [...byUser.entries()].filter(([, n]) => n > 1)
  if (dupes.length) console.log('  duplicates:', dupes)
}

main().catch(err => { console.error(err); process.exit(1) })
