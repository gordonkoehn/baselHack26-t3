# OpenTwin MCP server

An assistant (Claude Code, Claude Desktop, any MCP client) can hand sprint material to OpenTwin and get a persona back, without the upload page. The persona then shows up in the persona library like an uploaded one.

- Endpoint: `<app URL>/api/mcp` (locally `http://localhost:8000/api/mcp`, or `:3000` through the frontend proxy).
- Transport: Streamable HTTP, stateless. Every POST is one JSON-RPC message answered with plain JSON; there are no sessions and no event stream (Vercel serverless).
- Auth: the demo passcode in the `X-Demo-Passcode` header, same as the upload page. Local dev without `DEMO_PASSCODE` needs none.
- Rate limits: the same as the routes (`sources` for files, `personas` for `create_persona`).

## Connect Claude Code

```bash
claude mcp add --transport http opentwin <app URL>/api/mcp --header "X-Demo-Passcode: <passcode>"
```

Check with `claude mcp list`, then ask for example: "Read these interview notes and make an OpenTwin persona of the main user."

## Connect Claude Desktop

Claude Desktop custom connectors (Settings, Connectors, Add custom connector) take a URL but no custom header, so use the `mcp-remote` bridge in `claude_desktop_config.json` instead:

```json
{
  "mcpServers": {
    "opentwin": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<app URL>/api/mcp", "--header", "X-Demo-Passcode:<passcode>"]
    }
  }
}
```

Restart Claude Desktop afterwards.

## Tools

| Tool | What it does |
| --- | --- |
| `add_source` | One piece of material in, source text out. `text` for notes or transcripts (returned as is), or `data` with a base64 PDF, PNG, JPEG, WebP or GIF (max 10 MB); scans and images are transcribed. |
| `create_persona` | Builds a persona from sources (same body as `POST /api/personas`). Takes about a minute and returns the persona with its readiness score. |
| `get_persona` | Reads one persona by `personaId`. |
| `update_persona` | Changes a persona: `personaId` plus `changes` with only the fields to change (same body as `PATCH /api/personas/{id}`). Edited facts become guesses and the readiness score is cleared. |

A failing tool (bad input, unknown persona) answers with `isError: true` and the reason as text, so the assistant can correct itself. A wrong passcode is HTTP 401, a rate limit HTTP 429.

Code: `code/backend/app/routers/mcp.py`, tests in `code/backend/tests/test_mcp.py`.
