import type { QueryResultRow } from 'pg'
import { getPool } from './setup'

/** Existing writer regression cases now exercise the private chunk writer.
 * The public job protocol is tested separately in sie-job.pg.test.ts. This
 * fixture supplies batch/ordinal identity without bypassing any ledger guard.
 */
export function sieWriterFixture() {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(sql:string,values:unknown[] = []) {
      if (!sql.includes('public.write_sie_job_entries(')) return getPool().query<T>(sql,values)
      const client=await getPool().connect()
      try {
        await client.query('BEGIN')
        const entries=JSON.parse(values[3] as string) as Array<Record<string,unknown>>
        let batch=entries.find(entry=>entry.sieImportId)?.sieImportId
        if (!batch) batch=(await client.query(`INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
          VALUES($1,$2,'writer-regression.se',md5(gen_random_uuid()::text),4,'completed') RETURNING id`,values.slice(0,2))).rows[0].id
        const prepared=entries.map((entry,index)=>({...entry,sieImportId:entry.sieImportId ?? batch,sourceOrdinal:index}))
        const result=await client.query<T>(sql,[...values.slice(0,3),JSON.stringify(prepared)])
        await client.query('COMMIT')
        return result
      } catch(error) {await client.query('ROLLBACK');throw error}
      finally {client.release()}
    },
  }
}
