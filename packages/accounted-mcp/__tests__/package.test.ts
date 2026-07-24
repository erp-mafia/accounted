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

    expect(source).not.toContain('GNUBOK_API_KEY')
    expect(source).not.toContain('GNUBOK_URL')
    expect(source).not.toContain('X-Gnubok-Client')
    expect(source).not.toContain('app.gnubok.se')
  })
})
