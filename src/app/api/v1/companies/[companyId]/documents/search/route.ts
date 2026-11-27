/**
 * GET /api/v1/companies/{companyId}/documents/search: the archive searched by
 * document text and file name, and where the company brain runs, the
 * agreements and facts read from it (operation documents.search, the search
 * gnubok_search_records answers over MCP).
 *
 * Contract, docs and rules live in src/lib/operations/document-search.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { documentsSearch } from '@/lib/operations/document-search'

export const GET = v1OperationHandler(documentsSearch)
