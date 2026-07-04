import { NextResponse } from 'next/server'
import { parseSIEFile, detectEncoding, decodeBuffer } from '@/lib/import/sie-parser'
import { suggestMappings } from '@/lib/import/account-mapper'
import { executeSIEImport, checkDuplicateImport } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { AccountMapping, SIEAccountMappingRecord } from '@/lib/import/types'

// SIE imports with many vouchers need extended execution time
export const maxDuration = 300

/** POST /api/import/sie/execute: execute the SIE import. */
export const POST = withRouteContext(
  'sie_import.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const mappingsJson = formData.get('mappings') as string | null
    const optionsJson = formData.get('options') as string | null

    if (!file) {
      return errorResponseFromCode('SIE_PARSE_NO_FILE', log, { requestId })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      // The voucherSeries option is a fallback for vouchers that arrive without
      // a series (SIE4I subsystem files); the import engine preserves each
      // #VER's source series per voucher.
      const parsedOptions = optionsJson ? JSON.parse(optionsJson) : null
      const { data: companySettings } = await supabase
        .from('company_settings')
        .select('default_voucher_series')
        .eq('company_id', companyId)
        .maybeSingle()
      const companyDefaultSeries = companySettings?.default_voucher_series || 'B'

      const options = parsedOptions ?? {
        createFiscalPeriod: true,
        importOpeningBalances: true,
        importTransactions: true,
        voucherSeries: companyDefaultSeries,
        updateAccountNames: true,
      }

      const arrayBuffer = await file.arrayBuffer()
      const encoding = detectEncoding(arrayBuffer)
      const content = decodeBuffer(arrayBuffer, encoding)

      const parsed = parseSIEFile(content)

      const duplicate = await checkDuplicateImport(supabase, companyId!, content)
      if (duplicate) {
        return errorResponseFromCode('SIE_DUPLICATE_FILE', opLog, {
          requestId,
          details: { importId: duplicate.id, importedAt: duplicate.imported_at },
        })
      }

      let mappings: AccountMapping[]

      if (mappingsJson) {
        mappings = JSON.parse(mappingsJson)
      } else {
        const { data: storedMappings } = await supabase
          .from('sie_account_mappings')
          .select('*')
          .eq('company_id', companyId)

        mappings = suggestMappings(
          parsed.accounts,
          BAS_REFERENCE,
          (storedMappings as SIEAccountMappingRecord[]) || undefined,
        )
      }

      const unmapped = mappings.filter((m) => !m.targetAccount)
      if (unmapped.length > 0) {
        return errorResponseFromCode('SIE_IMPORT_UNMAPPED_ACCOUNTS', opLog, {
          requestId,
          details: {
            unmappedCount: unmapped.length,
            unmappedAccounts: unmapped.slice(0, 5).map((m) => ({
              account: m.sourceAccount,
              name: m.sourceName,
            })),
          },
        })
      }

      // Account creation (and #KONTO renames) happen inside executeSIEImport
      // via syncMappedAccounts: the pre-create block that used to live here
      // was a duplicate of that logic.
      const result = await executeSIEImport(
        supabase,
        companyId!,
        user.id,
        parsed,
        mappings,
        {
          filename: file.name,
          fileContent: content,
          createFiscalPeriod: options.createFiscalPeriod,
          importOpeningBalances: options.importOpeningBalances,
          importTransactions: options.importTransactions,
          voucherSeries: options.voucherSeries || companyDefaultSeries,
          updateAccountNames: options.updateAccountNames ?? true,
          markImportedNoDocRequired: options.markImportedNoDocRequired ?? false,
        },
      )

      if (!result.success) {
        return errorResponseFromCode('SIE_IMPORT_FAILED', opLog, {
          requestId,
          details: { result },
        })
      }

      return NextResponse.json({ success: true, result })
    } catch (err) {
      opLog.error('sie execute unexpected error', err as Error)
      return errorResponseFromCode('SIE_IMPORT_UNEXPECTED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
