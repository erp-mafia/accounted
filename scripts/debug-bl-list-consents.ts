import { createClient } from '@supabase/supabase-js'

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: consents, error } = await supabase
    .from('provider_consents')
    .select('id, provider, company_name, status, created_at')
    .eq('provider', 'bjornlunden')
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  console.log(JSON.stringify(consents, null, 2))

  for (const c of consents ?? []) {
    const { data: tokens } = await supabase
      .from('provider_consent_tokens')
      .select('consent_id, provider_company_id, token_expires_at')
      .eq('consent_id', c.id)
      .limit(1)
    console.log(`consent ${c.id}: tokens=${tokens?.length ? 'yes' : 'NO'} userKey=${tokens?.[0]?.provider_company_id?.slice(0, 8) ?? '-'}…`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
