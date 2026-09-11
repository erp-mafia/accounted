import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import dotenv from 'dotenv'

const config = dotenv.parse(readFileSync('.env.sie.branch.local'))
const url = new URL(config.POSTGRES_URL)
if (!url.username.endsWith('.metjnjrhvujscngnpzdv') || !url.hostname.endsWith('.pooler.supabase.com')) {
  throw new Error('Refusing to test outside the known staging branch')
}
url.searchParams.set('sslmode', 'verify-full')
url.searchParams.set('sslrootcert', resolve('.env.sie-ca.crt'))
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--project', 'pg-real', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString(), SIE_MIGRATION_DRY_RUN: process.env.SIE_MIGRATION_DRY_RUN ?? '0' },
})
process.exitCode = result.status ?? 1
