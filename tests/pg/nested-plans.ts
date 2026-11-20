import { getClient } from './setup'

/** One node of an EXPLAIN (FORMAT JSON) plan, with the keys the pg tests read. */
export interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Parent Relationship'?: string
  'Index Cond'?: string
  'Recheck Cond'?: string
  Filter?: string
  Plans?: PlanNode[]
}

/**
 * The plans of the statements a call runs as `userId`, a SQL or plpgsql
 * function's own statements included: auto_explain, preloaded in the
 * supabase/postgres image, reports nested statements to the client as NOTICEs.
 * This is how a test sees the plan a function body really gets (a generic
 * plan, sized for an average company), which EXPLAIN of the call hides.
 */
export async function nestedPlans(userId: string, sql: string, params: unknown[]): Promise<Array<{ query: string; plan: PlanNode }>> {
  const client = await getClient()
  const notices: string[] = []
  const onNotice = (notice: { message?: string }) => {
    if (notice.message) notices.push(notice.message)
  }
  client.on('notice', onNotice)
  try {
    await client.query('BEGIN')
    for (const setting of ['log_min_duration = 0', 'log_nested_statements = on', 'log_format = json', 'log_level = notice']) {
      await client.query(`SET LOCAL auto_explain.${setting}`)
    }
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(sql, params)
  } finally {
    await client.query('ROLLBACK')
    client.off('notice', onNotice)
    client.release()
  }
  return notices
    .filter((message) => message.includes('{'))
    .map((message) => {
      const explained = JSON.parse(message.slice(message.indexOf('{'))) as { 'Query Text': string; Plan: PlanNode }
      return { query: explained['Query Text'], plan: explained.Plan }
    })
}

/**
 * The scans of `relation` in the statement's own tree (not inside a SubPlan,
 * an InitPlan or a CTE), each with whether a join sits above it. A scan under
 * a join is the outer or inner side of that join: when the other side is a
 * view or a CTE, a generic plan may run it again for every row.
 */
export function mainTreeScans(node: PlanNode, relation: string, underJoin = false): Array<{ nodeType: string; underJoin: boolean }> {
  const relationship = node['Parent Relationship']
  if (relationship === 'SubPlan' || relationship === 'InitPlan') return []
  const own = node['Relation Name'] === relation ? [{ nodeType: node['Node Type'], underJoin }] : []
  const isJoin = node['Node Type'] === 'Nested Loop' || node['Node Type'].endsWith('Join')
  return [...own, ...(node.Plans ?? []).flatMap((child) => mainTreeScans(child, relation, underJoin || isJoin))]
}
