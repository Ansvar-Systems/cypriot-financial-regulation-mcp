# Coverage

This document describes the corpus completeness for the Cypriot Financial Regulation MCP.

## Data Sources

### CySEC — Cyprus Securities and Exchange Commission

| Sourcebook ID      | Content                        | Coverage Status |
|--------------------|--------------------------------|-----------------|
| `CYSEC_DIRECTIVES` | CySEC directives (DI series)   | Partial — structured on ingest |
| `CYSEC_CIRCULARS`  | CySEC circulars (C series)     | Partial — structured on ingest |

CySEC publishes directives and circulars on its official website at <https://www.cysec.gov.cy/>. Coverage is subject to what is publicly available and successfully ingested.

**Enforcement actions** (fines, bans, restrictions, warnings) are ingested separately via the enforcement pipeline.

### CBC — Central Bank of Cyprus

| Sourcebook ID   | Content                                       | Coverage Status |
|-----------------|-----------------------------------------------|-----------------|
| `CBC_DIRECTIVES`| CBC prudential directives for credit institutions and PSPs | Partial — structured on ingest |

CBC publishes prudential directives at <https://www.centralbank.cy/>.

## Known Gaps

- Coverage is limited to provisions successfully crawled and structured during the last ingest run.
- Historical or superseded provisions may not be fully represented.
- Enforcement actions prior to the ingest window may be absent.
- Always verify against primary CySEC/CBC publications for compliance purposes.

## Data Freshness

Check `data/ingest-state.json` for the last successful ingest timestamp, or call the `cy_fin_check_data_freshness` tool.
