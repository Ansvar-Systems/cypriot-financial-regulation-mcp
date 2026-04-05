# Tools Reference

This MCP server exposes 8 tools under the `cy_fin_` prefix.

---

## cy_fin_search_regulations

Full-text search across CySEC and CBC regulatory provisions. Returns matching directives, circulars, and prudential directives for Cyprus-regulated entities.

**Parameters:**

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `query`     | string | Yes      | Search query (e.g., `AIF managers`, `client money`, `capital adequacy`) |
| `sourcebook`| string | No       | Filter by sourcebook ID (e.g., `CYSEC_DIRECTIVES`, `CYSEC_CIRCULARS`, `CBC_DIRECTIVES`) |
| `status`    | string | No       | Filter by status: `in_force`, `deleted`, `not_yet_in_force` |
| `limit`     | number | No       | Maximum results (default 20, max 100) |

**Example:**
```json
{ "query": "capital adequacy", "sourcebook": "CBC_DIRECTIVES", "limit": 5 }
```

---

## cy_fin_get_regulation

Get a specific CySEC or CBC provision by sourcebook and reference.

**Parameters:**

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `sourcebook`| string | Yes      | Sourcebook identifier (e.g., `CYSEC_DIRECTIVES`) |
| `reference` | string | Yes      | Provision reference (e.g., `DI87-01`, `C116`, `CBC/2014/1`) |

**Example:**
```json
{ "sourcebook": "CYSEC_DIRECTIVES", "reference": "DI87-01" }
```

---

## cy_fin_list_sourcebooks

List all CySEC and CBC sourcebook collections with their names and descriptions.

**Parameters:** None

**Example:**
```json
{}
```

---

## cy_fin_search_enforcement

Search CySEC enforcement actions — fines, suspensions, licence revocations, and public reprimands against regulated entities.

**Parameters:**

| Parameter     | Type   | Required | Description |
|---------------|--------|----------|-------------|
| `query`       | string | Yes      | Search query (e.g., firm name, breach type, `market abuse`) |
| `action_type` | string | No       | Filter by type: `fine`, `ban`, `restriction`, `warning` |
| `limit`       | number | No       | Maximum results (default 20, max 100) |

**Example:**
```json
{ "query": "market abuse", "action_type": "fine" }
```

---

## cy_fin_check_currency

Check whether a specific CySEC or CBC provision reference is currently in force. Returns status and effective date.

**Parameters:**

| Parameter   | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `reference` | string | Yes      | Provision reference (e.g., `DI87-01`, `C116`) |

**Example:**
```json
{ "reference": "DI87-01" }
```

---

## cy_fin_about

Return metadata about this MCP server: version, data source, and tool list.

**Parameters:** None

**Example:**
```json
{}
```

---

## cy_fin_list_sources

List the authoritative data sources used by this MCP server — CySEC and CBC — with URLs, descriptions, and license information.

**Parameters:** None

**Example:**
```json
{}
```

---

## cy_fin_check_data_freshness

Check data freshness for this MCP server. Returns the last ingest timestamp and current row counts for all collections.

**Parameters:** None

**Example:**
```json
{}
```

**Returns:**
```json
{
  "last_run": "2026-03-23T15:31:35.127Z",
  "row_counts": {
    "sourcebooks": 3,
    "provisions": 450,
    "enforcement_actions": 120
  },
  "_meta": { "..." }
}
```
