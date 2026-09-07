# OrcSpace MCP

## Endpoint

All supported agents use the same MCP endpoint:

```text
http://127.0.0.1:20220/mcp
```

Supported clients: Codex, Claude Code, Cursor, Grok, Antigravity, Kimi Code, OpenCode, Windsurf, and Cline.

- `20220` is the unified OrcSpace backend for Control API and MCP.
- `20222` is the Renderer development server only.
- Do not open either address manually. OrcSpace configures agents automatically.
- Production builds do not use the Renderer development port.
- Never commit the generated `x-orcspace-token`.

## Tool workflow

1. Read first: use `list`, `status`, or `search` before making changes.
2. Use one stable `agentId` for the whole session.
3. Lock shared resources with `locks` before editing them.
4. Only delete or close things when explicitly requested.
5. Renew long-running locks with `locks:heartbeat`.
6. Use `read_journal` to review changes.

## Tools

`terminal` — open, send, read, and close terminals  
`terminal_permission` — terminal permissions  
`canvas` — widgets and camera  
`board` — shared task board  
`locks` — resource locks  
`plan` — personal task plan  
`git` — status and commits  
`read_journal` — action history
