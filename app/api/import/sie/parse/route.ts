import { NextResponse } from 'next/server'
import {
  parseSIEFile,
  validateSIEFile,
  detectEncoding,
  decodeBuffer,
  calculateFileHash,
} from '@/lib/import/sie-parser'
import { suggestMappings, getMappingStats, isSystemAccount } from '@/lib/import/account-mapper'
import { scanSieForCp1252Artifacts, formatSieArtifactWarning } from '@/lib/import/sie-artifact-scan'
import { generateImportPreview, checkDuplicateImport, checkDuplicatePeriodImport } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SIEAccountMappingRecord } from '@/lib/import/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/import/sie/parse
 * Parse an uploaded SIE file and return preview data.
 */
export const POST = withRouteContext(
  'sie_import.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return errorResponseFromCode('SIE_PARSE_NO_FILE', log, { requestId })
    }

    const filename = file.name.toLowerCase()
    if (!filename.endsWith('.sie') && !filename.endsWith('.se')) {
      return errorResponseFromCode('SIE_PARSE_INVALID_TYPE', log, {
        requestId,
        details: { filename: file.name },
      })
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024
    if (file.size > MAX_FILE_SIZE) {
      return errorResponseFromCode('SIE_PARSE_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    if (file.size === 0) {
      return errorResponseFromCode('SIE_PARSE_EMPTY', log, { requestId })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const arrayBuffer = await file.arrayBuffer()
      const encoding = detectEncoding(arrayBuffer)
      const content = decodeBuffer(arrayBuffer, encoding)

      const duplicate = await checkDuplicateImport(supabase, companyId!, content)
      if (duplicate) {
        return errorResponseFromCode('SIE_DUPLICATE_FILE', opLog, {
          requestId,
          details: {
            importId: duplicate.id,
            importedAt: duplicate.imported_at,
          },
        })
      }

      const parsed = parseSIEFile(content)

      // Mojibake tripwire (warn, never block): CP437 bytes decoded as
      // windows-1252 somewhere upstream leave C1 specials mid-word in account
      // names and voucher texts. Surface it as a parse-issue warning, the
      // preview's existing warnings card, so the user can abort before import.
      const artifactScan = scanSieForCp1252Artifacts(parsed)
      if (artifactScan.flagged) {
        const contentLines = content.split(/\r?\n/)
        const firstSample = artifactScan.samples[0]
        const sampleLine = firstSample
          ? contentLines.findIndex((l) => l.includes(firstSample))
          : -1
        parsed.issues.push({
          severity: 'warning',
          line: sampleLine >= 0 ? sampleLine + 1 : 1,
          message: formatSieArtifactWarning(artifactScan),
        })
        opLog.warn('sie parse: CP1252 mojibake artifacts in decoded content', {
          encoding,
          artifactCount: artifactScan.artifactCount,
          samples: artifactScan.samples,
        })
      }

      if (parsed.stats.fiscalYearStart && parsed.stats.fiscalYearEnd) {
        const periodDuplicate = await checkDuplicatePeriodImport(
          supabase,
          companyId!,
          parsed.stats.fiscalYearStart,
          parsed.stats.fiscalYearEnd,
        )
        if (periodDuplicate) {
          return errorResponseFromCode('SIE_DUPLICATE_PERIOD', opLog, {
            requestId,
            details: {
              importId: periodDuplicate.id,
              fiscalYearStart: periodDuplicate.fiscal_year_start,
              fiscalYearEnd: periodDuplicate.fiscal_year_end,
              importedAt: periodDuplicate.imported_at,
            },
          })
        }
      }

      const validation = validateSIEFile(parsed)

      if (!validation.valid) {
        return errorResponseFromCode('SIE_PARSE_VALIDATION_FAILED', opLog, {
          requestId,
          details: { errors: validation.errors, warnings: validation.warnings },
        })
      }

      const excludedSystemAccounts = parsed.accounts
        .filter((a) => isSystemAccount(a.number))
        .map((a) => ({ number: a.number, name: a.name }))
      const bookkeepingAccounts = parsed.accounts.filter((a) => !isSystemAccount(a.number))

      const { data: storedMappings } = await supabase
        .from('sie_account_mappings')
        .select('*')
        .eq('company_id', companyId)

      const mappings = suggestMappings(
        bookkeepingAccounts,
        BAS_REFERENCE,
        (storedMappings as SIEAccountMappingRecord[]) || undefined,
      )

      const preview = generateImportPreview(parsed, mappings)
      preview.excludedSystemAccounts = excludedSystemAccounts
      preview.accountCount = bookkeepingAccounts.length

      const fileHash = await calculateFileHash(content)

      return NextResponse.json({
        success: true,
        encoding,
        fileHash,
        parsed: {
          header: parsed.header,
          accounts: parsed.accounts,
          stats: parsed.stats,
          issues: parsed.issues,
        },
        mappings,
        mappingStats: getMappingStats(mappings),
        preview,
        validation: {
          valid: validation.valid,
          errors: validation.errors,
          warnings: validation.warnings,
        },
      })
    } catch (err) {
      opLog.error('sie parse failed', err as Error)
      return errorResponseFromCode('SIE_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }
  },
)
