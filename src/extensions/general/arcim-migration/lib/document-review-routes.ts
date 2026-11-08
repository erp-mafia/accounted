import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { ApiRouteDefinition } from '@/lib/extensions/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withExecutionDeadline } from '@/lib/http/execution-budget'
import { FortnoxDocumentScopesRequiredError, importProviderDocuments } from './import-documents'

const Query = z.object({
  consentId:z.uuid(),offset:z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit:z.coerce.number().int().min(1).max(50).default(25),query:z.string().max(200).default(''),
})

/** The extension dispatcher enforces the session, MFA and active company. */
export const documentReviewRoutes:ApiRouteDefinition[]=[{
  method:'GET',path:'/unmatched-documents',
  handler:async(request,ctx)=>{
    if(!ctx?.companyId||!ctx.userId) return NextResponse.json({error:{code:'UNAUTHORIZED'}},{status:401})
    const url=new URL(request.url)
    const query=Query.safeParse(Object.fromEntries(url.searchParams))
    if(!query.success) return errorResponseFromCode('VALIDATION_ERROR',ctx.log)
    const {consentId,...review}=query.data
    const {data:consent,error}=await ctx.supabase.from('provider_consents').select('id')
      .eq('id',consentId).eq('company_id',ctx.companyId).in('status',[0,1]).maybeSingle()
    if(error) return errorResponseFromCode('PROVIDER_IMPORT_DOCUMENTS_FAILED',ctx.log)
    if(!consent) return NextResponse.json({error:{code:'NOT_FOUND'}},{status:404})
    try {
      const result=await withExecutionDeadline(Date.now()+210_000,'provider-document-review',()=>importProviderDocuments({
        supabase:ctx.supabase,companyId:ctx.companyId,userId:ctx.userId,consentId,review,dryRun:true,
      }))
      return NextResponse.json({data:result.unmatchedReview},{headers:{'Cache-Control':'no-store'}})
    } catch(e) {
      ctx.log.warn('provider document review failed',{kind:e instanceof FortnoxDocumentScopesRequiredError ? 'scope' : 'source'})
      return errorResponseFromCode(e instanceof FortnoxDocumentScopesRequiredError
        ? 'PROVIDER_DOCUMENT_SCOPES_REQUIRED' : 'PROVIDER_IMPORT_DOCUMENTS_FAILED',ctx.log)
    }
  },
}]
