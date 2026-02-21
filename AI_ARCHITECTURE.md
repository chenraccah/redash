# AI Query Builder — Architecture & Setup Guide

## Overview

The AI Query Builder lets users describe data they want to see in plain language. The system generates SQL queries, picks the best visualization (chart, table, counter), auto-executes the query, and renders the result — all inside a chat interface within Redash.

```
User (Browser)  -->  Redash Server (Railway)  -->  Cloudflare Tunnel  -->  Ollama (Local Mac)
                                |
                                v
                     PostgreSQL (Railway)  <--  Actual data queries
```

---

## Components

### 1. Ollama — Local LLM Inference

[Ollama](https://ollama.com) runs large language models locally. It exposes an OpenAI-compatible API at `http://localhost:11434/v1`.

**Model**: `qwen2.5-coder:14b` — a 14B parameter coding-focused model (~9GB). Chosen because:
- Fits in 32GB RAM (runs on Apple Silicon with Metal acceleration)
- Strong SQL generation ability (trained on code)
- Free — no API costs, no rate limits
- OpenAI-compatible API — drop-in replacement

**Starting Ollama**:
```bash
# Install
brew install ollama

# Pull the model (one-time, ~9GB download)
ollama pull qwen2.5-coder:14b

# Start the server
ollama serve
# or as a background service:
brew services start ollama
```

### 2. Cloudflare Tunnel — Bridging Local to Cloud

Redash runs on Railway (cloud) but Ollama runs on localhost. Cloudflare Tunnel creates a public HTTPS URL that forwards to the local Ollama server.

```bash
# Install
brew install cloudflared

# Start tunnel (free tier, URL changes on restart)
cloudflared tunnel --url http://localhost:11434 --ha-connections 1

# Output example:
# Your quick Tunnel has been created!
# https://exempt-abu-laid-kidney.trycloudflare.com
```

The tunnel URL is set as `REDASH_AI_LLM_BASE_URL` on Railway (with `/v1` suffix).

> **Note**: Free-tier tunnel URLs are temporary. After restarting cloudflared, update the Railway env var with the new URL.

### 3. Railway — Cloud Deployment

Five services run on Railway:

| Service | Role | Entrypoint |
|---------|------|------------|
| **server** | Redash web app (gunicorn) | `bin/docker-entrypoint server` |
| **worker** | RQ background job workers | `bin/docker-entrypoint worker` |
| **scheduler** | RQ job scheduler | `bin/docker-entrypoint scheduler` |
| **PostgreSQL** | Redash metadata database | Managed by Railway |
| **Redis** | Job queue + caching | Managed by Railway |

The `REDASH_SERVICE` environment variable tells each service its role, overriding the Dockerfile's default `CMD ["server"]`.

---

## Backend Architecture

### Request Flow

```
1. User types: "Show me revenue by month"

2. POST /api/ai/conversations/<id>/messages
   Body: { message: "Show me revenue by month", data_source_ids: [1] }

3. ai_assistant.py handler:
   a. Load data source(s) — name, description, schema (tables + columns + types)
   b. Build conversation history from stored messages
   c. Call ai_service.generate_response()

4. ai_service.py:
   a. format_schema_for_prompt() — convert schema to readable text
   b. build_messages() — inject system prompt with schema + rules + examples
   c. call_llm() — POST to Ollama via Cloudflare tunnel
   d. parse_llm_response() — extract SQL + visualization config from LLM output

5. Response returned to frontend:
   { sql: "SELECT ...", visualization: { type: "CHART", options: {...} } }

6. Frontend auto-executes SQL against the actual database via Redash's query runner

7. Frontend renders the chart using Redash's VisualizationRenderer component
```

### Key Files

#### `redash/services/ai_service.py`

The core AI service with these functions:

| Function | Purpose |
|----------|---------|
| `SYSTEM_PROMPT` | Detailed system prompt with schema placeholder, SQL rules, visualization format specs, Hebrew support, and 4 examples |
| `format_schema_for_prompt(schema)` | Converts Redash schema (tables/columns/types) + data source descriptions into LLM-readable text |
| `build_messages(conversation, schema, db_type)` | Assembles the chat messages array with system prompt and conversation history |
| `call_llm(messages)` | HTTP POST to Ollama's `/chat/completions` endpoint with retry logic (2 retries for connection errors and timeouts) |
| `parse_llm_response(content)` | Extracts ` ```sql ` and ` ```visualization ` blocks from LLM output, parses JSON, validates and auto-fixes visualization config |
| `_extract_sql_aliases(sql)` | Parses SQL SELECT clause to find column aliases — used to auto-fix chart columnMapping |
| `_try_fix_json(raw)` | Fixes common JSON issues from local models (trailing commas, single-line comments) |
| `generate_response(...)` | Main entry point that orchestrates the full pipeline |

#### `redash/handlers/ai_assistant.py`

API endpoints for the AI chat:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/ai/conversations` | GET | List user's conversations |
| `/api/ai/conversations` | POST | Create new conversation |
| `/api/ai/conversations/<id>` | GET | Get conversation with messages |
| `/api/ai/conversations/<id>` | DELETE | Archive conversation |
| `/api/ai/conversations/<id>/messages` | POST | Send message, get AI response |

The message handler:
- Fetches schema from all selected data sources (with fallback to cached schema if live fetch fails)
- Includes data source descriptions in the LLM context
- Stores full conversation history in PostgreSQL (JSON column)
- Auto-titles conversations from the first user message
- Supports multi-data-source queries (LLM specifies target with `-- DATA_SOURCE: <name>`)

#### `redash/models/__init__.py`

Database models:

- **AIConversation**: Stores chat sessions with `messages` (JSON), `data_source_ids`, `title`, `is_archived`
- **DataSource.description**: Free-text field for business context (e.g., "Insurance claims database — policies track coverage, claims track incidents")

### System Prompt Design

The system prompt is critical for local model quality. Key design decisions:

1. **Explicit alias rule**: Every SQL SELECT column must have `AS alias` — this ensures column names in the visualization config match the query output
2. **Visualization JSON format**: Strict format with examples for CHART, TABLE, and COUNTER types
3. **columnMapping enforcement**: The LLM must map aliases to "x" and "y" roles — if it doesn't, the parser auto-fixes from SQL aliases
4. **Language mirroring**: "Always respond in the SAME language the user writes in" — supports Hebrew and other languages
5. **Concise output**: "AT MOST one brief sentence of explanation" — prevents verbose local model responses
6. **Error correction**: When a query fails, the error is included in the next prompt for the LLM to fix
7. **Data source description**: Injected as `Description: ...` in the schema section so the LLM understands the business domain

### Auto-Fix Logic

Local models (unlike GPT-4) often produce imperfect output. The parser handles:

| Issue | Fix |
|-------|-----|
| Missing ` ```visualization ``` ` block | Default to TABLE visualization |
| Malformed JSON (trailing commas, comments) | `_try_fix_json()` cleans before parsing |
| Missing or incomplete columnMapping | `_extract_sql_aliases()` builds mapping from SQL |
| No "x" or "y" in columnMapping | Auto-assigns first alias as "x", rest as "y" |
| Unknown visualization type | Falls back to TABLE |
| Missing counterColName for COUNTER | Uses last SQL alias (usually the aggregate) |
| Chart with no valid mapping | Falls back to TABLE |

---

## Frontend Architecture

### Key Files

#### `client/app/pages/queries/QueryAI.jsx`

Main page component (registered at `/queries/ai`):

- **State**: data sources, selected IDs, conversation, messages, query results, executing flags, dashboard modal
- **Auto-execution**: When the LLM returns SQL, it immediately runs via `QueryResult.get()` against the actual database
- **Error auto-correction**: If the query fails, the error is automatically sent back to the LLM
- **Quick actions**: `doSend(text)` core function used by both input bar and quick action chips
- **Dashboard integration**: Modal with dashboard picker, uses `Dashboard.addWidget()` to add viz widgets

#### `client/app/components/ai-assistant/AssistantMessage.jsx`

Each AI response bubble:

- **Markdown rendering**: Strips SQL/viz blocks, converts code blocks, bold, line breaks
- **SQL panel**: Collapsible with copy button, editable textarea, "Run Edited Query" button
- **Visualization**: Rendered via Redash's native `VisualizationRenderer` with resizable container (drag handle, 150–800px)
- **Actions**: "Save Query" and "Add to Dashboard" buttons
- **Quick actions**: Context-aware suggestion chips based on visualization type

#### `client/app/components/ai-assistant/ChatHistorySidebar.jsx`

Conversation history sidebar with active highlighting, archive button, relative date formatting.

#### `client/app/services/ai-assistant.js`

API client for the AI endpoints (create/get/list conversations, send messages, archive).

### UI Features

| Feature | Description |
|---------|-------------|
| **Copy SQL** | One-click clipboard copy in the SQL panel header |
| **Animated typing dots** | 3 bouncing dots with staggered animation during LLM inference |
| **Resizable viz** | Drag handle below charts for height adjustment (150–800px) |
| **Quick action chips** | Context-aware suggestions: "Show as pie chart", "Add date filter", etc. |
| **Save & Add to Dashboard** | Save query + visualization, then pick a dashboard to add it to |
| **Multi-data-source** | Select multiple data sources; LLM specifies target with `-- DATA_SOURCE:` |
| **Error auto-correction** | Failed queries are automatically sent back to the LLM for fixing |
| **Hebrew support** | Chart titles, labels, and explanations match the user's language |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REDASH_AI_ASSISTANT_ENABLED` | `false` | Enable/disable the AI assistant |
| `REDASH_AI_LLM_BASE_URL` | `http://localhost:11434/v1` | Ollama API base URL (or Cloudflare tunnel URL + `/v1`) |
| `REDASH_AI_LLM_MODEL` | `qwen2.5-coder:14b` | Model name for Ollama |
| `REDASH_AI_LLM_API_KEY` | (empty) | Optional API key (Ollama doesn't need one, but proxies might) |
| `REDASH_AI_LLM_TEMPERATURE` | `0.1` | Low temperature for deterministic SQL generation |
| `REDASH_AI_LLM_MAX_TOKENS` | `2048` | Max response tokens |
| `REDASH_AI_LLM_TIMEOUT` | `120` | Request timeout in seconds (first inference is slow while model loads) |
| `REDASH_AI_MAX_SCHEMA_TABLES` | `50` | Max tables included in the LLM prompt per data source |
| `REDASH_AI_MAX_CONVERSATION_MESSAGES` | `20` | Max conversation history messages sent to the LLM |

---

## Database Schema

### ai_conversations table

```sql
CREATE TABLE ai_conversations (
    id SERIAL PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    data_source_id INTEGER REFERENCES data_sources(id),
    data_source_ids INTEGER[],
    query_id INTEGER REFERENCES queries(id),
    title VARCHAR(200) DEFAULT 'New Conversation',
    messages JSONB DEFAULT '[]',
    is_archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### data_sources.description column

```sql
ALTER TABLE data_sources ADD COLUMN description TEXT;
```

Used to store free-text business context for the AI assistant (e.g., "E-commerce database with orders, customers, and products").

---

## Setup from Scratch

### Local Development

```bash
# 1. Install and start Ollama
brew install ollama
ollama pull qwen2.5-coder:14b
ollama serve

# 2. Set environment variables
export REDASH_AI_ASSISTANT_ENABLED=true
export REDASH_AI_LLM_BASE_URL=http://localhost:11434/v1
export REDASH_AI_LLM_MODEL=qwen2.5-coder:14b

# 3. Run Redash (standard docker-compose setup)
docker-compose up

# 4. Navigate to /queries/ai
```

### Railway Deployment

```bash
# 1. Start Ollama locally
ollama serve

# 2. Start Cloudflare tunnel
cloudflared tunnel --url http://localhost:11434 --ha-connections 1
# Note the tunnel URL (e.g., https://xyz.trycloudflare.com)

# 3. Set Railway env vars
railway variables set REDASH_AI_ASSISTANT_ENABLED=true
railway variables set REDASH_AI_LLM_BASE_URL=https://xyz.trycloudflare.com/v1
railway variables set REDASH_AI_LLM_MODEL=qwen2.5-coder:14b
railway variables set REDASH_AI_LLM_TEMPERATURE=0.1
railway variables set REDASH_AI_LLM_TIMEOUT=120

# 4. Deploy
railway up --detach

# 5. Navigate to https://your-railway-url/queries/ai
```

### Switching Models

To use a different model:

```bash
# Pull a different model
ollama pull llama3:8b
# or
ollama pull codestral:latest

# Update the env var
export REDASH_AI_LLM_MODEL=llama3:8b
```

Any Ollama-compatible model works. Larger models (30B+) produce better results but need more RAM.

### Using a Cloud LLM Instead

To use OpenAI, Anthropic, or any OpenAI-compatible API instead of local Ollama:

```bash
export REDASH_AI_LLM_BASE_URL=https://api.openai.com/v1
export REDASH_AI_LLM_MODEL=gpt-4o
export REDASH_AI_LLM_API_KEY=sk-...
```

No code changes needed — the API format is the same.
