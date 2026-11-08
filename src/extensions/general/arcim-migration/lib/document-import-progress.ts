import { NextResponse } from 'next/server'
import type { ImportDocumentsResult } from './import-documents'

/** POST-compatible SSE: completed files remain archived if the reader leaves. */
export function streamDocumentImport(
  run:(onProgress:(result:ImportDocumentsResult)=>void)=>Promise<ImportDocumentsResult>,
  failure:(error:unknown)=>Response,
):NextResponse {
  let disconnected=false
  const encoder=new TextEncoder()
  return new NextResponse(new ReadableStream<Uint8Array>({
    async start(controller) {
      const send=(event:unknown)=>{
        if(!disconnected)controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        const result=await run(progress=>send({type:'progress',result:progress}))
        send({type:'complete',result})
      } catch(error) {
        const response=failure(error)
        send({type:'error',payload:await response.json()})
      } finally { if(!disconnected)controller.close() }
    },
    cancel(){disconnected=true},
  }),{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform'}})
}
