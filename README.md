# Cypriot Financial Regulation MCP

MCP server for querying Cyprus Securities and Exchange Commission (CySEC) directives and circulars, plus Central Bank of Cyprus (CBC) prudential directives and enforcement actions.

## Tools

| Tool | Description |
|------|-------------|
| `cy_fin_search_regulations` | Full-text search across CySEC and CBC provisions |
| `cy_fin_get_regulation` | Get a specific provision by sourcebook and reference |
| `cy_fin_list_sourcebooks` | List all sourcebook collections |
| `cy_fin_search_enforcement` | Search CySEC enforcement actions and sanctions |
| `cy_fin_check_currency` | Check whether a provision is currently in force |
| `cy_fin_about` | Server metadata and tool list |

## Sourcebooks

- `CYSEC_DIRECTIVES` — CySEC Directives
- `CYSEC_CIRCULARS` — CySEC Circulars
- `CBC_DIRECTIVES` — CBC Prudential Directives

## Setup

```bash
npm install
npm run build
npm run seed       # seed sample data
npm start          # HTTP server on port 3000
```

Set `CYSEC_DB_PATH` to use a custom database location.

## Data Sources

- CySEC: https://www.cysec.gov.cy/
- CBC: https://www.centralbank.cy/
