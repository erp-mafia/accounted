import { describe, it, expect } from 'vitest'
import {
  VISMA_WORK_COST_TYPES,
  VISMA_GREEN_TECHNOLOGY_TYPES,
  vismaWorkType,
  vismaGreenTechnologyType,
} from '../housework'
import { ROT_WORK_TYPES, RUT_WORK_TYPES, GRON_TEKNIK_WORK_TYPES } from '@/lib/invoices/rot-rut-rules'

/**
 * Visma's WorkCostType and GreenTechnologyType enums as CustomerInvoiceRowApi
 * publishes them. Written out here, not read from the map, so a value the map
 * drops or a value it invents fails the test.
 */
const WORK_COST_TYPE_ENUM: Record<string, number> = {
  RotConstructionWork: 1,
  RotElectricalWork: 2,
  RotGlassSheetMetalWork: 3,
  RotGroundWork: 4,
  RotBrickWork: 5,
  RotPaintDecorateWork: 6,
  RotPlumbWork: 7,
  RutCleanJobWork: 9,
  RutCareClothTextile: 10,
  RutSnowRemove: 12,
  RutGarden: 13,
  RutBabySitting: 14,
  RutOtherCare: 15,
  RutRemovalServices: 18,
  RutITServices: 19,
  RotHeatPump: 20,
  RotHeatPump2: 21,
  RutHomeAppliances: 22,
  RotSolarHeatingSystem: 23,
  RotWoodBoiler: 24,
  RotFuelBoiler: 25,
  RutLaundry: 26,
  RutFurnishing: 27,
  RutGoodsTransport: 28,
  RutHomeSupervision: 29,
}

const GREEN_TECHNOLOGY_TYPE_ENUM: Record<string, number> = {
  SolarCellInstallation: 1,
  ElectricEnergyStorageInstallation: 2,
  ElectricVehicleChargingPointInstallation: 3,
}

const ROT_CODES = new Set<string>(ROT_WORK_TYPES.map((w) => w.code))
const RUT_CODES = new Set<string>(RUT_WORK_TYPES.map((w) => w.code))
const GRON_TEKNIK_CODES = new Set<string>(GRON_TEKNIK_WORK_TYPES.map((w) => w.code))

describe('VISMA_WORK_COST_TYPES', () => {
  it('covers every WorkCostType except None, mapped or explicitly null', () => {
    for (const [name, value] of Object.entries(WORK_COST_TYPE_ENUM)) {
      expect(Object.hasOwn(VISMA_WORK_COST_TYPES, value), `${name} (${value})`).toBe(true)
    }
    expect(Object.keys(VISMA_WORK_COST_TYPES).map(Number).sort((a, b) => a - b)).toEqual(
      Object.values(WORK_COST_TYPE_ENUM).sort((a, b) => a - b),
    )
  })

  it('maps Rot work types to rot codes and Rut work types to rut codes', () => {
    for (const [name, value] of Object.entries(WORK_COST_TYPE_ENUM)) {
      const code = VISMA_WORK_COST_TYPES[value]
      if (code === null) continue
      const codes = name.startsWith('Rot') ? ROT_CODES : RUT_CODES
      expect(codes.has(code), `${name} -> ${code}`).toBe(true)
    }
  })

  it('leaves the heat pump, solar heating and boiler types unmapped: the begäran schema has no element for them', () => {
    for (const value of [20, 21, 23, 24, 25]) {
      expect(VISMA_WORK_COST_TYPES[value]).toBeNull()
    }
  })
})

describe('VISMA_GREEN_TECHNOLOGY_TYPES', () => {
  it('covers every GreenTechnologyType except None with a grön teknik code', () => {
    for (const [name, value] of Object.entries(GREEN_TECHNOLOGY_TYPE_ENUM)) {
      const code = VISMA_GREEN_TECHNOLOGY_TYPES[value]
      expect(code != null && GRON_TEKNIK_CODES.has(code), `${name} -> ${code}`).toBe(true)
    }
    expect(Object.keys(VISMA_GREEN_TECHNOLOGY_TYPES)).toHaveLength(3)
  })
})

describe('vismaWorkType', () => {
  it('returns the arbetstypskod for a mapped type', () => {
    expect(vismaWorkType(1)).toBe('BYGG')
    expect(vismaWorkType(9)).toBe('STAD')
    expect(vismaWorkType(29)).toBe('TILLSYN')
  })

  it('returns null for a type without a Skatteverket element and for an unknown value', () => {
    expect(vismaWorkType(20)).toBeNull()
    expect(vismaWorkType(99)).toBeNull()
  })

  it('returns undefined for None and for an absent value: not a work row', () => {
    expect(vismaWorkType(0)).toBeUndefined()
    expect(vismaWorkType(undefined)).toBeUndefined()
    expect(vismaWorkType(null)).toBeUndefined()
  })
})

describe('vismaGreenTechnologyType', () => {
  it('maps the three installation types', () => {
    expect(vismaGreenTechnologyType(1)).toBe('INSTALLATION_SOLCELLER')
    expect(vismaGreenTechnologyType(2)).toBe('INSTALLATION_LAGRING')
    expect(vismaGreenTechnologyType(3)).toBe('INSTALLATION_LADDPUNKT')
  })

  it('returns undefined for None or absent and null for an unknown value', () => {
    expect(vismaGreenTechnologyType(0)).toBeUndefined()
    expect(vismaGreenTechnologyType(undefined)).toBeUndefined()
    expect(vismaGreenTechnologyType(4)).toBeNull()
  })
})
