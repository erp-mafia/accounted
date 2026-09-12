import type { PoolClient } from 'pg'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Exercise the production orchestration against real SQL in the staging test
 * transaction. HTTP transport is replaced; RPC bodies and constraints are real.
 * This is separate from the committed, concurrent staging acceptance runner.
 */
export function stagingSIEClient(client:PoolClient,source:string):SupabaseClient {
  const identifier = (value:string) => {
    if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error(`Unsafe test identifier ${value}`)
    return `"${value}"`
  }
  function from(table:string) {
    let columns = '*'
    const values:unknown[] = [], where:string[] = [], order:string[] = []
    let offset = 0,limit = 1000,single = false
    const filter = (column:string,op:string,value:unknown) => {
      values.push(value);where.push(`${identifier(column)} ${op} $${values.length}`);return builder
    }
    const builder = {
      select(value:string) {columns = value === '*' ? '*' : value.split(',').map(s=>identifier(s.trim())).join(',');return builder},
      eq(column:string,value:unknown) {return filter(column,'=',value)},
      gte(column:string,value:unknown) {return filter(column,'>=',value)},
      lt(column:string,value:unknown) {return filter(column,'<',value)},
      order(column:string,options?:{ascending?:boolean}) {order.push(`${identifier(column)} ${options?.ascending === false ? 'DESC':'ASC'}`);return builder},
      range(start:number,end:number) {offset=start;limit=end-start+1;return builder},
      limit(value:number) {limit=value;return builder},
      maybeSingle() {single=true;return builder},
      async then(resolve:(value:unknown)=>unknown,reject?:(reason:unknown)=>unknown) {
        try {
          const result = await client.query(`SELECT ${columns} FROM public.${identifier(table)} ${where.length?'WHERE '+where.join(' AND '):''}
            ${order.length?'ORDER BY '+order.join(','):''} OFFSET ${offset} LIMIT ${limit}`,values)
          return resolve({data:single ? result.rows[0] ?? null : result.rows,error:null})
        } catch(error) {return reject?.(error)}
      },
    }
    return builder
  }
  return {from,storage:{from:()=>({download:async()=>({data:new Blob([source]),error:null})})},
    async rpc(name:string,args:Record<string,unknown>) {
      const pairs = Object.entries(args)
      await client.query('SAVEPOINT simulated_request')
      try {
        const result = await client.query(`SELECT to_jsonb(r) AS data FROM public.${identifier(name)}(${pairs.map(([key],i)=>`${identifier(key)} => $${i+1}`).join(',')}) r`,
          pairs.map(([,value])=>value !== null && typeof value === 'object' ? JSON.stringify(value) : value))
        await client.query('RELEASE SAVEPOINT simulated_request')
        return {data:result.rows[0]?.data,error:null}
      } catch(error) {
        await client.query('ROLLBACK TO SAVEPOINT simulated_request')
        return {data:null,error}
      }
    },
  } as unknown as SupabaseClient
}
