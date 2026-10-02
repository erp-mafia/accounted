# Legal Framework for Swedish Year-End Closing

## Primary laws

- **Bokföringslagen (BFL, SFS 1999:1078)**: who must keep accounts and how they close
- **Årsredovisningslagen (ÅRL, SFS 1995:1554)**: content and format of årsredovisning

## Who does what (BFL Chapter 6)

### Must prepare årsredovisning (§1):
- All aktiebolag (regardless of size)
- All ekonomiska föreningar
- Handelsbolag with at least one juridisk person as partner
- Bookkeeping-obligated stiftelser
- Any enterprise meeting "större företag" criteria

### Prepare årsbokslut (§3):
- All other bookkeeping-obligated entities (including most enskilda firmor)
- Consists of: resultaträkning, balansräkning, noter (no förvaltningsberättelse)

### Förenklat årsbokslut (§6):
- Enterprises with nettoomsättning normally ≤ 3 MSEK
- Only resultaträkning and balansräkning, no notes

## K-framework mapping

| Framework | Full name | Applies to |
|-----------|-----------|------------|
| K1 (BFNAR 2006:1) | Enskilda näringsidkare, förenklat årsbokslut | Sole traders with revenue ≤ 3 MSEK |
| BFNAR 2017:3 | Årsbokslut | Entities preparing full årsbokslut (not årsredovisning) |
| K2 (BFNAR 2016:10) | Årsredovisning i mindre företag | Smaller AB/EK föreningar choosing simplified rules |
| K3 (BFNAR 2012:1) | Årsredovisning och koncernredovisning | Default/mandatory for all årsredovisning preparers; required for större företag |

## Större företag definition (ÅRL 1 kap 3§)

Exceeds more than one of three thresholds for each of the two most recent fiscal years:
- **>50 average employees**
- **>40 MSEK total assets**
- **>80 MSEK net revenue**
- Or any entity with listed securities

Större företag must use K3, prepare kassaflödesanalys, and meet additional disclosure requirements.

These thresholds (and the revisionsplikt limits in ABL 9:1) are unchanged for 2026. The inquiry on company categories in ÅRL (Ju 2025:11, dir. 2025:49) is due to report by 2026-09-29.

## Decision tree for developers

```
AB → always årsredovisning → K2 (if mindre and eligible) or K3
Enskild firma, revenue ≤ 3 MSEK → K1 förenklat årsbokslut
Enskild firma, revenue > 3 MSEK → full årsbokslut per BFNAR 2017:3
Enskild firma meeting större criteria (extremely rare) → årsredovisning under K3
```

## 2025/2026 K2 changes

From fiscal years starting after December 31, 2025 (BFNAR 2025:2), K2 can no longer be used by:
- Bostadsrättsföreningar and bostadsföreningar, regardless of size (1.1A e); they apply K3, including its new chapter 38 (BFNAR 2025:3)
- Companies that have or during the year had foreign branches (filialer)
- Companies that acquired goods or services against aktierelaterade ersättningar
- Companies with issued skuldebrev that can be settled with egetkapitalinstrument, or similar sammansatta finansiella instrument
- Companies holding kryptotillgångar (occasional use as a means of payment excepted)
- Companies with a material uppskjuten skatteskuld, or with buildings generating at least 75% of nettoomsättningen (1.1B). This does not apply to companies exceeding at most one of: >3 employees, >1.5 MSEK balansomslutning, >3 MSEK nettoomsättning (1.1C), or to companies that applied K2 the previous year and are not normally covered by 1.1B.

Other K2 changes (7,000 SEK accrual limit, new balance-sheet posts, KF withdrawals, error correction): see `k2-vs-k3.md`.

Årsbokslut: BFNAR 2026:1 amends BFNAR 2017:3 for FY beginning after 2026-12-31 (earlier use allowed for a FY ending 2026-12-31 or later).