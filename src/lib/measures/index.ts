/**
 * Defined measures (see ./registry.ts): figures an agent answers from, each
 * equal to the report a person sees, explained down to every line.
 */
export {
  explainMeasure,
  getMeasure,
  getMeasureDefinition,
  listMeasures,
  REGISTERED_MEASURE_IDS,
  type MeasureExplainHandle,
  type MeasureExplanation,
  type MeasureOutcome,
  type MeasureSummary,
  type MeasureValue,
} from './registry'
export { DEFAULT_DRILLDOWN_LIMIT, MAX_DRILLDOWN_LIMIT } from './explain'
export {
  DIMENSION_PARAMS,
  MEASURE_IDS,
  MEASURE_PARAM_KEYS,
  isMeasureId,
  type MeasureDimension,
  type MeasureId,
  type MeasureParams,
} from './types'
