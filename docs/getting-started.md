# Get your first result

The MCP supplies register facts to an AI client. It does not include an AI chat app. The source and Companies House public API are free; your chosen client may have account requirements or fees.

## Local setup

1. Install Node.js 22 or newer. Check `node --version` and `npm --version` in a terminal.
2. Create a Live application and a REST key at the [Companies House developer portal](https://developer.company-information.service.gov.uk/). This is an API key, not a company's authentication code.
3. In a client supporting stdio MCP, add the JSON configuration from the [README](../README.md#local-your-own-key-no-hosting). Keep the key private.
4. Restart the client or reconnect the server. Confirm that `find_company` and `company_snapshot` appear in its tool list.
5. Ask: “Look up company 04138203 using company_snapshot. Show its registered name and status, the sections checked, and the age of the data. Do not give it a risk score.” Expect structured company information, including `company_number`, `signals`, `sections_included` and `meta`.

For Claude Desktop, open Settings → Developer → Edit Config to locate its MCP JSON configuration. Merge the README's `mcpServers` entry into the existing configuration rather than replacing unrelated servers. Restart Desktop. Interface labels can change; use [Claude's local MCP guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) if the menu differs.

For Claude Code, `claude mcp add-json companies-house '<the server object>'` accepts the object containing `command`, `args` and `env` from the README (without the outer `mcpServers` wrapper). Prefer editing a private configuration file when entering a key so it does not remain in shell history. See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

These are configuration instructions, not claims that every current client version has been manually tested. The repository tests exercise the compiled stdio process and both HTTP transports through MCP clients. Host UI compatibility should be checked on the version you use.

## Codex

Use the [Codex setup and first demo](tiktok-01-supplier-screening.md) for STDIO fields, a TOML configuration and a key-free CLI registration command. Codex uses `[mcp_servers.companies-house]` in `~/.codex/config.toml`, rather than the Claude JSON wrapper above. See [official OpenAI MCP guidance](https://developers.openai.com/codex/mcp/).

## Windows

If the client cannot find `npx`, use `npx.cmd` or its absolute installed path. If the client cannot launch `.cmd` files directly, follow that client's Windows process-launch guidance. Do not put your key in command-line arguments. Restart the client after installing Node so it gets the updated PATH.

If `npm --version` fails with a missing `npm-cli.js`, that is a Node/npm installation problem before the MCP starts. Repair your Node installation or use an intact installation; changing the API key will not help.

## Docker alternative

With Docker installed, configure your client to run `docker` with these arguments and the same environment variable:

```json
{
  "command": "docker",
  "args": ["run", "--rm", "-i", "-e", "COMPANIES_HOUSE_API_KEY", "ghcr.io/kaylum54/companies-house-screening-mcp"],
  "env": {"COMPANIES_HOUSE_API_KEY": "your_key"}
}
```

Use `-i` without `-t`: a TTY interferes with stdio protocol framing. The image must be available to your Docker installation; building locally is covered by the Dockerfile.

## Remote setup

Obtain an actual HTTPS `/mcp` URL from your operator. There is no public URL advertised here. In a remote-capable client, add that URL as an MCP connector. In Claude Code:

```bash
claude mcp add --transport http companies-house https://YOUR-HOST/mcp
```

Claude web/mobile needs a remote service because it cannot spawn your local Node process. Connector availability depends on the host account and client. Operators should follow [deployment](deployment.md), [rate limits](rate-limits.md) and [observability](observability.md). A public launch needs a real deployed endpoint and a live tool-call check, not just `/health`.

## Troubleshooting

| Symptom | Next step |
|---|---|
| Command not found | Check Node 22+, PATH and the client command. |
| Startup configuration error | Check the variable is exactly `COMPANIES_HOUSE_API_KEY` in the server environment. |
| `AUTH_INVALID` | Check that the key is a current REST key for Live. |
| `INVALID_COMPANY_NUMBER` | Search by name first; confirm the returned company number. |
| No text when launched in a terminal | Stdio waits for an MCP client; it is not an interactive CLI. |
| `RATE_LIMITED` or `not_screened` | Follow the retry guidance or use a smaller list. |
| A section is unavailable | Treat its checks as unknown and retry; do not read empty signals as approval. |
| Hosted connection failure | Follow the `/health`, initialize and tool-call checks in the deployment guide. |

Try the [sample list](../examples/supplier-list.csv) and [business demos](business-demos.md) once connected. The MCP does not read CSV files itself: paste the company numbers or let a file-capable host read them.
