import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import dotenv from 'dotenv'
import pg from 'pg'

// Deliberately staging-only. This dry run cannot commit DDL or fixture data.
const stagingRef = 'metjnjrhvujscngnpzdv'
const config = dotenv.parse(readFileSync('.env.sie.branch.local'))
const connectionString = config.POSTGRES_URL
const url = new URL(connectionString)
if (!url.username.endsWith(`.${stagingRef}`) || !url.hostname.endsWith('.pooler.supabase.com')) {
  throw new Error('Refusing to verify migrations outside the known staging branch')
}
url.searchParams.delete('sslmode')
const client = new pg.Client({ connectionString: url.toString(),
  ssl: { rejectUnauthorized: true, ca: readFileSync('.env.sie-ca.crt', 'utf8') } })
await client.connect()
try {
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout = '3s'")
  await client.query("SET LOCAL statement_timeout = '30s'")
  for (const filename of process.argv.slice(2)) {
    const path = resolve(filename)
    if (!path.startsWith(resolve('supabase/migrations') + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error('Migration must be inside this worktree')
    }
    await client.query(readFileSync(path, 'utf8'))
    console.log(`Parsed and executed in rollback transaction: ${filename}`)
  }
} finally {
  await client.query('ROLLBACK')
  await client.end()
}
