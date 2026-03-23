#!/usr/bin/env tsx
/**
 * CySEC ingestion crawler.
 *
 * Crawls the Cyprus Securities and Exchange Commission website (cysec.gov.cy)
 * and populates the local SQLite database with:
 *   - Directives (by category: investment firms, AIF, UCITS, issuers, etc.)
 *   - Circulars (general + per-entity-type: CIF, AIF, AML/CFT, CASP, RBSF, UCITS)
 *   - Board decisions / enforcement actions (English)
 *   - Administrative sanctions (Greek + English)
 *
 * The CySEC site is bilingual (Greek/English). Legislation pages are available
 * in English at /en-GB/... and some enforcement data (administrative sanctions)
 * is also available in Greek at /el-GR/... . This crawler fetches both.
 *
 * Circular detail pages (e.g. /en-GB/public-info/circulars/supervised/investment-firms/43312/)
 * are followed to extract the full circular text, not just listing titles.
 *
 * Usage:
 *   npx tsx scripts/ingest-cysec.ts                   # full crawl
 *   npx tsx scripts/ingest-cysec.ts --dry-run          # log what would be inserted
 *   npx tsx scripts/ingest-cysec.ts --resume            # skip already-stored items
 *   npx tsx scripts/ingest-cysec.ts --force             # drop DB and rebuild
 *   npx tsx scripts/ingest-cysec.ts --section circulars # only crawl circulars
 *   npx tsx scripts/ingest-cysec.ts --limit 50          # cap per-section item count
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env["CYSEC_DB_PATH"] ?? "data/cysec.db";
const STATE_PATH = resolve(__dirname, "../data/ingest-state.json");
const BASE_URL = "https://www.cysec.gov.cy";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ITEMS_PER_PAGE = 150; // CySEC supports 25, 50, 100, 150

// ─── CLI argument parsing ───────────────────────────────────────────────────

type Section = "directives" | "circulars" | "decisions" | "sanctions";

interface CliOptions {
  dryRun: boolean;
  resume: boolean;
  force: boolean;
  section: Section | "all";
  limit: number;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    dryRun: false,
    resume: false,
    force: false,
    section: "all",
    limit: 0,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "--section": {
        const val = args[++i] as Section | "all" | undefined;
        if (val && ["directives", "circulars", "decisions", "sanctions", "all"].includes(val)) {
          opts.section = val;
        } else {
          console.error(`Invalid --section value: ${val}`);
          process.exit(1);
        }
        break;
      }
      case "--limit": {
        const n = parseInt(args[++i] ?? "", 10);
        if (Number.isNaN(n) || n < 1) {
          console.error("--limit requires a positive integer");
          process.exit(1);
        }
        opts.limit = n;
        break;
      }
      case "--help":
        console.log(`Usage: npx tsx scripts/ingest-cysec.ts [options]

Options:
  --dry-run            Log actions without writing to DB
  --resume             Skip items already stored (by reference)
  --force              Drop and recreate the database
  --section <name>     Only crawl: directives | circulars | decisions | sanctions
  --limit <n>          Max items to ingest per section
  --verbose            Extra logging
  --help               Show this help`);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

// ─── State persistence (for --resume) ───────────────────────────────────────

interface IngestState {
  /** References already stored, keyed by section */
  completed: Record<string, Set<string>>;
  lastRun: string;
}

function loadState(): IngestState {
  if (existsSync(STATE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as {
        completed: Record<string, string[]>;
        lastRun: string;
      };
      const completed: Record<string, Set<string>> = {};
      for (const [k, v] of Object.entries(raw.completed)) {
        completed[k] = new Set(v);
      }
      return { completed, lastRun: raw.lastRun };
    } catch {
      // Corrupt state file -- start fresh
    }
  }
  return { completed: {}, lastRun: "" };
}

function saveState(state: IngestState): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const serialisable: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(state.completed)) {
    serialisable[k] = [...v];
  }
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ completed: serialisable, lastRun: state.lastRun }, null, 2),
  );
}

// ─── HTTP fetch with retry + rate limiting ──────────────────────────────────

let lastFetchTime = 0;

async function rateLimitedFetch(url: string): Promise<string> {
  const now = Date.now();
  const elapsed = now - lastFetchTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastFetchTime = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Ansvar-CySEC-Crawler/1.0 (compliance research; hello@ansvar.ai)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9,el;q=0.8",
        },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }

      return await res.text();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${lastError.message} -- waiting ${backoff}ms`);
        await sleep(backoff);
      }
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Date parsing helpers ───────────────────────────────────────────────────

const MONTH_MAP: Record<string, string> = {
  // English
  "jan": "01", "jan.": "01", "january": "01",
  "feb": "02", "feb.": "02", "february": "02",
  "mar": "03", "mar.": "03", "march": "03",
  "apr": "04", "apr.": "04", "april": "04",
  "may": "05", "may.": "05",
  "jun": "06", "jun.": "06", "june": "06",
  "jul": "07", "jul.": "07", "july": "07",
  "aug": "08", "aug.": "08", "august": "08",
  "sep": "09", "sep.": "09", "september": "09", "sept": "09", "sept.": "09",
  "oct": "10", "oct.": "10", "october": "10",
  "nov": "11", "nov.": "11", "november": "11",
  "dec": "12", "dec.": "12", "december": "12",
  // Greek month names and abbreviations (nominative + genitive forms)
  "ιαν": "01", "ιαν.": "01", "ιανουαρίου": "01", "ιανουάριος": "01",
  "φεβ": "02", "φεβ.": "02", "φεβρουαρίου": "02", "φεβρουάριος": "02",
  "μαρ": "03", "μαρ.": "03", "μαρτίου": "03", "μάρτιος": "03",
  "απρ": "04", "απρ.": "04", "απριλίου": "04", "απρίλιος": "04",
  "μαΐ": "05", "μαΐ.": "05", "μαΐου": "05", "μάιος": "05", "μάι": "05", "μάι.": "05",
  "ιουν": "06", "ιουν.": "06", "ιουνίου": "06", "ιούνιος": "06",
  "ιουλ": "07", "ιουλ.": "07", "ιουλίου": "07", "ιούλιος": "07",
  "αυγ": "08", "αυγ.": "08", "αυγούστου": "08", "αύγουστος": "08",
  "σεπ": "09", "σεπ.": "09", "σεπτεμβρίου": "09", "σεπτέμβριος": "09",
  "οκτ": "10", "οκτ.": "10", "οκτωβρίου": "10", "οκτώβριος": "10",
  "νοε": "11", "νοε.": "11", "νοεμβρίου": "11", "νοέμβριος": "11",
  "δεκ": "12", "δεκ.": "12", "δεκεμβρίου": "12", "δεκέμβριος": "12",
};

/**
 * Parse dates in formats like "18 Mar. 2026", "09 Σεπ. 2024", "01/02/2019",
 * "2024-01-15". Returns ISO date string (YYYY-MM-DD) or null.
 */
function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();

  // ISO format: 2024-01-15
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // DD/MM/YYYY
  const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const day = slashMatch[1]!.padStart(2, "0");
    const month = slashMatch[2]!.padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  // "DD Mon. YYYY" or "DD Mon YYYY" (English and Greek)
  const dmyMatch = text.match(/(\d{1,2})\s+([A-Za-zΑ-Ωα-ωίήύόέάώϊϋΐΰ.]+)\s+(\d{4})/);
  if (dmyMatch) {
    const day = dmyMatch[1]!.padStart(2, "0");
    const monthKey = dmyMatch[2]!.toLowerCase();
    const year = dmyMatch[3]!;
    const month = MONTH_MAP[monthKey];
    if (month) return `${year}-${month}-${day}`;
  }

  return null;
}

// ─── CySEC page crawlers ────────────────────────────────────────────────────

/** Directive category definition */
interface DirectiveCategory {
  sourcebookId: string;
  name: string;
  description: string;
  /** Index pages to crawl for this category */
  urls: string[];
}

/**
 * All directive/legislation categories on cysec.gov.cy.
 *
 * CySEC organises legislation by subject area. Each area has sub-pages for
 * main legislation, secondary legislation (directives), and sometimes
 * repealed frameworks. We crawl secondary-legislation pages for directives
 * and main-legislation pages for primary laws.
 *
 * URL structure:
 *   /en-GB/legislation/{area}/{sub-area}/
 *   /en-GB/legislation/{area}/{sub-area}/secondary-legislation/
 *   /en-GB/legislation/{area}/{sub-area}/main-legislation/
 */
const DIRECTIVE_CATEGORIES: DirectiveCategory[] = [
  {
    sourcebookId: "CYSEC_DIRECTIVES",
    name: "CySEC Directives",
    description:
      "Binding directives issued by the Cyprus Securities and Exchange Commission covering AIF managers, CIFs, investment firms, and market conduct.",
    urls: [
      // Investment services (MiFID II framework)
      "/en-GB/legislation/services-markets/epey/",
      "/en-GB/legislation/services-markets/epey/secondary-legislation/",
      "/en-GB/legislation/services-markets/epey/main-legislation/",
      // Collective investment — AIF
      "/en-GB/legislation/collective-investment/AIF/",
      "/en-GB/legislation/collective-investment/AIF/secondary-legislation/",
      // Collective investment — UCITS
      "/en-GB/legislation/collective-investment/UCITS/",
      "/en-GB/legislation/collective-investment/UCITS/secondary-legislation/",
      // Issuers
      "/en-GB/legislation/issuers/Pursuant-CSE-Law/",
      // Financial crimes (AML/CFT)
      "/en-GB/legislation/financial-crimes/",
      // Market manipulation (MAR)
      "/en-GB/legislation/market-manipulation/",
      // CySEC main legislation (CySEC Law)
      "/en-GB/legislation/cysec/main-legislation/",
      // Digital operational resilience (DORA)
      "/en-GB/legislation/resilience/",
      // PEPPs
      "/en-GB/legislation/pepps/",
      // Benchmarks (BMR)
      "/en-GB/legislation/benchmarks/",
      // PRIIPs
      "/en-GB/legislation/priips/",
      // Sanctions / restrictive measures
      "/en-GB/legislation/sanctions/",
      // Crowdfunding
      "/en-GB/legislation/crowdfunding/",
      // Crypto-Asset Service Providers (MiCA)
      "/en-GB/legislation/casp/",
    ],
  },
];

/**
 * Circular section definitions on cysec.gov.cy.
 * Paginated at ?page=N with configurable items-per-page.
 *
 * Each section lists circulars as links to detail pages at
 * /en-GB/public-info/circulars/supervised/{type}/{id}/
 * which contain the circular's full text, or as direct PDF links.
 */
interface CircularSection {
  label: string;
  path: string;
}

const CIRCULAR_SECTIONS: CircularSection[] = [
  { label: "General", path: "/en-GB/public-info/circulars/general/" },
  { label: "CIF", path: "/en-GB/public-info/circulars/supervised/investment-firms/" },
  { label: "AIF/AIFM", path: "/en-GB/public-info/circulars/supervised/aif/" },
  { label: "AML/CFT", path: "/en-GB/public-info/circulars/supervised/aml-cft/" },
  { label: "CASP", path: "/en-GB/public-info/circulars/supervised/casp-circulars/" },
  { label: "RBSF", path: "/en-GB/public-info/circulars/supervised/CIRCULARS-RBSF/" },
  { label: "UCITS", path: "/en-GB/public-info/circulars/supervised/ucits/" },
];

/**
 * Administrative sanctions year pages (Greek, structured by year).
 * CySEC publishes sanctions grouped by year under /el-GR/public-info/administrative-sanctions/.
 * We also crawl the English-language equivalent where available.
 */
const SANCTIONS_YEARS = [
  2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

// ─── Parsed item types ──────────────────────────────────────────────────────

interface ParsedDirective {
  reference: string;
  title: string;
  text: string;
  type: string;
  effectiveDate: string | null;
  chapter: string | null;
  section: string | null;
  sourceUrl: string;
}

interface ParsedCircular {
  reference: string;
  title: string;
  text: string;
  effectiveDate: string | null;
  circularSection: string;
  sourceUrl: string;
}

interface ParsedDecision {
  firmName: string;
  referenceNumber: string;
  actionType: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebookReferences: string;
  sourceUrl: string;
}

// ─── Reference extraction ───────────────────────────────────────────────────

/**
 * Extract a reference code from a directive/law title.
 *
 * CySEC uses patterns like:
 *   - "DI87-01", "DI87-07", "DI131-2014-05", "DI78-2012-18"
 *   - "L. 87(I)/2017", "Law 73(I)/2009"
 *   - "R.A.D. 295/2018"
 *   - "Directive 2011/61/EU"
 *   - "CBC/2014/1"
 *   - "C762", "C116" (circulars)
 */
function extractReference(title: string, fallbackIndex: number): string {
  // DI-style references: DI87-01, DI78-2012-03, DI131-2014-01, DI 124-01
  const diMatch = title.match(/\b(DI\s*[\d][\d\w-]+)/i);
  if (diMatch) return diMatch[1]!.replace(/\s+/g, "");

  // Law references: L. 87(I)/2017, Law 73(I)/2009, L.124(I)/2018
  const lawMatch = title.match(/\b(?:L\.|Law|Ν\.?)\s*([\d]+\([IΙ]+\)[/-]\d{4})/i);
  if (lawMatch) return `L.${lawMatch[1]}`;

  // R.A.D. references
  const radMatch = title.match(/\bR\.?A\.?D\.?\s*([\d/]+)/i);
  if (radMatch) return `RAD-${radMatch[1]!.replace(/\//g, "-")}`;

  // EU Regulation/Directive: Regulation (EU) 575/2013, Directive 2013/36/EU
  const euMatch = title.match(/(?:Regulation|Directive)\s*\(?EU\)?\s*([\d/]+)/i);
  if (euMatch) return `EU-${euMatch[1]!.replace(/\//g, "-")}`;

  // Circular-style references already in title: C116, C292, C762
  const circMatch = title.match(/\b(C\d{2,4})\b/);
  if (circMatch) return circMatch[1]!;

  // Fallback: first meaningful slug from title
  const slug = title
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
    .toLowerCase();
  return slug || `item-${fallbackIndex}`;
}

// ─── Directive crawling ─────────────────────────────────────────────────────

/**
 * Crawl a single directive category index page and extract items.
 *
 * CySEC legislation pages list items as chronological entries with
 * date + link (PDF or sub-page). We extract the title from the link text
 * and the date from surrounding text nodes.
 *
 * Detail pages (e.g. /en-GB/legislation/.../secondary-legislation/46407/) contain
 * the directive title and sometimes a brief description before the PDF link.
 * We follow these detail links to get more content when available.
 */
async function crawlDirectivePage(
  url: string,
  verbose: boolean,
): Promise<ParsedDirective[]> {
  const fullUrl = url.startsWith("http") ? url : `${BASE_URL}${url}`;
  if (verbose) console.log(`    Fetching ${fullUrl}`);

  let html: string;
  try {
    html = await rateLimitedFetch(fullUrl);
  } catch (err) {
    console.error(`    Failed to fetch ${fullUrl}: ${(err as Error).message}`);
    return [];
  }

  const $ = cheerio.load(html);
  const directives: ParsedDirective[] = [];

  // CySEC legislation pages list items in the main content area.
  // Links to documents use /CMSPages/GetFile.aspx?guid= pattern (PDFs).
  // Links to detail pages use /en-GB/legislation/.../{id}/ paths.
  const contentArea = $(".cms-editable-region, .content-area, .col-md-9, main, #content, .page-content, article")
    .first();
  const container = contentArea.length > 0 ? contentArea : $("body");

  // Collect detail page links for follow-up crawling
  const detailLinks: Array<{ href: string; linkText: string; dateCandidate: string | null; chapter: string | null }> = [];

  // Find all links within the content area
  container.find("a[href]").each((_idx, el) => {
    const $link = $(el);
    const href = $link.attr("href") ?? "";
    const linkText = $link.text().trim();

    // Skip navigation, empty, and non-content links
    if (!linkText || linkText.length < 5) return;
    if (href.startsWith("#") || href.startsWith("javascript:")) return;

    // PDF download links
    const isDocLink = href.includes("GetFile.aspx") || href.includes("CMSPages");
    // Detail page links: /en-GB/legislation/.../46407/
    const isDetailPage = /\/\d{4,6}\/?$/.test(href);
    // Sub-section index links (not detail pages)
    const isIndexLink = href.includes("/en-GB/legislation/") && !isDetailPage && !isDocLink;

    if (isIndexLink) return;
    if (!isDocLink && !isDetailPage) return;

    // Extract surrounding date text
    const parentText = $link.parent().text();
    const prevText = $link.prev().text?.() ?? "";
    const dateCandidate = parseDate(prevText) ?? parseDate(parentText);

    // Determine chapter/section from nearest section heading
    const sectionHeading = $link.closest("div, section, td, li").prevAll("h2, h3, h4, h5").first().text().trim();
    const chapter = sectionHeading || null;

    if (isDetailPage) {
      // Queue for follow-up crawl to get full content
      detailLinks.push({
        href: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        linkText,
        dateCandidate,
        chapter,
      });
    } else {
      // Direct PDF link -- use title as content
      const title = linkText.replace(/\s+/g, " ").trim();
      const reference = extractReference(title, _idx);

      let type = "Directive";
      if (/\bcircular\b/i.test(title)) type = "Circular";
      if (/\b(?:law|νόμος)\b/i.test(title)) type = "Law";
      if (/\b(?:regulation|κανονισμός)\b/i.test(title)) type = "Regulation";
      if (/\bguideline/i.test(title)) type = "Guideline";
      if (/\bR\.?A\.?D\b/i.test(title)) type = "Regulatory Administrative Directive";

      const sourceUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      directives.push({
        reference,
        title,
        text: title, // Full text requires PDF parsing -- title used as content
        type,
        effectiveDate: dateCandidate,
        chapter,
        section: null,
        sourceUrl,
      });
    }
  });

  // Follow detail page links to extract richer content
  for (const detail of detailLinks) {
    try {
      const detailHtml = await rateLimitedFetch(detail.href);
      const $d = cheerio.load(detailHtml);

      // Detail page title is in h1 or .page-title
      const pageTitle = $d("h1, .page-title").first().text().trim()
        || $d("title").text().replace(/\|.*$/, "").trim()
        || detail.linkText;

      // Content area on detail pages
      const detailContent = $d(".cms-editable-region, .content-area, .col-md-9, main, article").first();
      const contentContainer = detailContent.length > 0 ? detailContent : $d("body");

      // Extract all paragraph text from the detail page as the provision text
      const paragraphs: string[] = [];
      contentContainer.find("p, li").each((_i, el) => {
        const t = $d(el).text().trim();
        if (t.length > 10) paragraphs.push(t);
      });

      // If no paragraphs found, fall back to the full text content
      let fullText = paragraphs.length > 0
        ? paragraphs.join("\n\n")
        : contentContainer.text().replace(/\s+/g, " ").trim();

      // Truncate overly long text (some pages include navigation chrome)
      if (fullText.length > 10_000) {
        fullText = fullText.slice(0, 10_000) + "...";
      }
      if (fullText.length < 20) fullText = pageTitle;

      const title = pageTitle.replace(/\s+/g, " ").trim();
      const reference = extractReference(title, directives.length);

      let type = "Directive";
      if (/\bcircular\b/i.test(title)) type = "Circular";
      if (/\b(?:law|νόμος)\b/i.test(title)) type = "Law";
      if (/\b(?:regulation|κανονισμός)\b/i.test(title)) type = "Regulation";
      if (/\bguideline/i.test(title)) type = "Guideline";
      if (/\bR\.?A\.?D\b/i.test(title)) type = "Regulatory Administrative Directive";

      // Extract date from detail page if not already found
      const detailDate = detail.dateCandidate
        ?? parseDate(contentContainer.text());

      directives.push({
        reference,
        title,
        text: fullText,
        type,
        effectiveDate: detailDate,
        chapter: detail.chapter,
        section: null,
        sourceUrl: detail.href,
      });

      if (verbose) console.log(`      Detail: ${reference} -- ${title.slice(0, 60)}`);
    } catch (err) {
      // Fall back to listing data if detail page fetch fails
      const title = detail.linkText.replace(/\s+/g, " ").trim();
      directives.push({
        reference: extractReference(title, directives.length),
        title,
        text: title,
        type: "Directive",
        effectiveDate: detail.dateCandidate,
        chapter: detail.chapter,
        section: null,
        sourceUrl: detail.href,
      });
      if (verbose) console.warn(`      Detail fetch failed for ${detail.href}: ${(err as Error).message}`);
    }
  }

  return directives;
}

/**
 * Crawl all directive categories.
 */
async function crawlDirectives(
  opts: CliOptions,
  state: IngestState,
): Promise<ParsedDirective[]> {
  console.log("\n=== Phase 1: Directives & Legislation ===\n");

  const completedSet = state.completed["directives"] ?? new Set<string>();
  const all: ParsedDirective[] = [];
  const seen = new Set<string>();

  for (const category of DIRECTIVE_CATEGORIES) {
    console.log(`  Category: ${category.name}`);

    for (const url of category.urls) {
      const items = await crawlDirectivePage(url, opts.verbose);
      console.log(`    ${url} -- ${items.length} items found`);

      for (const item of items) {
        // Deduplicate by reference
        if (seen.has(item.reference)) continue;
        seen.add(item.reference);

        // Resume support
        if (opts.resume && completedSet.has(item.reference)) {
          if (opts.verbose) console.log(`      SKIP (resume): ${item.reference}`);
          continue;
        }

        all.push(item);
        if (opts.limit > 0 && all.length >= opts.limit) break;
      }
      if (opts.limit > 0 && all.length >= opts.limit) break;
    }
    if (opts.limit > 0 && all.length >= opts.limit) break;
  }

  console.log(`  Total directives collected: ${all.length}`);
  return all;
}

// ─── Circular crawling ──────────────────────────────────────────────────────

/**
 * Extract circular entries from a CySEC circulars listing page.
 *
 * Circulars are listed as date + linked title entries. Each links to either:
 *   1. A PDF via /CMSPages/GetFile.aspx?guid=...
 *   2. A detail page at /en-GB/public-info/circulars/supervised/{type}/{id}/
 *
 * Detail pages contain the circular's full text and a link to the PDF.
 * We collect both types and return detail page URLs for follow-up crawling.
 */
interface CircularListEntry {
  reference: string;
  title: string;
  effectiveDate: string | null;
  sourceUrl: string;
  detailUrl: string | null; // non-null if the listing links to a detail page
}

function parseCircularListPage($: cheerio.CheerioAPI): CircularListEntry[] {
  const entries: CircularListEntry[] = [];

  // Circulars appear as links in the main content area
  const contentArea = $(".cms-editable-region, .content-area, .col-md-9, main, #content, article").first();
  const container = contentArea.length > 0 ? contentArea : $("body");

  container.find("a[href]").each((_idx, el) => {
    const $link = $(el);
    const href = $link.attr("href") ?? "";
    const linkText = $link.text().trim();

    if (!linkText || linkText.length < 5) return;
    if (href.startsWith("#") || href.startsWith("javascript:")) return;

    const isPdfLink = href.includes("GetFile.aspx") || href.includes("CMSPages");
    // Detail pages: /en-GB/public-info/circulars/supervised/investment-firms/43312/
    const isDetailPage = /\/\d{4,6}\/?$/.test(href) && href.includes("/circulars/");

    if (!isPdfLink && !isDetailPage) return;

    // Extract circular number from title (e.g., "C762", "C116")
    const circNumMatch = linkText.match(/\b(C\d{2,4})\b/);
    const reference = circNumMatch ? circNumMatch[1]! : `CIRC-${_idx}`;

    // Extract surrounding date
    const parentText = $link.parent().text();
    const prevSiblingText = $link.prev().text?.() ?? "";
    const effectiveDate = parseDate(prevSiblingText) ?? parseDate(parentText);

    const sourceUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    entries.push({
      reference,
      title: linkText.replace(/\s+/g, " ").trim(),
      effectiveDate,
      sourceUrl,
      detailUrl: isDetailPage ? sourceUrl : null,
    });
  });

  return entries;
}

/**
 * Fetch a circular detail page and extract the full text.
 * Returns the body text of the circular or the title if extraction fails.
 */
async function fetchCircularDetail(
  url: string,
  fallbackTitle: string,
  verbose: boolean,
): Promise<string> {
  try {
    const html = await rateLimitedFetch(url);
    const $ = cheerio.load(html);

    const contentArea = $(".cms-editable-region, .content-area, .col-md-9, main, article").first();
    const container = contentArea.length > 0 ? contentArea : $("body");

    const paragraphs: string[] = [];
    container.find("p, li, td").each((_i, el) => {
      const t = $(el).text().trim();
      if (t.length > 15) paragraphs.push(t);
    });

    let text = paragraphs.length > 0
      ? paragraphs.join("\n\n")
      : container.text().replace(/\s+/g, " ").trim();

    // Truncate very long pages
    if (text.length > 10_000) {
      text = text.slice(0, 10_000) + "...";
    }

    if (text.length < 20) return fallbackTitle;

    if (verbose) console.log(`      Detail fetched: ${url} (${text.length} chars)`);
    return text;
  } catch (err) {
    if (verbose) console.warn(`      Detail fetch failed for ${url}: ${(err as Error).message}`);
    return fallbackTitle;
  }
}

/**
 * Extract total page count from CySEC pagination.
 *
 * Pagination text: "Displaying results 1-25 (of 635)"
 * Page links: ?page=1, ?page=2, ... ?page=N
 */
function extractPageCount($: cheerio.CheerioAPI, itemsPerPage: number): number {
  // Look for "of NNN" pattern in the page text
  const paginationText = $("body").text();
  const totalMatch = paginationText.match(/\(of\s+(\d+)\)/i)
    ?? paginationText.match(/\(από\s+(\d+)\)/i)
    ?? paginationText.match(/(\d+)\s+(?:αποτελέσματα|results)/i);

  if (totalMatch) {
    const total = parseInt(totalMatch[1]!, 10);
    return Math.ceil(total / itemsPerPage);
  }

  // Fallback: find highest page number in pagination links
  let maxPage = 1;
  $("a[href*='page=']").each((_idx, el) => {
    const href = $(el).attr("href") ?? "";
    const pageMatch = href.match(/page=(\d+)/);
    if (pageMatch) {
      const p = parseInt(pageMatch[1]!, 10);
      if (p > maxPage) maxPage = p;
    }
  });

  return maxPage;
}

/**
 * Crawl all circular sections with pagination.
 *
 * For each section, fetches the listing page(s) to collect circular entries,
 * then follows detail page links to extract the full circular text.
 */
async function crawlCirculars(
  opts: CliOptions,
  state: IngestState,
): Promise<ParsedCircular[]> {
  console.log("\n=== Phase 2: Circulars ===\n");

  const completedSet = state.completed["circulars"] ?? new Set<string>();
  const all: ParsedCircular[] = [];
  const seen = new Set<string>();

  for (const section of CIRCULAR_SECTIONS) {
    console.log(`  Section: ${section.label}`);

    // Fetch first page to discover total page count
    const firstUrl = `${BASE_URL}${section.path}?page=1&items=${ITEMS_PER_PAGE}`;
    let html: string;
    try {
      html = await rateLimitedFetch(firstUrl);
    } catch (err) {
      console.error(`    Failed to fetch ${firstUrl}: ${(err as Error).message}`);
      continue;
    }

    const $first = cheerio.load(html);
    const totalPages = extractPageCount($first, ITEMS_PER_PAGE);
    console.log(`    Total pages: ${totalPages}`);

    // Collect all listing entries across pages
    const allEntries: CircularListEntry[] = [];

    // Process first page
    const firstEntries = parseCircularListPage($first);
    allEntries.push(...firstEntries);
    console.log(`    Page 1: ${firstEntries.length} entries`);

    // Process remaining pages
    for (let page = 2; page <= totalPages; page++) {
      if (opts.limit > 0 && allEntries.length >= opts.limit * 2) break; // over-fetch for dedup

      const pageUrl = `${BASE_URL}${section.path}?page=${page}&items=${ITEMS_PER_PAGE}`;
      try {
        const pageHtml = await rateLimitedFetch(pageUrl);
        const $page = cheerio.load(pageHtml);
        const pageEntries = parseCircularListPage($page);
        allEntries.push(...pageEntries);

        if (opts.verbose) console.log(`    Page ${page}: ${pageEntries.length} entries`);
      } catch (err) {
        console.error(`    Page ${page} failed: ${(err as Error).message}`);
      }
    }

    // Deduplicate and apply resume/limit filters, then fetch detail pages
    for (const entry of allEntries) {
      if (seen.has(entry.reference)) continue;
      seen.add(entry.reference);

      if (opts.resume && completedSet.has(entry.reference)) {
        if (opts.verbose) console.log(`      SKIP (resume): ${entry.reference}`);
        continue;
      }

      // Fetch full text from detail page if available
      let text = entry.title;
      if (entry.detailUrl && !opts.dryRun) {
        text = await fetchCircularDetail(entry.detailUrl, entry.title, opts.verbose);
      }

      all.push({
        reference: entry.reference,
        title: entry.title,
        text,
        effectiveDate: entry.effectiveDate,
        circularSection: section.label,
        sourceUrl: entry.sourceUrl,
      });

      if (opts.limit > 0 && all.length >= opts.limit) break;
    }

    console.log(`    ${section.label} subtotal: ${all.length} circulars collected`);
    if (opts.limit > 0 && all.length >= opts.limit) break;
  }

  console.log(`  Total circulars collected: ${all.length}`);
  return all;
}

// ─── Board decisions crawling ───────────────────────────────────────────────

/**
 * Parse board decisions from the English decisions listing.
 *
 * Each decision entry has:
 *   - Announcement date (linked to PDF)
 *   - Board decision date
 *   - Regarding: firm name
 *   - Legislation: applicable law
 *   - Subject: decision type/details
 *
 * CySEC Board Decisions page: /en-GB/public-info/decisions/
 */
function parseDecisionPage($: cheerio.CheerioAPI): ParsedDecision[] {
  const decisions: ParsedDecision[] = [];
  const bodyText = $("body").text();

  // Decisions are structured as repeating blocks of:
  //   Announcement Date: [linked date]
  //   Board Decision Date: [date]
  //   Regarding: [firm]
  //   Legislation: [law]
  //   Subject: [description]

  // Split by "Announcement Date" markers
  const blocks = bodyText.split(/Announcement\s*Date\s*:/i);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i]!;

    // Extract announcement date
    const announceDateMatch = block.match(/^\s*([\d]{1,2}\s+[A-Za-z.]+\s+\d{4})/);
    const announceDate = announceDateMatch ? parseDate(announceDateMatch[1]) : null;

    // Extract board decision date
    const boardDateMatch = block.match(/Board\s*Decision\s*Date\s*:\s*([\d]{1,2}\s+[A-Za-z.]+\s+\d{4})/i);
    const boardDate = boardDateMatch ? parseDate(boardDateMatch[1]) : announceDate;

    // Extract firm name
    const firmMatch = block.match(/Regarding\s*:\s*(.+?)(?:\n|Board|Legislation|Subject|$)/i);
    const firmName = firmMatch ? firmMatch[1]!.trim() : "Unknown";

    // Extract legislation
    const legMatch = block.match(/Legislation\s*:\s*(.+?)(?:\n|Subject|Regarding|$)/i);
    const legislation = legMatch ? legMatch[1]!.trim() : "";

    // Extract subject
    const subjectMatch = block.match(/Subject\s*:\s*(.+?)(?:\n|Regarding|Announcement|Judicial|$)/i);
    const subject = subjectMatch ? subjectMatch[1]!.trim() : "";

    // Determine action type from subject
    let actionType = "decision";
    const subjectLower = subject.toLowerCase();
    if (subjectLower.includes("fine") || subjectLower.includes("penalty") || subjectLower.includes("πρόστιμο")) actionType = "fine";
    if (subjectLower.includes("withdrawal") || subjectLower.includes("revocation") || subjectLower.includes("ανάκληση")) actionType = "withdrawal";
    if (subjectLower.includes("suspension") || subjectLower.includes("suspended") || subjectLower.includes("αναστολή")) actionType = "suspension";
    if (subjectLower.includes("settlement") || subjectLower.includes("διευθέτηση")) actionType = "settlement";
    if (subjectLower.includes("ban") || subjectLower.includes("prohibition") || subjectLower.includes("απαγόρευση")) actionType = "ban";
    if (subjectLower.includes("warning") || subjectLower.includes("επίπληξη")) actionType = "warning";
    if (subjectLower.includes("restriction") || subjectLower.includes("περιορισμός")) actionType = "restriction";

    // Extract monetary amount from subject
    let amount: number | null = null;
    const amountMatch = subject.match(/[€$]\s*([\d,.]+)/);
    if (amountMatch) {
      amount = parseFloat(amountMatch[1]!.replace(/,/g, ""));
    }
    // Also try European-style amounts: 350.000 or 350.000,00
    if (amount === null) {
      const euroAmountMatch = subject.match(/€\s*([\d.]+(?:,\d{2})?)/);
      if (euroAmountMatch) {
        amount = parseFloat(euroAmountMatch[1]!.replace(/\./g, "").replace(",", "."));
      }
    }

    // Build reference number
    const year = boardDate?.slice(0, 4) ?? new Date().getFullYear().toString();
    const refNum = `DEC-${year}-${String(i).padStart(4, "0")}`;

    const summary = [subject, legislation].filter(Boolean).join(" -- ");

    decisions.push({
      firmName,
      referenceNumber: refNum,
      actionType,
      amount,
      date: boardDate,
      summary,
      sourcebookReferences: legislation,
      sourceUrl: `${BASE_URL}/en-GB/public-info/decisions/`,
    });
  }

  // Also try to extract decisions from detail page links
  // Detail links: /en-GB/public-info/decisions/{id}/
  const detailLinks: string[] = [];
  $("a[href]").each((_idx, el) => {
    const href = $(el).attr("href") ?? "";
    if (/\/decisions\/\d{4,6}/.test(href)) {
      const fullHref = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      detailLinks.push(fullHref);
    }
  });

  // Attach source URLs to decisions where possible
  for (let i = 0; i < Math.min(detailLinks.length, decisions.length); i++) {
    decisions[i]!.sourceUrl = detailLinks[i]!;
  }

  // Also attach PDF links
  $("a[href*='GetFile.aspx']").each((_idx, el) => {
    const href = $(el).attr("href") ?? "";
    if (href && _idx < decisions.length) {
      const existing = decisions[_idx];
      if (existing && existing.sourceUrl.includes("/decisions/")) {
        existing.sourceUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      }
    }
  });

  return decisions;
}

/**
 * Crawl board decisions with pagination.
 */
async function crawlDecisions(
  opts: CliOptions,
  state: IngestState,
): Promise<ParsedDecision[]> {
  console.log("\n=== Phase 3: Board Decisions ===\n");

  const completedSet = state.completed["decisions"] ?? new Set<string>();
  const all: ParsedDecision[] = [];
  const seen = new Set<string>();
  const basePath = "/en-GB/public-info/decisions/";

  // Fetch first page
  const firstUrl = `${BASE_URL}${basePath}?page=1&items=${ITEMS_PER_PAGE}`;
  let html: string;
  try {
    html = await rateLimitedFetch(firstUrl);
  } catch (err) {
    console.error(`  Failed to fetch decisions: ${(err as Error).message}`);
    return [];
  }

  const $first = cheerio.load(html);
  const totalPages = extractPageCount($first, ITEMS_PER_PAGE);
  console.log(`  Total pages: ${totalPages}`);

  // Process first page
  const firstItems = parseDecisionPage($first);
  for (const item of firstItems) {
    if (seen.has(item.referenceNumber)) continue;
    seen.add(item.referenceNumber);
    if (opts.resume && completedSet.has(item.referenceNumber)) continue;
    all.push(item);
  }
  console.log(`  Page 1: ${firstItems.length} decisions`);

  // Process remaining pages
  for (let page = 2; page <= totalPages; page++) {
    if (opts.limit > 0 && all.length >= opts.limit) break;

    const pageUrl = `${BASE_URL}${basePath}?page=${page}&items=${ITEMS_PER_PAGE}`;
    try {
      const pageHtml = await rateLimitedFetch(pageUrl);
      const $page = cheerio.load(pageHtml);
      const pageItems = parseDecisionPage($page);

      for (const item of pageItems) {
        if (seen.has(item.referenceNumber)) continue;
        seen.add(item.referenceNumber);
        if (opts.resume && completedSet.has(item.referenceNumber)) continue;
        all.push(item);
      }

      if (opts.verbose) console.log(`  Page ${page}: ${pageItems.length} decisions`);
    } catch (err) {
      console.error(`  Page ${page} failed: ${(err as Error).message}`);
    }
  }

  console.log(`  Total decisions collected: ${all.length}`);
  return all;
}

// ─── Administrative sanctions crawling (Greek + English) ────────────────────

/**
 * Parse administrative sanctions page (works with both Greek and English).
 *
 * CySEC publishes sanctions in yearly pages. Each page lists sanctions as
 * table rows or structured blocks with: firm name, entity type, decision
 * date, sanction amount, and violation description. PDFs are linked via
 * /CMSPages/GetFile.aspx?guid=...
 *
 * Entity type abbreviations (Greek):
 *   ΚΕΠΕΥ = CIF, ΔΟΕΕ = AIFM, ΟΣΕΚΑ = UCITS, ΔΕΕ = Management Company, ΕΔ = Tied Agent
 */
function parseSanctionsPage($: cheerio.CheerioAPI, pageLabel: string): ParsedDecision[] {
  const sanctions: ParsedDecision[] = [];

  // Entity type abbreviations used in Greek sanctions pages
  const entityTypeMap: Record<string, string> = {
    "ΚΕΠΕΥ": "CIF",
    "ΔΟΕΕ": "AIFM",
    "ΟΣΕΚΑ": "UCITS",
    "ΔΕΕ": "Management Company",
    "ΕΔ": "Tied Agent",
    "ΔΟΕΣ": "UCITS Management Company",
    "ΠΔΑΣΚ": "CASP",
  };

  // Try table rows first (most common format)
  $("table tr, .sanctions-row, .list-item").each((_idx, el) => {
    const $row = $(el);
    const cells = $row.find("td, .cell, span").toArray().map(c => $(c).text().trim());
    const rowText = $row.text().trim();

    if (cells.length < 3 && rowText.length < 10) return;
    // Skip header rows
    if (rowText.includes("Όνομα") || rowText.includes("Ημερομηνία") || rowText.includes("Name") || rowText.includes("Date")) return;

    // Extract firm name (first substantial text cell)
    let firmName = "";
    for (const cell of cells) {
      if (cell.length > 3 && !cell.match(/^\d/) && !cell.startsWith("€")) {
        firmName = cell;
        break;
      }
    }
    if (!firmName) firmName = rowText.split(/\||\t|\n/)[0]?.trim() ?? "";
    if (firmName.length < 3) return;

    // Extract entity type
    let entityType = "";
    for (const [greek, english] of Object.entries(entityTypeMap)) {
      if (rowText.includes(greek)) {
        entityType = english;
        break;
      }
    }

    // Extract date (Greek or English)
    const dateMatch = rowText.match(/(\d{1,2})\s+([Α-Ωα-ωίήύόέάώϊϋΐΰ.]+)\s+(\d{4})/)
      ?? rowText.match(/(\d{1,2})\s+([A-Za-z.]+)\s+(\d{4})/)
      ?? rowText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    let date: string | null = null;
    if (dateMatch) {
      if (dateMatch[2]!.match(/^\d+$/)) {
        // DD/MM/YYYY format
        date = `${dateMatch[3]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[1]!.padStart(2, "0")}`;
      } else {
        date = parseDate(`${dateMatch[1]} ${dateMatch[2]} ${dateMatch[3]}`);
      }
    }

    // Extract amount (European format: €350.000 or €350.000,00)
    let amount: number | null = null;
    const euroMatch = rowText.match(/€\s*([\d.]+(?:,\d{1,2})?)/);
    if (euroMatch) {
      amount = parseFloat(euroMatch[1]!.replace(/\./g, "").replace(",", "."));
    }

    // Extract GUID link for source document
    let sourceUrl = "";
    const $link = $row.find("a[href*='GetFile.aspx'], a[href*='decisions']").first();
    if ($link.length > 0) {
      const href = $link.attr("href") ?? "";
      sourceUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    }

    // Build reference
    const year = date?.slice(0, 4) ?? "XXXX";
    const refNum = `SANC-${year}-${String(_idx).padStart(4, "0")}`;

    // Extract violation summary (remaining text after known fields)
    const violation = rowText
      .replace(firmName, "")
      .replace(/€\s*[\d.,]+/, "")
      .replace(/\d{1,2}\s+[Α-Ωα-ωίήύόέάώϊϋΐΰ.]+\s+\d{4}/, "")
      .replace(/ΚΕΠΕΥ|ΔΟΕΕ|ΟΣΕΚΑ|ΔΕΕ|ΕΔ|ΔΟΕΣ|ΠΔΑΣΚ/g, "")
      .replace(/\s+/g, " ")
      .trim();

    sanctions.push({
      firmName: firmName.replace(/\s+/g, " "),
      referenceNumber: refNum,
      actionType: "administrative_sanction",
      amount,
      date,
      summary: entityType ? `[${entityType}] ${violation}`.trim() : violation,
      sourcebookReferences: "",
      sourceUrl: sourceUrl || `${BASE_URL}/en-GB/public-info/administrative-sanctions/`,
    });
  });

  // If table parsing yielded nothing, try text-block parsing (fallback)
  if (sanctions.length === 0) {
    const bodyText = $("body").text();
    const lines = bodyText.split("\n").map(l => l.trim()).filter(Boolean);
    let currentFirm = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Look for lines with euro amounts (strong indicator of a sanction entry)
      const amountMatch = line.match(/€\s*([\d.,]+)/);
      if (!amountMatch) continue;

      const amount = parseFloat(amountMatch[1]!.replace(/\./g, "").replace(",", "."));

      // Look backwards for firm name (typically 1-3 lines before the amount)
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const candidate = lines[j]!;
        if (candidate.length > 5 && !candidate.startsWith("€") && !/^\d+$/.test(candidate)) {
          currentFirm = candidate;
          break;
        }
      }

      // Extract date from surrounding lines
      let date: string | null = null;
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
        const d = parseDate(lines[j]!);
        if (d) { date = d; break; }
      }

      const year = date?.slice(0, 4) ?? "XXXX";
      const refNum = `SANC-${year}-${String(sanctions.length).padStart(4, "0")}`;

      sanctions.push({
        firmName: currentFirm || "Unknown",
        referenceNumber: refNum,
        actionType: "administrative_sanction",
        amount,
        date,
        summary: line.replace(/\s+/g, " ").trim(),
        sourcebookReferences: "",
        sourceUrl: `${BASE_URL}/el-GR/public-info/administrative-sanctions/`,
      });
    }
  }

  if (sanctions.length > 0) {
    console.log(`    ${pageLabel}: ${sanctions.length} sanctions parsed`);
  }

  return sanctions;
}

/**
 * Crawl administrative sanctions from both Greek and English pages.
 *
 * CySEC organises sanctions by year:
 *   Greek:   /el-GR/public-info/administrative-sanctions/ΔΙΟΙΚΗΤΙΚΕΣ-ΚΥΡΩΣΕΙΣ-{year}/
 *   English: /en-GB/public-info/administrative-sanctions/
 *
 * The main English page is also paginated with ?page=N.
 */
async function crawlSanctions(
  opts: CliOptions,
  state: IngestState,
): Promise<ParsedDecision[]> {
  console.log("\n=== Phase 4: Administrative Sanctions ===\n");

  const completedSet = state.completed["sanctions"] ?? new Set<string>();
  const all: ParsedDecision[] = [];
  const seen = new Set<string>();

  // --- Part A: English paginated sanctions listing ---
  console.log("  Part A: English administrative sanctions");
  const enBasePath = "/en-GB/public-info/administrative-sanctions/";
  const enFirstUrl = `${BASE_URL}${enBasePath}?page=1&items=${ITEMS_PER_PAGE}`;

  try {
    const html = await rateLimitedFetch(enFirstUrl);
    const $first = cheerio.load(html);
    const totalPages = extractPageCount($first, ITEMS_PER_PAGE);
    console.log(`    Total pages: ${totalPages}`);

    // Process first page
    const firstItems = parseSanctionsPage($first, "EN page 1");
    for (const item of firstItems) {
      const key = `${item.firmName}|${item.date}|${item.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (opts.resume && completedSet.has(item.referenceNumber)) continue;
      all.push(item);
    }

    // Process remaining pages
    for (let page = 2; page <= totalPages; page++) {
      if (opts.limit > 0 && all.length >= opts.limit) break;

      const pageUrl = `${BASE_URL}${enBasePath}?page=${page}&items=${ITEMS_PER_PAGE}`;
      try {
        const pageHtml = await rateLimitedFetch(pageUrl);
        const $page = cheerio.load(pageHtml);
        const pageItems = parseSanctionsPage($page, `EN page ${page}`);

        for (const item of pageItems) {
          const key = `${item.firmName}|${item.date}|${item.amount}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (opts.resume && completedSet.has(item.referenceNumber)) continue;
          all.push(item);
        }
      } catch (err) {
        console.error(`    EN page ${page} failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error(`  Failed to fetch EN sanctions: ${(err as Error).message}`);
  }

  console.log(`    English sanctions collected: ${all.length}`);

  // --- Part B: Greek year-based sanctions pages ---
  console.log("  Part B: Greek administrative sanctions (by year)");
  const enCountBefore = all.length;

  for (const year of SANCTIONS_YEARS) {
    if (opts.limit > 0 && all.length >= opts.limit) break;

    // Greek year pages use URL-encoded Greek text
    const yearPath = `/el-GR/public-info/administrative-sanctions/${encodeURIComponent(`ΔΙΟΙΚΗΤΙΚΕΣ-ΚΥΡΩΣΕΙΣ-${year}`)}/`;
    const yearUrl = `${BASE_URL}${yearPath}`;

    try {
      const html = await rateLimitedFetch(yearUrl);
      const $ = cheerio.load(html);
      const items = parseSanctionsPage($, `GR ${year}`);

      for (const item of items) {
        const key = `${item.firmName}|${item.date}|${item.amount}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (opts.resume && completedSet.has(item.referenceNumber)) continue;
        all.push(item);
      }
    } catch (err) {
      // Year page may not exist yet (future years) or may have different URL format
      if (opts.verbose) console.warn(`    GR ${year} page not available: ${(err as Error).message}`);
    }
  }

  console.log(`    Greek sanctions added: ${all.length - enCountBefore}`);
  console.log(`  Total sanctions collected: ${all.length}`);
  return all;
}

// ─── Database operations ────────────────────────────────────────────────────

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function upsertSourcebooks(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );

  const sourcebooks = [
    ...DIRECTIVE_CATEGORIES.map((c) => ({
      id: c.sourcebookId,
      name: c.name,
      description: c.description,
    })),
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

  const tx = db.transaction(() => {
    for (const sb of sourcebooks) {
      insert.run(sb.id, sb.name, sb.description);
    }
  });
  tx();
}

function insertDirectives(
  db: Database.Database,
  items: ParsedDirective[],
  dryRun: boolean,
): number {
  if (dryRun) {
    for (const item of items) {
      console.log(`  [DRY-RUN] Would insert directive: ${item.reference} -- ${item.title.slice(0, 80)}`);
    }
    return items.length;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO provisions
      (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const item of items) {
      const result = insert.run(
        "CYSEC_DIRECTIVES",
        item.reference,
        item.title,
        item.text,
        item.type,
        "in_force",
        item.effectiveDate,
        item.chapter,
        item.section,
      );
      if (result.changes > 0) count++;
    }
  });
  tx();
  return count;
}

function insertCirculars(
  db: Database.Database,
  items: ParsedCircular[],
  dryRun: boolean,
): number {
  if (dryRun) {
    for (const item of items) {
      console.log(`  [DRY-RUN] Would insert circular: ${item.reference} -- ${item.title.slice(0, 80)}`);
    }
    return items.length;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO provisions
      (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const item of items) {
      const result = insert.run(
        "CYSEC_CIRCULARS",
        item.reference,
        item.title,
        item.text,
        "Circular",
        "in_force",
        item.effectiveDate,
        item.circularSection,
        null,
      );
      if (result.changes > 0) count++;
    }
  });
  tx();
  return count;
}

function insertEnforcementActions(
  db: Database.Database,
  items: ParsedDecision[],
  dryRun: boolean,
): number {
  if (dryRun) {
    for (const item of items) {
      console.log(`  [DRY-RUN] Would insert enforcement: ${item.referenceNumber} -- ${item.firmName}`);
    }
    return items.length;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO enforcement_actions
      (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const item of items) {
      const result = insert.run(
        item.firmName,
        item.referenceNumber,
        item.actionType,
        item.amount,
        item.date,
        item.summary,
        item.sourcebookReferences,
      );
      if (result.changes > 0) count++;
    }
  });
  tx();
  return count;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  const state = opts.resume ? loadState() : { completed: {}, lastRun: "" };

  console.log("CySEC Ingestion Crawler v1.1");
  console.log(`  Database:  ${DB_PATH}`);
  console.log(`  Mode:      ${opts.dryRun ? "DRY-RUN" : opts.force ? "FORCE (rebuild)" : opts.resume ? "RESUME" : "FULL"}`);
  console.log(`  Section:   ${opts.section}`);
  if (opts.limit > 0) console.log(`  Limit:     ${opts.limit} per section`);
  console.log(`  Rate:      ${RATE_LIMIT_MS}ms between requests`);

  const db = opts.dryRun ? null : initDb(opts.force);
  if (db) upsertSourcebooks(db);

  const shouldRun = (s: Section) => opts.section === "all" || opts.section === s;

  let totalDirectives = 0;
  let totalCirculars = 0;
  let totalDecisions = 0;
  let totalSanctions = 0;

  // Phase 1: Directives
  if (shouldRun("directives")) {
    const directives = await crawlDirectives(opts, state);
    if (db) {
      totalDirectives = insertDirectives(db, directives, false);
    } else {
      totalDirectives = insertDirectives(null as unknown as Database.Database, directives, true);
    }
    // Update state
    if (!state.completed["directives"]) state.completed["directives"] = new Set();
    for (const d of directives) state.completed["directives"]!.add(d.reference);
  }

  // Phase 2: Circulars
  if (shouldRun("circulars")) {
    const circulars = await crawlCirculars(opts, state);
    if (db) {
      totalCirculars = insertCirculars(db, circulars, false);
    } else {
      totalCirculars = insertCirculars(null as unknown as Database.Database, circulars, true);
    }
    if (!state.completed["circulars"]) state.completed["circulars"] = new Set();
    for (const c of circulars) state.completed["circulars"]!.add(c.reference);
  }

  // Phase 3: Board Decisions
  if (shouldRun("decisions")) {
    const decisions = await crawlDecisions(opts, state);
    if (db) {
      totalDecisions = insertEnforcementActions(db, decisions, false);
    } else {
      totalDecisions = insertEnforcementActions(null as unknown as Database.Database, decisions, true);
    }
    if (!state.completed["decisions"]) state.completed["decisions"] = new Set();
    for (const d of decisions) state.completed["decisions"]!.add(d.referenceNumber);
  }

  // Phase 4: Administrative Sanctions (Greek + English)
  if (shouldRun("sanctions")) {
    const sanctions = await crawlSanctions(opts, state);
    if (db) {
      totalSanctions = insertEnforcementActions(db, sanctions, false);
    } else {
      totalSanctions = insertEnforcementActions(null as unknown as Database.Database, sanctions, true);
    }
    if (!state.completed["sanctions"]) state.completed["sanctions"] = new Set();
    for (const s of sanctions) state.completed["sanctions"]!.add(s.referenceNumber);
  }

  // Save resume state
  state.lastRun = new Date().toISOString();
  saveState(state);

  // Print summary
  if (db) {
    const provisionCount = (db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }).cnt;
    const sourcebookCount = (db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }).cnt;
    const enforcementCount = (db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }).cnt;
    const ftsCount = (db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }).cnt;

    console.log("\n=== Summary ===\n");
    console.log(`  Directives inserted:     ${totalDirectives}`);
    console.log(`  Circulars inserted:      ${totalCirculars}`);
    console.log(`  Decisions inserted:      ${totalDecisions}`);
    console.log(`  Sanctions inserted:      ${totalSanctions}`);
    console.log();
    console.log(`  Database totals:`);
    console.log(`    Sourcebooks:           ${sourcebookCount}`);
    console.log(`    Provisions:            ${provisionCount}`);
    console.log(`    Enforcement actions:   ${enforcementCount}`);
    console.log(`    FTS entries:           ${ftsCount}`);

    db.close();
  } else {
    console.log("\n=== Dry-run Summary ===\n");
    console.log(`  Directives found:   ${totalDirectives}`);
    console.log(`  Circulars found:    ${totalCirculars}`);
    console.log(`  Decisions found:    ${totalDecisions}`);
    console.log(`  Sanctions found:    ${totalSanctions}`);
  }

  console.log(`\nState saved to ${STATE_PATH}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
