import type { SIEJob } from './sie-job-contract'
import type { ImportResult } from './types'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createClient } from '@/lib/supabase/client'

/** File bytes go directly to Storage, outside Vercel's function body limit. */
export async function uploadSIEFile(file:File):Promise<string> {
  const response = await fetch('/api/import/sie/upload',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:file.name,size:file.size}),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(getErrorMessage(body))
  const {error} = await createClient().storage.from('sie-files').uploadToSignedUrl(body.data.path,body.data.token,file,
    {contentType:'application/octet-stream',upsert:false})
  if (error) throw new Error(error.message)
  return body.data.path
}

export async function fetchSIEJob(importId:string, signal?:AbortSignal):Promise<SIEJob> {
  const response = await fetch(`/api/import/sie/${encodeURIComponent(importId)}?progress=true`,{signal,cache:'no-store'})
  const body = await response.json()
  if (!response.ok) throw new Error(getErrorMessage(body))
  return body.data
}

/** Poll a durable execution before starting a dependent fiscal year. */
export async function waitForSIEJob(importId:string,onProgress?:(job:SIEJob)=>void,signal?:AbortSignal):Promise<ImportResult> {
  while (!signal?.aborted) {
    const job = await fetchSIEJob(importId,signal)
    onProgress?.(job)
    if (job.job_state === 'completed') return job.job_result as unknown as ImportResult
    if (['paused','failed','undone'].includes(job.job_state)) {
      throw new Error(`${job.error_message ?? 'Importen behöver granskas'} (import ${job.id}). Fortsätt eller ångra under Importhistorik.`)
    }
    await new Promise<void>((resolve,reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal?.reason) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort',onAbort);resolve() },2000)
      signal?.addEventListener('abort',onAbort,{once:true})
    })
  }
  throw signal?.reason ?? new Error('Status polling cancelled')
}
