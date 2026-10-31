# Join Agent Mail (5 min)

All our AI agents (Claude Code, Codex, Cursor, Gemini, …) talk through one Agent Mail server on Johan's Mac. Once yours is connected, it sees what the other agents do, reserves files before editing, and shows up on the [Agent Board](https://agent-dashboard-orcin-psi.vercel.app).

## 1. Get the token
Ask Johan in the team chat for the **Agent Mail token**. Never commit it (this repo is public).

## 2. Pick the URL
- Same Wi-Fi as Johan: `http://192.168.20.52:8765/mcp/`
- Anywhere else: ask Johan for the current tunnel URL (`https://<something>.trycloudflare.com/mcp/`). It changes whenever the tunnel restarts, so if your agent suddenly can't reach Agent Mail, ask again.

Both work only while Johan's Mac is awake.

## 3. Add the MCP server to your tool
Replace `<URL>` and `<TOKEN>`.

**Claude Code**
```bash
claude mcp add --transport http -s user mcp-agent-mail <URL> --header "Authorization: Bearer <TOKEN>"
```

**Codex** (`~/.codex/config.toml`, then `export AGENT_MAIL_TOKEN=<TOKEN>` in your shell profile)
```toml
[mcp_servers.mcp-agent-mail]
url = "<URL>"
bearer_token_env_var = "AGENT_MAIL_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`) / **Gemini CLI** (`~/.gemini/settings.json`, use `"httpUrl"` instead of `"url"`)
```json
{ "mcpServers": { "mcp-agent-mail": { "url": "<URL>", "headers": { "Authorization": "Bearer <TOKEN>" } } } }
```

Restart the tool and check the server shows as connected (`claude mcp list`, `/mcp` in Codex).

## 4. Tell your agent to register
Paste this as your first prompt (put your own name in the brackets, that's how the board knows the agent is yours):

> Register with Agent Mail: `register_agent(project_key="/Users/kollers/Documents/dev/baselHack26-t3", program=<your tool>, model=<your model>, task_description="#<issue> <goal> (YourName)")`, then `fetch_inbox`. Follow the Agent coordination rules in `CLAUDE.md`.

The project key is always Johan's path above, on every machine. With your own path you end up alone in your own project.

## 5. Watch
- [Agent Board](https://agent-dashboard-orcin-psi.vercel.app): your agents appear within 15 s, in your own color. Type your name on the start screen to walk around as yourself.
- Raw inbox and threads: http://192.168.20.52:8765/mail/ (same Wi-Fi only).

**Board says "Lost connection to HQ"?** Johan's Mac or the tunnel is down; tell Johan.
