import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

// Holds what 20260902093000 does to the two embedding search functions: no
// EXECUTE for anon or PUBLIC, EXECUTE for authenticated and service_role.
//
// The type is written with its schema, extensions.vector, here as in the
// migration. pgvector is installed in the extensions schema, and a session
// whose search_path does not include that schema cannot resolve a bare
// `vector`: a replay of the migrations on such a session stopped at those
// statements. CI applies the migrations on that kind of session (see the
// "Apply every migration" step), so a bare extension type fails there.
const FUNCTIONS = [
  'public.match_documents(extensions.vector, integer, double precision)',
  'public.match_booking_templates(extensions.vector, integer, double precision)',
]

async function canExecute(role: string, fn: string): Promise<boolean> {
  const { rows } = await getPool().query<{ can: boolean }>(
    'SELECT has_function_privilege($1, $2::regprocedure, $3) AS can',
    [role, fn, 'EXECUTE'],
  )
  return rows[0].can
}

describe('embedding search functions: who may call them', () => {
  it.each(FUNCTIONS)('%s is closed to anon', async (fn) => {
    expect(await canExecute('anon', fn)).toBe(false)
  })

  it.each(FUNCTIONS)('%s is open to authenticated and service_role', async (fn) => {
    expect(await canExecute('authenticated', fn)).toBe(true)
    expect(await canExecute('service_role', fn)).toBe(true)
  })

  it.each(FUNCTIONS)('%s is not granted to PUBLIC', async (fn) => {
    const { rows } = await getPool().query<{ granted: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS granted`,
      [fn],
    )
    expect(rows[0].granted).toBe(false)
  })
})
