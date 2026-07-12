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

## Decision tree for developers

```
AB → always årsredovisning → K2 (if mindre and eligible) or K3
Enskild firma, revenue ≤ 3 MSEK → K1 förenklat årsbokslut
Enskild firma, revenue > 3 MSEK → full årsbokslut per BFNAR 2017:3
Enskild firma meeting större criteria (extremely rare) → årsredovisning under K3
```

## 2025/2026 K2 changes

From fiscal years starting after December 31, 2025, K2 can no longer be used by:
- Bostadsrättsföreningar
- Companies with foreign branches
- Companies holding crypto assets
- Those issuing share-based payments