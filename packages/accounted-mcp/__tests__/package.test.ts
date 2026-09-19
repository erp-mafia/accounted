import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const packageDir = path.resolve(__dirname, '..')
const packageJson = JSON.parse(
  readFileSync(path.join(packageDir, 'package.json'), 'utf8')
) as {
  name: string
  bin: Record<string, string>
  dependencies?: Record<string, string>
}
const source = readFileSync(path.join(packageDir, 'index.mjs'), 'utf8')

describe('accounted-mcp package', () => {
  it('publishes the Accounted command without runtime dependencies', () => {
    expect(packageJson.name).toBe('accounted-mcp')
    expect(packageJson.bin).toEqual({ 'accounted-mcp': './index.mjs' })
    expect(packageJson.dependencies).toBeUndefined()
  })

  it('uses Accounted configuration names and preserves the API-key wire prefix', () => {
    expect(source).toContain('ACCOUNTED_API_KEY')
    expect(source).toContain('ACCOUNTED_URL')
    expect(source).toContain('ACCOUNTED_CLIENT')
    expect(source).toContain('X-Accounted-Client')
    expect(source).toContain('tool_namespace')
    expect(source).toContain('gnubok_sk_')
    // ACCOUNTED_COMPANY pins the connection through the `company` query
    // parameter the server reads (COMPANY_PIN_QUERY_PARAM).
    expect(source).toContain('ACCOUNTED_COMPANY')
    expect(source).toContain("searchParams.set('company'")
    // A malformed pin fails closed (exit), never open to the default scope.
    expect(source).toMatch(/ACCOUNTED_COMPANY must be a company id[\s\S]*process\.exit\(1\)/)

    expect(source).not.toContain('GNUBOK_API_KEY')
    expect(source).not.toContain('GNUBOK_URL')
    expect(source).not.toContain('X-Gnubok-Client')
    expect(source).not.toContain('app.gnubok.se')
  })
})
