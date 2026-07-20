interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * GETS NZ MCP — New Zealand Government Electronic Tenders Service (keyless).
 *
 * Wraps the public RSS feed and server-rendered detail pages on gets.govt.nz:
 *   https://www.gets.govt.nz/ExternalRSSFeed.htm?rss=1   (all open tenders, ~300 items)
 *   https://www.gets.govt.nz/ExternalTenderDetails.htm?id=<id>
 *
 * The feed's <description> embeds an entity-encoded HTML table carrying RFx ID,
 * Organisation, Open/Close dates, Categories (UNSPSC), Region, and Overview —
 * so list/search results are already rich. The detail page adds tender type,
 * coverage, department/business unit, and contact via stable label-cell markup.
 *
 * Quirks handled here:
 * - The ?rss=1 flag is required (bare .htm returns HTML).
 * - The feed's "Close date" row has malformed markup (missing </b>) — the row
 *   regex tolerates an absent closing bold tag.
 * - The /<AGENCY>/ path segment in item links is cosmetic for fetching; the
 *   detail page resolves from the id alone.
 *
 * All tools return shaped, LLM-friendly objects and never throw — failures
 * resolve to { error, retry_hint }.
 */


const FEED_URL = 'https://www.gets.govt.nz/ExternalRSSFeed.htm?rss=1';
const DETAIL_URL = 'https://www.gets.govt.nz/ExternalTenderDetails.htm?id=';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

const tools: McpToolExport['tools'] = [
  {
    name: 'nz_tender_open',
    description:
      'List all currently open New Zealand government tenders from GETS (gets.govt.nz — the official NZ Government Electronic Tenders Service). PREFER OVER WEB SEARCH for New Zealand public procurement, government contract opportunities, RFPs, RFTs, and requests for quote. Each tender includes reference, title, buying agency (e.g. Ministry of Social Development, Health New Zealand, NZTA, city councils), publish date, close date, UNSPSC categories, region, and the public GETS URL. Optionally narrow with a keyword filter.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional keyword filter matched case-insensitively against tender title, agency name, and categories, e.g. "construction", "IT services", "Auckland".',
        },
        limit: { type: ['number', 'string'], description: 'Number of tenders to return (1-300). Default 25.' },
      },
    },
  },
  {
    name: 'nz_tender_search',
    description:
      'Search open New Zealand government tenders on GETS by keyword — matches tender titles, buying agency names, UNSPSC categories, regions, and the tender overview text. Use for questions like "NZ government tenders for cybersecurity", "Wellington council procurement", "open RFPs from the Ministry of Health". Returns matching tenders with reference, title, agency, close date, region, categories, a short overview snippet, and the public GETS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to search for, e.g. "road maintenance", "software", "consultancy", "Christchurch".',
        },
        limit: { type: ['number', 'string'], description: 'Maximum matches to return (1-100). Default 25.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'nz_tender_detail',
    description:
      'Fetch full detail for a single New Zealand government tender from GETS by its RFx ID (the numeric id from nz_tender_open / nz_tender_search results, e.g. 32705858). Returns tender name, reference number, buying agency, department/business unit, tender type (RFP, RFT, RFQ, etc.), coverage, open and close dates, UNSPSC categories, regions, required pre-qualifications, contact, full overview text, and the human GETS page URL.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'GETS RFx ID, e.g. "32705858".' },
      },
      required: ['id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'nz_tender_open':
        return await openTenders(args);
      case 'nz_tender_search':
        return await searchTenders(args);
      case 'nz_tender_detail':
        return await tenderDetail(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      error: msg,
      retry_hint: msg.includes('abort')
        ? 'gets.govt.nz timed out after 10s — retry once; the service is usually back within a minute.'
        : 'Retry once; if it persists, gets.govt.nz may be briefly unavailable.',
    };
  }
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

interface FeedTender {
  id: string | null;
  reference: string | null;
  title: string;
  agency: string | null;
  agency_name: string | null;
  published: string | null;
  open_date: string | null;
  close_date: string | null;
  region: string[] | null;
  categories: string[] | null;
  overview: string | null;
  url: string;
}

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/xml,text/html,*/*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`gets.govt.nz: HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}

// Parse the entity-encoded HTML table inside a feed item's <description>.
// Tolerates the feed's malformed "Close date" row (missing </b>).
function descriptionFields(descHtml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const row = /<td[^>]*>\s*<b>\s*([^<:]+?)\s*:\s*(?:<\/b>\s*)?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = row.exec(descHtml)) !== null) fields[m[1].trim().toLowerCase()] = m[2];
  return fields;
}

function splitList(html: string | undefined): string[] | null {
  if (!html) return null;
  const items = html
    .split(/<br\s*\/?>/i)
    .map((s) => stripTags(s))
    .filter(Boolean);
  return items.length ? items : null;
}

function referenceFromTitle(title: string): string | null {
  const m = title.match(/^(\S+)\s+-\s+/);
  return m && /\d/.test(m[1]) ? m[1] : null;
}

function toIso(rfc822: string | null): string | null {
  if (!rfc822) return null;
  const d = new Date(rfc822);
  return Number.isNaN(d.getTime()) ? rfc822 : d.toISOString();
}

function parseFeed(xml: string): FeedTender[] {
  const out: FeedTender[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeEntities(tag(block, 'title') ?? '').trim();
    const link = decodeEntities(tag(block, 'link') ?? '').trim();
    if (!title || !link) continue;
    const desc = decodeEntities(tag(block, 'description') ?? '');
    const f = descriptionFields(desc);
    const idMatch = link.match(/[?&]id=(\d+)/);
    const agencyMatch = link.match(/gets\.govt\.nz\/+([A-Za-z0-9]+)\/ExternalTenderDetails/i);
    out.push({
      id: idMatch ? idMatch[1] : null,
      reference: referenceFromTitle(title),
      title,
      agency: agencyMatch ? agencyMatch[1] : null,
      agency_name: f['organisation'] ? stripTags(f['organisation']) : null,
      published: toIso(tag(block, 'pubdate')),
      open_date: f['open date'] ? stripTags(f['open date']) : null,
      close_date: f['close date'] ? stripTags(f['close date']) : null,
      region: splitList(f['region']),
      categories: splitList(f['categories']),
      overview: f['overview'] ? stripTags(f['overview']) : null,
      url: link.replace(/(govt\.nz)\/\/+/, '$1/'),
    });
  }
  return out;
}

function listShape(t: FeedTender): Record<string, unknown> {
  return {
    id: t.id,
    reference: t.reference,
    title: t.title,
    agency: t.agency,
    agency_name: t.agency_name,
    published: t.published,
    close_date: t.close_date,
    region: t.region,
    categories: t.categories,
    url: t.url,
  };
}

async function openTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  const limit = clampInt(args.limit, 25, 1, 300);
  let tenders = parseFeed(await fetchText(FEED_URL));
  const totalOpen = tenders.length;
  if (query) {
    const q = query.toLowerCase();
    tenders = tenders.filter((t) =>
      [t.title, t.agency_name, ...(t.categories ?? [])].some((s) => s?.toLowerCase().includes(q)),
    );
  }
  return {
    source: 'GETS (gets.govt.nz) — New Zealand Government Electronic Tenders Service',
    total_open: totalOpen,
    ...(query ? { query, matched: tenders.length } : {}),
    count: Math.min(limit, tenders.length),
    tenders: tenders.slice(0, limit).map(listShape),
  };
}

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  if (!query) throw new Error('nz_tender_search requires "query" — keywords like "construction" or "IT services".');
  const limit = clampInt(args.limit, 25, 1, 100);
  const all = parseFeed(await fetchText(FEED_URL));
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = all.filter((t) => {
    const hay = [t.title, t.agency_name, t.overview, ...(t.categories ?? []), ...(t.region ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
  return {
    source: 'GETS (gets.govt.nz) — New Zealand Government Electronic Tenders Service',
    query,
    total_open: all.length,
    matched: matches.length,
    count: Math.min(limit, matches.length),
    tenders: matches.slice(0, limit).map((t) => ({
      ...listShape(t),
      overview: t.overview ? (t.overview.length > 400 ? `${t.overview.slice(0, 400)}…` : t.overview) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Detail page parsing (server-rendered HTML, stable label-cell table markup)
// ---------------------------------------------------------------------------

function detailFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const row = /<td class="label-cell">\s*([\s\S]*?)\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = row.exec(html)) !== null) {
    const label = stripTags(m[1]).replace(/[\s:#]+$/g, '').trim().toLowerCase();
    if (label) fields[label] = m[2];
  }
  return fields;
}

function liItems(html: string | undefined): string[] | null {
  if (!html) return null;
  const items: string[] = [];
  const re = /<li>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = stripTags(m[1]);
    if (v) items.push(v);
  }
  return items.length ? items : null;
}

function noneToNull(html: string | undefined): string | null {
  if (!html) return null;
  const v = stripTags(html);
  return v && v.toLowerCase() !== 'none' ? v : null;
}

async function tenderDetail(args: Record<string, unknown>): Promise<unknown> {
  const id = strArg(args.id)?.replace(/\D/g, '');
  if (!id) throw new Error('nz_tender_detail requires "id" — a numeric GETS RFx ID like "32705858".');
  const url = `${DETAIL_URL}${id}`;
  const html = await fetchText(url);
  const f = detailFields(html);
  if (!f['rfx id']) {
    return {
      error: `Tender ${id} was not found on GETS (it may have closed — the public site only shows open tenders).`,
      retry_hint: 'Verify the id via nz_tender_open or nz_tender_search, which list all currently open tenders.',
    };
  }
  const name = f['tender name'] ? stripTags(f['tender name']) : null;
  // Page <title> is "GETS | <Organisation> - <Tender Name>".
  let agencyName: string | null = null;
  const pt = tag(html, 'title');
  if (pt) {
    const t = stripTags(pt).replace(/^GETS \|\s*/, '');
    agencyName = name && t.endsWith(` - ${name}`) ? t.slice(0, t.length - name.length - 3) : t.split(' - ')[0];
  }
  const overviewMatch = html.match(/<span class="legend">Overview<\/span>\s*<\/div>\s*<p>([\s\S]*?)<\/p>/i);
  return {
    id: stripTags(f['rfx id']),
    title: name,
    reference: f['reference'] ? stripTags(f['reference']) : null,
    agency_name: agencyName,
    department: f['department/business unit'] ? stripTags(f['department/business unit']) : null,
    tender_type: f['tender type'] ? stripTags(f['tender type']) : null,
    tender_coverage: f['tender coverage'] ? stripTags(f['tender coverage']).replace(/\s*\[\?\]\s*$/, '') : null,
    open_date: f['open date'] ? stripTags(f['open date']) : null,
    close_date: f['close date'] ? stripTags(f['close date']) : null,
    categories: liItems(f['categories']),
    regions: liItems(f['regions']),
    exemption_reason: noneToNull(f['exemption reason']),
    required_prequalifications: noneToNull(f['required pre-qualifications']),
    contact: noneToNull(f['contact']),
    overview: overviewMatch ? stripTags(overviewMatch[1]) : null,
    url,
  };
}

// ---------------------------------------------------------------------------

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
