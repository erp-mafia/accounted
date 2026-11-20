/**
 * Trade with other EU countries as the momsdeklaration shows it lives with the
 * declaration in the ledger kernel (lib/reports/eu-trade.ts), where the
 * deadline calendar may read it. Re-exported here for the VAT readers.
 */
export {
  EU_TRADE_PURCHASE_RUTOR,
  EU_TRADE_SALES_RUTOR,
  euTradeInRutor,
  formatEuTradeBoxes,
  hasEuTrade,
  helarsmomsHasEuTrade,
  type EuTradeBox,
  type EuTradeInRutor,
  type EuTradeRuta,
} from '@/lib/reports/eu-trade'
