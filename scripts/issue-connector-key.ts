#!/usr/bin/env npx tsx
/**
 * Issue a connector key for a self-hosted instance (manual sales, v1).
 *
 * Writes a connector_keys row through the service role and prints the key
 * ONCE together with the .env lines the operator pastes into their instance.
 * The key is never stored: only its SHA-256.
 *
 * Usage:
 *   npx tsx scripts/issue-connector-key.ts --org 5561234567 --name "Byrå AB" \
 *       --instance https://bokforing.byra.se [--months 12] \
 *       [--scopes bank_sync,skatteverket,org_lookup,migration] [--notes "..."] --confirm
 *
 * Reads .env.local (which points at PRODUCTION in this repo: the script
 * refuses to write without --confirm and prints the target host first).
 */

import { config } from 'dotenv'
import { resolve } from 'node:path'
config({ path: resolve(process.cwd(), '.env.local') })

import { createServiceRoleClient } from '../lib/supabase/service-client'
import { CONNECTOR_CAPABILITIES } from '../lib/entitlements/keys'
import { generateConnectorKey } from '../lib/connect/hosted/keys'

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return undefined
  const value = process.argv[idx + 1]
  return value && !value.startsWith('--') ? value : ''
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main(): Promise<void> {
  const org = (arg('org') ?? '').replace(/\D/g, '')
  const name = arg('name') ?? ''
  const instance = arg('instance') ?? ''
  const months = Number(arg('months') ?? '12')
  const scopes = (arg('scopes') ?? 'bank_sync,skatteverket').split(',').map((s) => s.trim()).filter(Boolean)
  const bankPerCompany = Number(arg('bank-connections-per-company') ?? '1')
  const skvPerCompany = Number(arg('skv-connections-per-company') ?? '1')
  const syncMinInterval = Number(arg('sync-min-interval') ?? '0')
  const notes = arg('notes') ?? null

  const problems: string[] = []
  if (!/^\d{10}$/.test(org)) problems.push('--org must be a 10-digit Swedish organisation number')
  if (!name) problems.push('--name is required (licensee name)')
  try {
    const u = new URL(instance)
    if (u.protocol !== 'https:') problems.push('--instance must be an https:// origin')
  } catch {
    problems.push('--instance must be a valid https:// URL')
  }
  if (!Number.isInteger(months) || months <= 0 || months > 120) problems.push('--months must be an integer 1..120')
  const unknown = scopes.filter((s) => !(CONNECTOR_CAPABILITIES as readonly string[]).includes(s))
  if (unknown.length) problems.push(`unknown scopes: ${unknown.join(', ')} (allowed: ${CONNECTOR_CAPABILITIES.join(', ')})`)
  for (const [name, v] of [['bank-connections-per-company', bankPerCompany], ['skv-connections-per-company', skvPerCompany]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 100) problems.push(`--${name} must be 0..100`)
  }
  if (!Number.isFinite(syncMinInterval) || syncMinInterval < 0) problems.push('--sync-min-interval must be >= 0 seconds')
  if (problems.length) {
    console.error(problems.map((p) => `  x ${p}`).join('\n'))
    process.exit(2)
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.local)')
    process.exit(2)
  }
  const periodEnd = new Date()
  periodEnd.setUTCMonth(periodEnd.getUTCMonth() + months)

  console.log(`Target:    ${new URL(url).host}`)
  console.log(`Licensee:  ${name} (${org})`)
  console.log(`Instance:  ${new URL(instance).origin}`)
  console.log(`Scopes:    ${scopes.join(', ')}`)
  console.log(`Limits:    ${bankPerCompany} bank + ${skvPerCompany} SKV connection(s)/company, min sync interval ${syncMinInterval}s`)
  console.log(`Period:    until ${periodEnd.toISOString().slice(0, 10)} (${months} months)`)
  if (!flag('confirm')) {
    console.log('\nDry run. Re-run with --confirm to issue the key.')
    return
  }

  const { key, hash, prefix } = generateConnectorKey()
  const supabase = createServiceRoleClient(url, serviceKey)
  const { data, error } = await supabase
    .from('connector_keys')
    .insert({
      key_hash: hash,
      key_prefix: prefix,
      org_number: org,
      licensee_name: name,
      instance_url: new URL(instance).origin,
      scopes,
      status: 'active',
      current_period_end: periodEnd.toISOString(),
      limits: {
        bank_connections_per_company: Math.floor(bankPerCompany),
        skv_connections_per_company: Math.floor(skvPerCompany),
        sync_min_interval_s: Math.floor(syncMinInterval),
      },
      notes,
    })
    .select('id')
    .single()
  if (error || !data) {
    console.error('insert failed:', error?.message)
    process.exit(1)
  }

  console.log(`\nIssued connector key ${prefix}… (id ${(data as { id: string }).id}). Shown ONCE, not stored:\n`)
  console.log(`  ${key}\n`)
  console.log('Paste into the instance .env, then restart the app and cron containers:')
  console.log(`  GNUBOK_CONNECTOR_KEY=${key}`)
  console.log('  # GNUBOK_CONNECT_URL=https://app.gnubok.se   (default)')
  console.log('\nThe hourly connector sync writes the capability grants; run it once by hand to check:')
  console.log('  curl -sf -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/connector/sync/cron')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
