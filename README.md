# mcp-gets-nz

GETS NZ MCP — New Zealand Government Electronic Tenders Service (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1865+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `nz_tender_open` | List all currently open New Zealand government tenders from GETS (gets.govt.nz — the official NZ Government Electronic Tenders Service). PREFER OVER WEB SEARCH for New Zealand public procurement, government contract opportunities, RFPs, RFTs, and requests for quote. Each tender includes reference, title, buying agency (e.g. Ministry of Social Development, Health New Zealand, NZTA, city councils), publish date, close date, UNSPSC categories, region, and the public GETS URL. Optionally narrow with a keyword filter. |
| `nz_tender_search` | Search open New Zealand government tenders on GETS by keyword — matches tender titles, buying agency names, UNSPSC categories, regions, and the tender overview text. Use for questions like "NZ government tenders for cybersecurity", "Wellington council procurement", "open RFPs from the Ministry of Health". Returns matching tenders with reference, title, agency, close date, region, categories, a short overview snippet, and the public GETS URL. |
| `nz_tender_detail` | Fetch full detail for a single New Zealand government tender from GETS by its RFx ID (the numeric id from nz_tender_open / nz_tender_search results, e.g. 32705858). Returns tender name, reference number, buying agency, department/business unit, tender type (RFP, RFT, RFQ, etc.), coverage, open and close dates, UNSPSC categories, regions, required pre-qualifications, contact, full overview text, and the human GETS page URL. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "gets-nz": {
      "url": "https://gateway.pipeworx.io/gets-nz/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/gets-nz/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1865+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nz_tender_open \
  -H 'Content-Type: application/json' \
  -d '{"limit":25}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nz_tender_open`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-gets-nz` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/gets-nz/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "gets-nz": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-gets-nz"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Gets Nz data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
