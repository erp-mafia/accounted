/**
 * Vitest setup for the MCP tool integration project.
 *
 * Fails loudly and early if the stack is not up, because the alternative is a
 * suite that silently passes against nothing. `scripts/tool-pg/reset.sh` brings
 * it up and replays every migration.
 */
import { beforeAll } from 'vitest'
import { TOOL_PG_REST_URL, TOOL_PG_DATABASE_URL, signServiceRoleJwt } from './client'

// tests/pg/fixtures.ts builds its rows through a `pg` Pool keyed on
// DATABASE_URL. Pointing that at the same database lets this project reuse
// seedCompany / insertCompany / insertPostedJournalEntry verbatim instead of
// growing a second, divergent set of fixtures.
process.env.DATABASE_URL ??= TOOL_PG_DATABASE_URL

beforeAll(async () => {
  const jwt = signServiceRoleJwt()
  let response: Response
  try {
    response = await fetch(`${TOOL_PG_REST_URL}/companies?select=id&limit=1`, {
      headers: { apikey: jwt, Authorization: `Bearer ${jwt}` },
    })
  } catch (err) {
    throw new Error(
      `tool-pg: PostgREST unreachable at ${TOOL_PG_REST_URL}. Run: npm run tools:pg:reset\n${String(err)}`,
    )
  }
  if (!response.ok) {
    throw new Error(
      `tool-pg: PostgREST answered ${response.status} for a trivial read: ${await response.text()}\n` +
        'The schema is probably missing or stale. Run: npm run tools:pg:reset',
    )
  }
}, 30_000)
