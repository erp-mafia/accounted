import type { SIEJob } from './sie-job-contract'
import type { ImportResult } from './types'
import { describeSIEJobFailure, formatImportFailure, type ImportFailure } from './import-failure'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createClient } from '@/lib/supabase/client'

/**
 * A polled job ended in failed, paused or undone. The message is the job's
 * own reason plus its per-voucher errors and the import reference, ready to
 * show verbatim: a plain Error here went through the Swedish-pattern
 * heuristic in the callers' catch blocks, which swallowed any miss into the
 * generic fallback and hid why the year stopped.
 */
export class SIEJobFailedError extends Error {
  constructor(readonly job: SIEJob, readonly failure: ImportFailure) {
    super(formatImportFailure(failure))
    this.name = 'SIEJobFailedError'
  }
}

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
      const failure = describeSIEJobFailure(job)
      if (job.job_state === 'paused') failure.message += ' Fortsätt eller ångra under Importhistorik.'
      throw new SIEJobFailedError(job, failure)
    }
    await new Promise<void>((resolve,reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal?.reason) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort',onAbort);resolve() },2000)
      signal?.addEventListener('abort',onAbort,{once:true})
    })
  }
  throw signal?.reason ?? new Error('Status polling cancelled')
}
