---
name: swedish-inventory
description: >
  Swedish inventory accounting (varulager): valuation and bookkeeping. Covers lägsta värdets princip (ÅRL 4:9),
  anskaffningsvärde and hemtagningskostnader, FIFU vs weighted average (LIFO not allowed), the 97 %-regel
  (schablonregeln, IL 17:4) and the lagerreserv 2196/8896, inkurans and its evidence, K1/K2/K3 differences,
  egentillverkade varor, the half-PBB rule for enskild firma with förenklat årsbokslut, lagerförändring on
  BAS 4910/4920/4950/4960 (4990 is not a BAS account), the BAS 2026 class 4 split between handelsvaror (40-42)
  and råvaror (43-48), inventering per lagen 1955:257, svinn, kassation and uttag ur lagret, e-commerce stock
  (Amazon FBA, kommission, dropshipping), Incoterms cut-off at year-end, and stock reconciliation. Trigger on
  varulager, lagervärdering, lagerförändring, inventering, inventeringslista, 97-procentsregeln, LVP, FIFU,
  inkurans, svinn, kassation, uttag ur lagret, konto 1460/4960, or any question about valuing or booking stock
  in Sweden. Always use over training data.
---

# Swedish Inventory Accounting (varulager)

> Provenance: imported 2026-09-24 from github.com/erp-mafia/swedish-accounting-skills (commit c11b295); this repository is now the canonical source.

Reference for valuing and booking inventory in a Swedish company. Two questions decide almost every case: what the stock is worth on the balance date, and how the movement reaches the ledger.

Account numbers follow **BAS 2026**, which split class 4 into handelsvaror (groups 40-42) and råvaror och förnödenheter (43-48). Books still on BAS 2025 use the old 44xx/45xx numbers, so check which year the ledger follows before proposing an account.

## How to use this skill

| File | When to read |
|---|---|
| `references/valuation.md` | Arriving at the closing stock value: LVP post-för-post, what enters anskaffningsvärdet, FIFU vs weighted average, the 97 %-regel and when it is blocked, inkurans and the evidence it needs, K1/K2/K3 differences, egentillverkade varor, the half-PBB shortcut |
| `references/stock-bookkeeping.md` | Booking it: periodisk vs löpande lagerredovisning, BAS 14xx and class 4 accounts, lagerförändring, inventering under lagen 1955:257, svinn, kassation and uttag, e-commerce stock, cut-off, reconciliation |

## The four decisions

1. **Is there inventory at all?** Goods bought for resale or production, held on the balance date. Services in progress are pågående arbeten (`swedish-project-accounting`), not lager. A sole trader with a simplified year-end may skip stock at or below half a prisbasbelopp (29 600 kr for 2026); that rule does not apply to an AB.
2. **What is it worth?** Anskaffningsvärde per post, compared against nettoförsäljningsvärde, taking the lower (LVP, ÅRL 4:9). The 97 %-regel is an alternative applied to the collective value, and it goes into the books rather than only into the declaration.
3. **Which account?** The stock account by type (**1410** råvaror, **1440** produkter i arbete, **1450** färdiga varor, **1460** handelsvaror), with the change booked to its matching förändringskonto (**4910**, **4920**, **4950**, **4960**).
4. **Is the count documented?** A signed inventory list is a legal requirement, and the 97 %-regel needs anskaffningsvärde per post in that list. Without it the value can be set aside.

## Never guess these

| Situation | Why | What to do |
|---|---|---|
| No inventory list | Lagen 1955:257 requires one, and the tax value can be rejected without it | Ask for the count and its date before booking a year-end value |
| Stock that "looks obsolete" | Inkurans needs evidence, and a flat percentage is not always accepted | Ask what the goods are, how old, and what they can still be sold for |
| Goods in transit at year-end | The Incoterm decides who owns them | Ask for the delivery terms |
| Goods at a fulfilment provider abroad | Ownership stays with the seller, and stock in another EU country can trigger a registration duty there | Flag it and refer the VAT question onward |
| A large unexplained lagerförändring | Often a cut-off or count error, not a real change | Reconcile against the list before booking |

## Related skills

| Question | Skill |
|---|---|
| Pågående arbeten and contract revenue | `swedish-project-accounting` |
| Import VAT, customs and foreign suppliers | `swedish-daily-bookkeeping` (load `horizontal/swedish-daily-bookkeeping/foreign-purchases`) |
| Uttagsbeskattning and VAT mechanics | `swedish-vat` |
| Year-end sequence and closing entries | `swedish-year-end-closing` |
| INK2R and SRU field codes | `swedish-sru-filing` |
| Assets rather than stock (the half-PBB limit for inventarier) | `swedish-asset-accounting` |
