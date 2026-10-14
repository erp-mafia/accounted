import type { HouseholdDeductionDto, HouseholdWorkDto } from '../dto';
import type {
  ROT_WORK_TYPES,
  RUT_WORK_TYPES,
  GRON_TEKNIK_WORK_TYPES,
} from '@/lib/invoices/rot-rut-rules';
import { readNumber } from '../amounts';
import { roundOre } from '@/lib/money';

/**
 * eAccounting's ROT, RUT and grön teknik fields on CustomerInvoiceApi, read
 * into the provider-neutral deduction DTO. The fields come from Visma's
 * published OpenAPI only: no live payload with a deduction has been seen, so
 * every reader degrades to "absent" rather than guessing.
 */

type HusWorkCode =
  | (typeof ROT_WORK_TYPES)[number]['code']
  | (typeof RUT_WORK_TYPES)[number]['code'];
type GronTeknikCode = (typeof GRON_TEKNIK_WORK_TYPES)[number]['code'];
type DeductionKind = HouseholdDeductionDto['kind'];

/**
 * CustomerInvoiceRowApi.WorkCostType to Skatteverket's arbetstypskod. Every
 * value of Visma's enum except None (0) is listed: a code, or null where
 * Visma has a work type that the begäran schema (Begaran.xsd) has no element
 * for, so the review list must ask which element it belongs under.
 */
export const VISMA_WORK_COST_TYPES: Readonly<Record<number, HusWorkCode | null>> = {
  1: 'BYGG', // RotConstructionWork
  2: 'EL', // RotElectricalWork
  3: 'GLAS_PLAT', // RotGlassSheetMetalWork
  4: 'MARK_DRAN', // RotGroundWork
  5: 'MURNING', // RotBrickWork
  6: 'MALNING', // RotPaintDecorateWork
  7: 'VVS', // RotPlumbWork
  9: 'STAD', // RutCleanJobWork
  10: 'KLAD', // RutCareClothTextile
  12: 'SNOSKOTTNING', // RutSnowRemove
  13: 'TRADGARD', // RutGarden
  14: 'BARNPASS', // RutBabySitting
  // 15, 22 and 28 are matched on Visma's English enum names alone: confirm
  // against the Swedish labels in Visma's UI before relying on them.
  15: 'PERSONLIG_OMS', // RutOtherCare
  18: 'FLYTT', // RutRemovalServices
  19: 'IT', // RutITServices
  20: null, // RotHeatPump
  21: null, // RotHeatPump2
  22: 'REPARATION', // RutHomeAppliances
  23: null, // RotSolarHeatingSystem
  24: null, // RotWoodBoiler
  25: null, // RotFuelBoiler
  26: 'TVATT', // RutLaundry
  27: 'MOBLERING', // RutFurnishing
  28: 'TRANSPORT', // RutGoodsTransport
  29: 'TILLSYN', // RutHomeSupervision
};

/** CustomerInvoiceRowApi.GreenTechnologyType to Skatteverket's installation type. */
export const VISMA_GREEN_TECHNOLOGY_TYPES: Readonly<Record<number, GronTeknikCode | null>> = {
  1: 'INSTALLATION_SOLCELLER', // SolarCellInstallation
  2: 'INSTALLATION_LAGRING', // ElectricEnergyStorageInstallation
  3: 'INSTALLATION_LADDPUNKT', // ElectricVehicleChargingPointInstallation
};

/** CustomerInvoiceApi.TaxDeductionStatus to where the claim stands. */
const TAX_DEDUCTION_STATES: Readonly<Record<number, HouseholdDeductionDto['providerState']>> = {
  0: 'open', // None
  1: 'open', // ApplicableForDeductionExport
  2: 'requested', // ExportedToTaxAuthority
  3: 'rejected', // RejectedByTaxAuthority
};

/**
 * Looks a Visma enum value up in one of the tables above: undefined when
 * the value is absent or None (0), so the row is not deduction work; null
 * when it is a value the table does not know.
 */
function lookup<T extends string>(
  table: Readonly<Record<number, T | null>>,
  value: number | null | undefined,
): T | null | undefined {
  if (value == null || value === 0) return undefined;
  return Object.hasOwn(table, value) ? table[value] : null;
}

/** Skatteverket's arbetstypskod for a WorkCostType; see VISMA_WORK_COST_TYPES. */
export function vismaWorkType(workCostType: number | null | undefined): HusWorkCode | null | undefined {
  return lookup(VISMA_WORK_COST_TYPES, workCostType);
}

/** Skatteverket's installation type for a GreenTechnologyType. */
export function vismaGreenTechnologyType(
  greenTechnologyType: number | null | undefined,
): GronTeknikCode | null | undefined {
  return lookup(VISMA_GREEN_TECHNOLOGY_TYPES, greenTechnologyType);
}

/**
 * The deduction the invoice header declares: RotReducedInvoicingType
 * (0 Normal, 1 Rot, 2 Rut), else grön teknik when UsesGreenTechnology is set.
 * Undefined for an ordinary invoice.
 */
export function vismaDeductionKind(raw: Record<string, unknown>): DeductionKind | undefined {
  const type = readNumber(raw, ['RotReducedInvoicingType']);
  if (type === 1) return 'rot';
  if (type === 2) return 'rut';
  if (raw['UsesGreenTechnology'] === true) return 'gron_teknik';
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The invoice's ROT, RUT or grön teknik deduction, or undefined when it has
 * none. The amount is RotReducedInvoicingAmount, or the buyers' shares
 * summed when the header leaves it out; a deduction of nothing is no
 * deduction.
 */
export function vismaHouseholdDeduction(raw: Record<string, unknown>): HouseholdDeductionDto | undefined {
  const kind = vismaDeductionKind(raw);
  if (!kind) return undefined;

  const persons = Array.isArray(raw['Persons']) ? raw['Persons'].filter(isRecord) : [];
  const buyers = persons.map((person) => {
    const personnummer = nonEmptyString(person['Ssn']);
    const share = readNumber(person, ['Amount']);
    return {
      ...(personnummer !== undefined ? { personnummer } : {}),
      ...(share !== undefined ? { amount: share } : {}),
    };
  });

  const amount = roundOre(
    readNumber(raw, ['RotReducedInvoicingAmount'])
      ?? buyers.reduce((sum, buyer) => sum + (buyer.amount ?? 0), 0),
  );
  if (!(amount > 0)) return undefined;

  const designation = nonEmptyString(raw['RotReducedInvoicingPropertyName']);
  const brfOrgNumber = nonEmptyString(raw['RotReducedInvoicingOrgNumber']);
  const propertyType = readNumber(raw, ['RotPropertyType']);
  const type = propertyType === 1 ? 'apartment' : propertyType === 2 ? 'property' : undefined;
  const property: HouseholdDeductionDto['property'] = designation !== undefined || brfOrgNumber !== undefined || type !== undefined
    ? {
        ...(designation !== undefined ? { designation } : {}),
        ...(brfOrgNumber !== undefined ? { brfOrgNumber } : {}),
        ...(type !== undefined ? { type } : {}),
      }
    : undefined;

  const status = readNumber(raw, ['TaxDeductionStatus']);
  const providerState = status !== undefined ? TAX_DEDUCTION_STATES[status] : undefined;

  return {
    kind,
    amount,
    buyers,
    ...(property ? { property } : {}),
    ...(providerState ? { providerState } : {}),
  };
}

/**
 * The deduction data of one invoice row, or undefined when the row is not
 * deduction work. ROT and RUT rows are the ones Visma flags IsWorkCost with a
 * WorkCostType; on a grön teknik invoice they are the rows with a
 * GreenTechnologyType. A text row never is.
 */
export function vismaHouseholdWork(
  row: Record<string, unknown>,
  greenTechnology: boolean,
): HouseholdWorkDto | undefined {
  if (row['IsTextRow'] === true) return undefined;

  let work: Pick<HouseholdWorkDto, 'workType' | 'providerWorkType'> | undefined;
  const workCostType = readNumber(row, ['WorkCostType']);
  const workType = row['IsWorkCost'] === true ? vismaWorkType(workCostType) : undefined;
  if (workType !== undefined) {
    work = { workType, providerWorkType: String(workCostType) };
  } else if (greenTechnology) {
    const greenType = readNumber(row, ['GreenTechnologyType']);
    const installation = vismaGreenTechnologyType(greenType);
    if (installation !== undefined) work = { workType: installation, providerWorkType: String(greenType) };
  }
  if (!work) return undefined;

  const hours = readNumber(row, ['WorkHours']);
  const materialCost = readNumber(row, ['MaterialCosts']);
  return {
    ...work,
    ...(hours !== undefined ? { hours } : {}),
    ...(materialCost !== undefined ? { materialCost } : {}),
  };
}
