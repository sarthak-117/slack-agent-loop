# Cortex

A Slack-based AI agent that runs from your self-DM. Type `!cortex <task>` and it triages, executes, or delegates to any ACP-compatible coding agent.

```
You (Slack self-DM)
  └─ Cortex (Bedrock triage, ~3s polling)
       ├─ shell / file_read / file_write  (simple tasks, direct)
       ├─ spawn_agent                      (complex tasks, async fire-and-forget)
       └─ ACP session                      (interactive, bidirectional)
            ├─ Claude Code
            ├─ Codex CLI
            ├─ Kiro CLI
            └─ Any ACP-compatible agent
```

## Two Modes

**Async delegation** — Cortex spawns an agent in the background, reports back when done. Good for "refactor this module", "fix the build".

**Interactive ACP sessions** — Bidirectional conversation with a coding agent through a Slack thread. Streaming responses, tool call visibility, plan updates. Good for "help me debug this", "let's design this API".

## Prerequisites

- **Node.js** ≥ 18
- **AWS credentials** — default profile with `bedrock:InvokeModel` access
- **Slack Bot Token** — from [api.slack.com/apps](https://api.slack.com/apps)
- **An ACP-compatible agent** — Claude Code, Codex CLI, Kiro CLI, or any agent that supports [ACP](https://agentclientprotocol.com)

### Slack Bot Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Under **OAuth & Permissions**, add these scopes:
   - `chat:write` — post messages
   - `channels:history` — read messages in channels
   - `reactions:write` — add reactions
   - `im:history` — read DM messages
   - `im:write` — open DMs
3. Install to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`)
5. Find your Slack user ID: Profile → ⋮ → Copy member ID

## Setup

```bash
git clone https://github.com/youruser/cortex-core.git
cd cortex-core
npm install

cp .env.template .env
```

Edit `.env`:

```bash
# Required
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_USER_ID=U12345678

# Which coding agent to use for ACP sessions
AGENT_COMMAND=claude
# AGENT_ARGS=--dangerously-skip-permissions
# AGENT_CWD=~/projects

# Optional
# CORTEX_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0
# CORTEX_POLL_INTERVAL_MS=3000
# CORTEX_TRIGGER=!cortex
```

### Agent Examples

| Agent | AGENT_COMMAND | AGENT_ARGS |
|-------|--------------|------------|
| Claude Code | `claude` | `--dangerously-skip-permissions` |
| Codex CLI | `codex` | |
| Kiro CLI | `kiro-cli` | `acp --agent my-agent` |
| Custom | `/path/to/agent` | `--my-flags` |

## Run

```bash
npm start
```

You should see:

```
🧠 Cortex starting...
📬 Monitoring self-DM channel: D0123456789
⚡ Trigger: "!cortex" | Poll: 3000ms

🚀 Cortex is running. Type in your self-DM:
   !cortex <your command>
```

## Usage

Open your Slack self-DM and type:

### Direct tasks (Cortex handles via shell/file tools)

```
!cortex what's the git status of ~/myproject
!cortex read package.json and list the deps
!cortex run the tests and tell me what failed
```

### Interactive ACP sessions

```
!cortex chat ~/myproject
!cortex chat ~/myproject --host my-remote-server
```

Then just type in the thread — your messages go directly to the agent, responses stream back.

### In an ACP thread

```
help me debug the auth module          # regular prompt
$/model sonnet                         # $/ escapes slash commands
close                                  # end the session
```

### Checking sessions

```
!cortex sessions                       # list active ACP sessions
!cortex help                           # show all commands
```

## How It Works

1. **Polling** — Cortex calls `conversations.history` every 3s on your self-DM
2. **Detection** — Messages starting with `!cortex` are picked up as commands
3. **Triage** — Bedrock (Claude) decides: handle directly with tools, or delegate
4. **Execution** — Simple tasks use shell/file tools. Complex tasks spawn agents in the background. Interactive tasks use ACP sessions
5. **Response** — Results posted back to the Slack thread

### ACP (Agent Client Protocol)

[ACP](https://agentclientprotocol.com) is an open protocol (like LSP but for AI agents) that standardizes communication between clients and coding agents. Cortex uses ACP to connect to any compatible agent over stdio — structured JSON-RPC messages instead of screen-scraping.

When you start a `!cortex chat` session:
1. Cortex spawns your configured agent as a subprocess
2. Initializes an ACP connection (JSON-RPC over stdin/stdout)
3. Creates a session with your working directory
4. Routes your Slack messages as prompts, streams responses back
5. Handles agent callbacks (file reads/writes, terminal commands, permission requests)

## Project Structure

```
src/
├── app.ts          # Poll loop, command routing, Slack I/O
├── acp.ts          # ACP client — agent-agnostic, configurable
├── agent.ts        # Bedrock agent loop with tool calling
├── tools.ts        # shell, file_read, file_write, spawn_agent
├── tasks.ts        # Fire-and-forget task tracking
├── store.ts        # Conversation persistence (~/.cortex/conversations/)
├── config.ts       # Environment config
├── logger.ts       # Console logger
└── slack/
    └── api.ts      # Slack Web API (standard bot token)
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `SLACK_BOT_TOKEN is required` | Set it in `.env` |
| Slack 401 | Bot token expired — regenerate at api.slack.com |
| Bedrock access denied | Check IAM role has `bedrock:InvokeModel` |
| ACP session won't start | Verify your agent command works: `claude --version` |
| Agent exits immediately | Check agent logs, ensure it supports ACP |
| Slack rate limit (429) | Increase `CORTEX_POLL_INTERVAL_MS` to 5000 |
| Thread replies ignored | Type `close` and start a new thread |

## License

MIT
