import {readFileSync} from 'node:fs'
import dotenv from 'dotenv'

async function main(){
Object.assign(process.env,dotenv.parse(readFileSync('.env.sie-runtime.local')),{SIE_IMPORT_JOBS:'true'})
if(process.env.NEXT_PUBLIC_SUPABASE_URL!=='https://metjnjrhvujscngnpzdv.supabase.co') throw new Error('Staging only')
const originalFetch=globalThis.fetch
let chunks=0
globalThis.fetch=async(input,init)=>{
  const url=typeof input==='string' ? input : input instanceof URL ? input.href : input.url
  if(url.includes('/rpc/import_sie_chunk')) process.send?.({event:'chunk-start',number:++chunks})
  return originalFetch(input,init)
}
const {runSIEWorker}=await import('../../lib/import/sie-job-worker')
await runSIEWorker({importId:process.argv[2]})
process.send?.({event:'finished'})
}
void main().catch(error=>{console.error(error.message);process.exitCode=1})
