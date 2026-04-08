# Cypriot Financial Regulation MCP

**Cypriot financial regulation data for AI compliance tools.**

[![npm version](https://badge.fury.io/js/%40ansvar%2Fcypriot-financial-regulation-mcp.svg)](https://www.npmjs.com/package/@ansvar/cypriot-financial-regulation-mcp)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Query Cypriot financial regulation data -- regulations, decisions, and requirements from CySEC (Cyprus Securities and Exchange Commission) -- directly from Claude, Cursor, or any MCP-compatible client.

Built by [Ansvar Systems](https://ansvar.eu) -- Stockholm, Sweden

---

## Quick Start

### Use Remotely (No Install Needed)

> Connect directly to the hosted version -- zero dependencies, nothing to install.

**Endpoint:** `https://mcp.ansvar.eu/cypriot-financial-regulation/mcp`

| Client | How to Connect |
|--------|---------------|
| **Claude.ai** | Settings > Connectors > Add Integration > paste URL |
| **Claude Code** | `claude mcp add cypriot-financial-regulation-mcp --transport http https://mcp.ansvar.eu/cypriot-financial-regulation/mcp` |
| **Claude Desktop** | Add to config (see below) |
| **GitHub Copilot** | Add to VS Code settings (see below) |

**Claude Desktop** -- add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cypriot-financial-regulation-mcp": {
      "type": "url",
      "url": "https://mcp.ansvar.eu/cypriot-financial-regulation/mcp"
    }
  }
}
```

**GitHub Copilot** -- add to VS Code `settings.json`:

```json
{
  "github.copilot.chat.mcp.servers": {
    "cypriot-financial-regulation-mcp": {
      "type": "http",
      "url": "https://mcp.ansvar.eu/cypriot-financial-regulation/mcp"
    }
  }
}
```

### Use Locally (npm)

```bash
npx @ansvar/cypriot-financial-regulation-mcp
```

**Claude Desktop** -- add to `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cypriot-financial-regulation-mcp": {
      "command": "npx",
      "args": ["-y", "@ansvar/cypriot-financial-regulation-mcp"]
    }
  }
}
```

**Cursor / VS Code:**

```json
{
  "mcp.servers": {
    "cypriot-financial-regulation-mcp": {
      "command": "npx",
      "args": ["-y", "@ansvar/cypriot-financial-regulation-mcp"]
    }
  }
}
```

---

## Available Tools (8)

| Tool | Description |
|------|-------------|
| `cy_fin_search_regulations` | Full-text search across CySEC and CBC regulatory provisions. Returns matching directives, circulars, and prudential directives. |
| `cy_fin_get_regulation` | Get a specific CySEC or CBC provision by sourcebook and reference (e.g., sourcebook `CYSEC_DIRECTIVES`, reference `DI87-01`). |
| `cy_fin_list_sourcebooks` | List all CySEC and CBC sourcebook collections with their names and descriptions. |
| `cy_fin_search_enforcement` | Search CySEC enforcement actions — fines, suspensions, licence revocations, and public reprimands against regulated entities. |
| `cy_fin_check_currency` | Check whether a specific CySEC or CBC provision reference is currently in force. Returns status and effective date. |
| `cy_fin_about` | Return metadata about this MCP server: version, data source, tool list. |
| `cy_fin_list_sources` | List authoritative data sources (CySEC and CBC) with URLs, descriptions, and license information. |
| `cy_fin_check_data_freshness` | Check data freshness: last ingest timestamp and row counts for all collections. |

All tools return structured data with source references and timestamps.

---

## Data Sources and Freshness

All content is sourced from official Cypriot regulatory publications:

- **CySEC (Cyprus Securities and Exchange Commission)** -- Official regulatory authority

### Data Currency

- Database updates are periodic and may lag official publications
- Freshness checks run via GitHub Actions workflows
- Last-updated timestamps in tool responses indicate data age

See [COVERAGE.md](COVERAGE.md) and [TOOLS.md](TOOLS.md) for full provenance and tool documentation.

---

## Security

This project uses multiple layers of automated security scanning:

| Scanner | What It Does | Schedule |
|---------|-------------|----------|
| **CodeQL** | Static analysis for security vulnerabilities | Weekly + PRs |
| **Semgrep** | SAST scanning (OWASP top 10, secrets, TypeScript) | Every push |
| **Gitleaks** | Secret detection across git history | Every push |
| **Trivy** | CVE scanning on filesystem and npm dependencies | Daily |
| **Docker Security** | Container image scanning + SBOM generation | Daily |
| **Socket.dev** | Supply chain attack detection | PRs |
| **Dependabot** | Automated dependency updates | Weekly |

See [SECURITY.md](SECURITY.md) for the full policy and vulnerability reporting.

---

## Important Disclaimers

### Not Regulatory Advice

> **THIS TOOL IS NOT REGULATORY OR LEGAL ADVICE**
>
> Regulatory data is sourced from official publications by CySEC (Cyprus Securities and Exchange Commission). However:
> - This is a **research tool**, not a substitute for professional regulatory counsel
> - **Verify all references** against primary sources before making compliance decisions
> - **Coverage may be incomplete** -- do not rely solely on this for regulatory research

**Before using professionally, read:** [DISCLAIMER.md](DISCLAIMER.md) | [PRIVACY.md](PRIVACY.md)

### Confidentiality

Queries go through the Claude API. For privileged or confidential matters, use on-premise deployment. See [PRIVACY.md](PRIVACY.md) for details.

---

## Development

### Setup

```bash
git clone https://github.com/Ansvar-Systems/cypriot-financial-regulation-mcp
cd cypriot-financial-regulation-mcp
npm install
npm run build
npm test
```

### Running Locally

```bash
npm run dev                                       # Start MCP server
npx @anthropic/mcp-inspector node dist/index.js   # Test with MCP Inspector
```

### Data Management

```bash
npm run seed     # Seed SQLite database with sample data
npm run ingest   # Run full ingest from CySEC/CBC websites
```

---

## Related Projects

This server is part of **Ansvar's MCP fleet** -- 276 MCP servers covering law, regulation, and compliance across 119 jurisdictions.

### Law MCPs

Full national legislation for 108 countries. Example: [@ansvar/swedish-law-mcp](https://github.com/Ansvar-Systems/swedish-law-mcp) -- 2,415 Swedish statutes with EU cross-references.

### Sector Regulator MCPs

National regulatory authority data for 29 EU/EFTA countries across financial regulation, data protection, cybersecurity, and competition. This MCP is one of 116 sector regulator servers.

### Domain MCPs

Specialized compliance domains: [EU Regulations](https://github.com/Ansvar-Systems/EU_compliance_MCP), [Security Frameworks](https://github.com/Ansvar-Systems/security-frameworks-mcp), [Automotive Cybersecurity](https://github.com/Ansvar-Systems/Automotive-MCP), [OT/ICS Security](https://github.com/Ansvar-Systems/ot-security-mcp), [Sanctions](https://github.com/Ansvar-Systems/Sanctions-MCP), and more.

Browse the full fleet at [mcp.ansvar.eu](https://mcp.ansvar.eu).

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

### Data Licenses

Regulatory data sourced from official government publications. See [COVERAGE.md](COVERAGE.md) for per-source details.

---

## About Ansvar Systems

We build AI-powered compliance and legal research tools for the European market. Our MCP fleet provides structured, verified regulatory data to AI assistants -- so compliance professionals can work with accurate sources instead of guessing.

**[ansvar.eu](https://ansvar.eu)** -- Stockholm, Sweden

---

<p align="center">
  <sub>Built with care in Stockholm, Sweden</sub>
</p>
