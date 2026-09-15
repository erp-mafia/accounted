import type { SupabaseClient } from '@supabase/supabase-js'
import { listApartments, listTransfers } from '@/lib/brf/apartment-register'
import { buildKU55Item, type KU55Item, type KU55Transfer } from '@/lib/brf/ku55'
import { getTaxProfile } from '@/lib/company/brf-tax-profile'
import { createLogger } from '@/lib/logger'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const log = createLogger('brf/ku55-service')

/**
 * Assemble the KU55 items of an income year from the register: one per
 * transfer (one överlåtare each). The privatbostadsföretag assessment of
 * the income year decides fältkod 638 (OaktaBostadsftg); when no assessment
 * exists the flag is left out and a warning is returned, never a guess.
 */
export interface KU55Assembly {
  income_year: number
  items: KU55Item[]
  warnings: string[]
}

interface MemberIdentity {
  id: string
  name: string
  postal_address: string | null
  personal_number_ciphertext: string | null
}

export async function assembleKU55(
  supabase: SupabaseClient,
  companyId: string,
  incomeYear: number,
): Promise<KU55Assembly> {
  const warnings: string[] = []
  const [transfers, apartments, profile] = await Promise.all([
    listTransfers(supabase, companyId, { incomeYear }),
    listApartments(supabase, companyId),
    getTaxProfile(supabase, companyId, incomeYear),
  ])
  if (!profile) {
    warnings.push(
      `Ingen bedömning av privatbostadsföretag finns för ${incomeYear} (IL 2 kap. 17 §): fältkod 638 lämnas tom. Registrera bedömningen under /api/brf/tax-profile.`,
    )
  }
  const sellerIds = [...new Set(transfers.map((t) => t.from_member_id))]
  const members =
    sellerIds.length === 0
      ? []
      : await fetchAllRows<MemberIdentity>(
          ({ from, to }) =>
            supabase
              .from('association_members')
              .select('id, name, postal_address, personal_number_ciphertext')
              .eq('company_id', companyId)
              .in('id', sellerIds)
              .order('id', { ascending: true })
              .range(from, to),
          { dedupeBy: (row) => row.id },
        )
  const memberById = new Map(members.map((m) => [m.id, m]))
  const apartmentById = new Map(apartments.map((a) => [a.id, a]))
  const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

  const items = transfers.map((transfer, index) => {
    const member = memberById.get(transfer.from_member_id)
    let personalNumber: string | null = null
    if (member?.personal_number_ciphertext) {
      try {
        personalNumber = decryptPersonnummer(member.personal_number_ciphertext)
      } catch (err) {
        log.error('KU55: personnummer decrypt failed; KU reported as incomplete', {
          memberId: member.id,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const ku: KU55Transfer = {
      transferId: transfer.id,
      specificationNumber: index + 1,
      apartmentNumber: apartmentById.get(transfer.apartment_id)?.apartment_number ?? '',
      transferDate: transfer.transfer_date,
      share: Number(transfer.share),
      kind: transfer.kind,
      price: num(transfer.price),
      additionalPrice: num(transfer.additional_price),
      forvarvDate: transfer.forvarv_date,
      forvarvGenomArvGavaBodelning: transfer.forvarv_genom_arv_gava_bodelning,
      forvarvPrice: num(transfer.forvarv_price),
      kapitaltillskott: num(transfer.kapitaltillskott),
      inreFondVidOverlatelse: num(transfer.inre_fond_vid_overlatelse),
      inreFondVidForvarv: num(transfer.inre_fond_vid_forvarv),
      andelFormogenhet1974: num(transfer.andel_formogenhet_1974),
      gemensamIndividuell: transfer.ku55_uppgifter,
      oaktaBostadsforetag: profile ? !profile.privatbostadsforetag : false,
      seller: {
        memberId: transfer.from_member_id,
        name: member?.name ?? '',
        personalNumber,
        postalAddress: member?.postal_address ?? null,
      },
    }
    return buildKU55Item(ku, incomeYear)
  })
  return { income_year: incomeYear, items, warnings }
}
