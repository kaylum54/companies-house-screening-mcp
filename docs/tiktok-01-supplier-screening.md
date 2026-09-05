# TikTok 1: set up the MCP and screen a supplier list

Target: Codex, Node.js 22+, companies-house-screening-mcp 0.4.0.
Allow 90 seconds for the edited video. Account registration and key creation happen before the recording; show those steps with the key hidden.

## What to say about installation

“You need an AI app that supports MCP, Node.js, and a free Companies House REST API key. Add this configuration to Codex, paste your key privately, and restart Codex. Codex runs the npx command and downloads the package for you.”

Do not say `npx install`: that is not this package's installation command. `npx -y companies-house-screening-mcp@latest` downloads and runs the server. It does not ask for a key, install itself into Codex, or start a standalone chat. The AI client supplies the key through its server configuration.

## Viewer steps

1. Install [Node.js](https://nodejs.org/) version 22 or newer and [Codex](https://developers.openai.com/codex/app/). Check `node --version` and `npm --version` in a terminal.
2. At the [Companies House developer portal](https://developer.company-information.service.gov.uk/), register/sign in, create a **Live** application, then create a **REST** API key. This is separate from a company's filing authentication code. The API is free; the AI app may have its own account requirements or fees.
3. In Codex, open **Settings → MCP servers → Add server** (labels may vary by app version). Choose **STDIO** and enter:

| Field | Value |
|---|---|
| Name | `companies-house` |
| Command | `npx` |
| Arguments, separate entries | `-y` and `companies-house-screening-mcp@latest` |
| Environment-variable name | `COMPANIES_HOUSE_API_KEY` |
| Environment-variable value | Your own REST API key, entered off-camera |

4. Save, restart the server or reopen Codex, and check `/mcp` for the connection. If your app does not expose these fields, add the equivalent TOML below to your user `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`). Preserve existing settings and servers.
5. Start a fresh task and paste the example prompt below. The first start may take a little longer while npx downloads the package. Approve tool calls if prompted.

```toml
[mcp_servers.companies-house]
command = "npx"
args = ["-y", "companies-house-screening-mcp@latest"]
startup_timeout_sec = 60

[mcp_servers.companies-house.env]
COMPANIES_HOUSE_API_KEY = "PASTE_YOUR_KEY_HERE"
```

If you use the Codex CLI, register the command without putting a credential in shell history:

```bash
codex mcp add companies-house -- npx -y companies-house-screening-mcp@latest
```

Then add the `[mcp_servers.companies-house.env]` block privately in your user config. Do not register the same name a second time if it already exists. Check `codex mcp list` or `/mcp` after restarting. The registration command configures Codex; the npx command runs when Codex starts the server.

These settings follow [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp/) and the locally installed `codex mcp add --help`. For Windows command-launch troubleshooting or other clients, use the [setup guide](getting-started.md). For a repeatable filmed take, pin the package argument to `companies-house-screening-mcp@0.4.0`; `@latest` follows the latest published release on future starts.

## First example: supplier review worksheet

Say: “Imagine procurement gives you a supplier list. We can bring the registered facts into one table and see what needs human follow-up.”

Use this **illustrative list**, not a claim that these businesses are your suppliers. It deliberately includes historical companies so the differences are visible. Live register results can change; rehearse on the day.

```text
This is an illustrative procurement workflow, not a real supplier list.

Screen these UK company numbers using screen_companies:
04138203
00000006
03782379

Return one row for every input with:
- company number and registered legal name
- registered status
- factual signals in plain English
- sections checked and any unavailable sections
- whether the information was cached and its age if available

Keep unresolved and not-screened entries visible. Do not score companies,
call them safe, approve suppliers, or infer fraud. Explain which registered
facts need human follow-up. Active registration does not prove current trading.
```

Follow-up:

```text
Get company_snapshot for 04138203. Explain the charge observations as
registered facts, not a debt balance or credit verdict. Show officer pagination
and explain whether the active-officer list is complete.
```

## Shot list and voiceover

| Time | Screen | Voiceover |
|---|---|---|
| 0–6s | The finished worksheet | “I built a free MCP that brings UK company-register checks into your AI assistant. Here's how to use it.” |
| 6–15s | Node version and developer portal, no key visible | “Install Node 22 or newer, then get a free Live REST API key from Companies House.” |
| 15–35s | Codex MCP settings with a placeholder key | “Add an STDIO server with this npx command and package argument. Put your own key in the environment field privately. Codex runs npx and downloads the server.” |
| 35–43s | Connector/tool list | “Restart Codex and check the Companies House tools are connected.” |
| 43–62s | Paste the three-company prompt, show tool execution | “Here is an illustrative supplier list. Ask for registered facts, the sections checked, and anything it could not check.” |
| 62–80s | Actual returned table, then snapshot if time allows | “This is a worksheet for follow-up. An active status isn't proof of trading, and a registered charge isn't automatically a problem.” |
| 80–90s | Repository link and setup guide | “The source and setup instructions are on GitHub. Copy the configuration and try it with your own confirmed company numbers.” |

Keep the real credential entirely outside the recording, not just briefly blurred. Use a separate placeholder copy for the configuration shot and set the actual key before recording the working client. Do not upload the real configuration file as a viewer download.

## Caption

I built an open-source Companies House MCP for UK company screening. This demo shows npx setup in Codex and an illustrative supplier worksheet. It reports register facts, missing checks and data freshness; it does not approve suppliers or authenticate invoices. Source and instructions: https://github.com/kaylum54/companies-house-screening-mcp

Contains public sector information licensed under the Open Government Licence v3.0. Personal data is outside that licence; avoid displaying unnecessary personal details.

## Before pressing record

- Check the published package version and run one successful lookup in the client you will show.
- Use three companies for a clear demonstration; do not promise every 50-company run finishes instantly.
- Keep ambiguous or incomplete output visible. Do not edit it into an apparent clean result.
- Show the actual tool response and lookup date. Label the list “illustrative example”.
- Put the GitHub setup link in your caption or profile where the platform allows it.

[General setup](getting-started.md) · [More business demos](business-demos.md)
