/**
 * Seed the CySEC/CBC database with sample provisions for testing.
 *
 * Inserts CySEC directives, circulars, and CBC prudential directives so MCP
 * tools can be tested without a full ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CYSEC_DB_PATH"] ?? "data/cysec.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// Sourcebooks

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "CYSEC_DIRECTIVES",
    name: "CySEC Directives",
    description:
      "Binding directives issued by the Cyprus Securities and Exchange Commission covering AIF managers, CIFs, investment firms, and market conduct.",
  },
  {
    id: "CYSEC_CIRCULARS",
    name: "CySEC Circulars",
    description:
      "CySEC circulars providing guidance on regulatory expectations, compliance requirements, and supervisory priorities for regulated entities.",
  },
  {
    id: "CBC_DIRECTIVES",
    name: "CBC Prudential Directives",
    description:
      "Prudential directives issued by the Central Bank of Cyprus covering capital adequacy, liquidity, and risk management for credit institutions.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// Sample provisions

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // CySEC Directives
  {
    sourcebook_id: "CYSEC_DIRECTIVES",
    reference: "DI87-01",
    title: "Directive DI87-01 — Conditions for Authorisation of AIFMs",
    text: "This Directive sets out the conditions for the authorisation of Alternative Investment Fund Managers (AIFMs) in Cyprus under the Alternative Investment Fund Managers Law 56(I)/2013, implementing Directive 2011/61/EU (AIFMD). AIFMs with assets under management exceeding €100 million (or €500 million where funds use no leverage and investors have no redemption rights for 5 years) must apply for authorisation from CySEC. The minimum initial capital requirement for an AIFM is €300,000, with an additional own funds requirement of 0.02% of the value of AUM exceeding €250 million, subject to a maximum of €10 million.",
    type: "Directive",
    status: "in_force",
    effective_date: "2014-07-22",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "CYSEC_DIRECTIVES",
    reference: "DI87-07",
    title: "Directive DI87-07 — Organisational Requirements for CIFs",
    text: "This Directive establishes organisational requirements for Cyprus Investment Firms (CIFs) authorised under the Investment Services and Activities and Regulated Markets Law 87(I)/2017, implementing MiFID II. CIFs must maintain robust governance arrangements including a clear organisational structure with well-defined lines of responsibility, effective risk management processes, internal audit, compliance, and an independent risk management function. The management body must include at least two executive and two non-executive members, and must collectively possess adequate knowledge, skills, and experience to understand the firm's activities and risks.",
    type: "Directive",
    status: "in_force",
    effective_date: "2018-01-03",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "CYSEC_DIRECTIVES",
    reference: "DI87-09",
    title: "Directive DI87-09 — Capital Adequacy Requirements for CIFs",
    text: "This Directive sets out capital adequacy requirements for Cyprus Investment Firms in accordance with Regulation (EU) 575/2013 (CRR) and Regulation (EU) 2019/2033 (IFR). CIFs must maintain a minimum capital requirement equal to the higher of the permanent minimum capital requirement (€75,000, €150,000, or €750,000 depending on the investment services authorised) or the sum of credit risk, market risk, and operational risk capital requirements. CIFs must report their capital positions to CySEC on a quarterly basis and notify CySEC immediately upon breach of any capital threshold.",
    type: "Directive",
    status: "in_force",
    effective_date: "2021-06-26",
    chapter: "3",
    section: "3.1",
  },
  {
    sourcebook_id: "CYSEC_DIRECTIVES",
    reference: "DI87-14",
    title: "Directive DI87-14 — Best Execution Requirements for CIFs",
    text: "This Directive details best execution obligations for CIFs when executing client orders. CIFs must take all sufficient steps to obtain the best possible result for clients when executing orders, considering price, costs, speed, likelihood of execution and settlement, size, nature, or any other relevant consideration. For retail clients, best execution is determined by the total consideration (price of the financial instrument plus costs related to execution). CIFs must establish and maintain an order execution policy and obtain prior client consent. The policy must be reviewed annually and whenever a material change occurs.",
    type: "Directive",
    status: "in_force",
    effective_date: "2018-01-03",
    chapter: "4",
    section: "4.1",
  },
  {
    sourcebook_id: "CYSEC_DIRECTIVES",
    reference: "DI87-16",
    title: "Directive DI87-16 — Market Abuse Prevention Requirements",
    text: "This Directive implements the requirements of Regulation (EU) 596/2014 (MAR) for persons subject to CySEC supervision. Regulated entities must establish effective systems and procedures to detect and report suspicious transactions and order cancellations. Issuers of financial instruments admitted to trading on a regulated market or MTF in Cyprus must disclose inside information to the public as soon as possible, and may delay such disclosure only where specified conditions are met. All persons discharging managerial responsibilities must notify CySEC and the issuer of every transaction in the issuer's instruments within three business days.",
    type: "Directive",
    status: "in_force",
    effective_date: "2016-07-03",
    chapter: "5",
    section: "5.1",
  },
  // CySEC Circulars
  {
    sourcebook_id: "CYSEC_CIRCULARS",
    reference: "C116",
    title: "Circular C116 — Client Money Rules",
    text: "CySEC Circular C116 provides guidance on the client money rules applicable to Cyprus Investment Firms. CIFs must hold client money in one or more client money accounts opened with an approved bank, credit institution, or qualifying money market fund. Client money must be segregated from the firm's own money at all times. CIFs must perform client money reconciliations on a daily basis and maintain adequate records of all client money held. External reconciliations must be conducted at least monthly. CIFs must have a written client money policy reviewed and approved by senior management at least annually.",
    type: "Circular",
    status: "in_force",
    effective_date: "2019-09-30",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "CYSEC_CIRCULARS",
    reference: "C292",
    title: "Circular C292 — Suitability Assessment Requirements",
    text: "CySEC Circular C292 clarifies the application of suitability and appropriateness assessment requirements under MiFID II. When providing investment advice or portfolio management, CIFs must collect sufficient information about the client's knowledge and experience in the relevant investment field, financial situation including the ability to bear losses, and investment objectives including risk tolerance. The suitability assessment must be documented in a suitability report provided to the client before the recommended transaction. For execution-only services, an appropriateness assessment is required for complex instruments.",
    type: "Circular",
    status: "in_force",
    effective_date: "2020-04-15",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "CYSEC_CIRCULARS",
    reference: "C347",
    title: "Circular C347 — AML/CFT Compliance Requirements",
    text: "CySEC Circular C347 sets out the Anti-Money Laundering and Counter-Financing of Terrorism obligations for CySEC-regulated entities under the Prevention and Suppression of Money Laundering and Terrorist Financing Laws. All regulated entities must implement risk-based customer due diligence procedures, maintain adequate transaction monitoring systems, appoint a qualified AML compliance officer, conduct regular staff training, and submit Suspicious Activity Reports to MOKAS without delay. CySEC will conduct thematic reviews of AML frameworks as part of its supervisory programme.",
    type: "Circular",
    status: "in_force",
    effective_date: "2021-11-01",
    chapter: "3",
    section: "3.1",
  },
  // CBC Prudential Directives
  {
    sourcebook_id: "CBC_DIRECTIVES",
    reference: "CBC/2014/1",
    title: "CBC Directive on Capital Requirements for Credit Institutions",
    text: "This Directive sets out the capital requirements framework for credit institutions authorised in Cyprus, implementing Regulation (EU) 575/2013 (CRR) and Directive 2013/36/EU (CRD IV). Credit institutions must maintain a Total Capital Ratio of at least 8%, a Tier 1 Capital Ratio of at least 6%, and a Common Equity Tier 1 (CET1) Ratio of at least 4.5% at all times. In addition to regulatory minima, credit institutions must maintain a Capital Conservation Buffer of 2.5% of total risk-weighted assets. The CBC may impose institution-specific Pillar 2 capital requirements following its Supervisory Review and Evaluation Process (SREP).",
    type: "Directive",
    status: "in_force",
    effective_date: "2014-01-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "CBC_DIRECTIVES",
    reference: "CBC/2015/3",
    title: "CBC Directive on Liquidity Requirements for Credit Institutions",
    text: "This Directive establishes liquidity requirements for credit institutions in Cyprus pursuant to the CRR and the Commission Delegated Regulation (EU) 2015/61. Credit institutions must maintain a Liquidity Coverage Ratio (LCR) of at least 100% at all times, ensuring they hold a sufficient buffer of high-quality liquid assets to survive a 30-day liquidity stress scenario. Credit institutions must also comply with the Net Stable Funding Ratio (NSFR) of at least 100%, requiring stable funding to cover assets and off-balance sheet activities over a one-year horizon. Monthly liquidity reporting to the CBC is mandatory.",
    type: "Directive",
    status: "in_force",
    effective_date: "2015-10-01",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "CBC_DIRECTIVES",
    reference: "CBC/2018/2",
    title: "CBC Directive on Non-Performing Loans Management",
    text: "This Directive establishes the framework for the management of non-performing loans (NPLs) by credit institutions in Cyprus. Credit institutions with NPL ratios above the supervisory threshold must prepare and submit NPL Reduction Plans to the CBC for approval. These plans must include specific NPL reduction targets, timelines, and strategies. Credit institutions must maintain adequate provisioning policies consistent with IFRS 9, apply enhanced monitoring for forborne exposures, and maintain dedicated NPL workout units for exposures above defined thresholds. Quarterly NPL reporting is mandatory for all credit institutions.",
    type: "Directive",
    status: "in_force",
    effective_date: "2018-09-30",
    chapter: "3",
    section: "3.1",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// Sample enforcement actions

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Tradenet Investments Ltd",
    reference_number: "2023-CYSEC-F0891",
    action_type: "fine",
    amount: 350_000,
    date: "2023-08-22",
    summary:
      "CySEC imposed a fine of €350,000 on Tradenet Investments Ltd for multiple violations of client money rules (Circular C116) and best execution obligations (Directive DI87-14). The investigation found that the firm had co-mingled client money with its own funds on several occasions and had failed to conduct the required daily client money reconciliations. Additionally, the firm had not maintained an adequate order execution policy and did not obtain prior client consent before executing orders outside a regulated market.",
    sourcebook_references: "C116, DI87-14",
  },
  {
    firm_name: "Aegean Capital Markets CIF Ltd",
    reference_number: "2022-CYSEC-S0234",
    action_type: "ban",
    amount: 200_000,
    date: "2022-05-10",
    summary:
      "CySEC suspended the authorisation of Aegean Capital Markets CIF Ltd and imposed a €200,000 fine following a supervisory examination that revealed serious deficiencies in the firm's AML/CFT framework (Circular C347) and suitability assessment procedures (Circular C292). The firm failed to conduct adequate customer due diligence, had no functioning transaction monitoring system, and had recommended complex financial products to retail clients without conducting suitability assessments. The firm's authorisation was suspended pending remediation of all identified deficiencies.",
    sourcebook_references: "C292, C347",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// Summary

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
