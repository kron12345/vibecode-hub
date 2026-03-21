# VibCode Hub

**AI-powered developer team portal** -- orchestrate autonomous AI agents that turn your ideas into working code.

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)
![Angular](https://img.shields.io/badge/Angular-21-dd0031)
![NestJS](https://img.shields.io/badge/NestJS-11-ea2845)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-336791)

---

## What is VibCode Hub?

VibCode Hub is a self-hosted web portal where you act as the "team lead" and AI agents work as your development team. You describe what you want to build through a chat interface, and a pipeline of 10 specialized agents -- from interviewing your requirements to writing code, reviewing it, testing it, and documenting it -- collaboratively delivers working software. All code and issues are managed through your own GitLab instance, giving you full ownership and traceability of everything the agents produce.

> **Built with AI Vibecoding.** This project was developed collaboratively between a human developer and AI coding assistants (Claude Code). While every effort is made to ensure quality and security, please review the [Security Notice](#security-notice) below.

---

## Features

### Agent Pipeline (10 Specialized Roles)
- **Interviewer** -- Conducts structured interviews to gather project requirements and feature specifications
- **Architect** -- Designs technical architecture, analyzes existing code, grounds issues with implementation details
- **Issue Compiler** -- Transforms interview results into structured GitLab issues with milestones and sub-issues
- **Coder** -- Implements code via MCP agent loop (reads/writes/edits files autonomously), creates branches and merge requests
- **Code Reviewer** -- Reviews merge request diffs for quality, security, and pattern compliance
- **Functional Tester** -- Verifies acceptance criteria with build/test execution via MCP shell access
- **UI Tester** -- Tests layout, responsiveness, accessibility (WCAG 2.1 AA), with optional Playwright screenshots and multimodal visual analysis
- **Pen Tester** -- Runs security analysis with semgrep, trivy, nuclei, nmap, npm audit, and OWASP Top 10 review
- **Documenter** -- Generates and maintains README, API docs, changelogs, and GitLab Wiki pages (including screenshot galleries)
- **DevOps** -- Sets up projects (CI/CD, .gitignore, initial docs, wiki scaffolding) and provides persistent infrastructure command mode

### Multi-LLM Support (8 Providers)
- **Local**: Ollama (optimized for dual RTX 3090 / 48 GB VRAM setups)
- **Cloud API**: Anthropic Claude, OpenAI, Google Gemini
- **CLI Tools**: Claude Code, Codex CLI, Gemini CLI, Qwen3 Coder
- **Dual-Testing**: Run two providers in parallel with merge, consensus, or enrich strategies
- **Presets**: Switch all agent roles between "Local (Ollama)" and "CLI (Cloud)" with one click
- **Multimodal**: Image analysis support for UI testing (provider-specific format conversion)

### GitLab Integration
- Automatic repository creation and deletion
- Two-way issue sync with status labels
- Merge request tracking and CI/CD pipeline feedback loops
- Webhook support (issue, note, pipeline, merge_request events)
- Wiki as primary project knowledge base (wiki-first architecture)
- GitLab CI runner integration (Docker executor)

### Real-Time Communication
- WebSocket-powered terminal-style chat per project
- Token-by-token LLM streaming with live cursor
- Hardware monitoring dashboard (GPU, CPU, RAM -- 3-second push)
- Agent activity log streaming

### Voice Chat (Optional)
- Push-to-talk voice input via Faster-Whisper STT (GPU-accelerated)
- Auto-TTS for agent responses via configurable TTS engine
- Full pipeline: Mic -> STT -> Chat Flow -> TTS -> Audio

### Session-Based Development
- **Infrastructure Chat**: Project setup interview -> DevOps -> persistent "YOLO mode" for infrastructure commands
- **Dev Sessions**: Isolated git worktrees per session, feature interview -> full pipeline -> merge back
- Three-tier architecture: Infrastructure (permanent) -> Dev Sessions (active branches) -> Archive (merged, read-only)

### Additional Features
- **Role-based access control** via Keycloak SSO (admin, project-manager, developer, viewer)
- **Internationalization** -- German, English, Italian, French (easily extensible)
- **Dual theme** -- Dark mode (glass morphism) and light mode (frosted glass, Vision Pro-inspired)
- **Settings UI** -- All configuration managed through the web interface, secrets AES-256-GCM encrypted
- **MCP Server Registry** -- 16 built-in MCP servers, custom server support, per-project overrides
- **Loop Resolver** -- Detects and breaks stuck fix loops by analyzing root causes via LLM
- **Expectation Pattern** -- Anti-loop protocol for testing agents with structured fix expectations
- **Pipeline controls** -- Configurable timeouts, fix attempt limits, stuck task cleanup, pause/resume
- **Swagger/OpenAPI** documentation at `/api/docs`

---

## Screenshots

<!-- Screenshots coming soon -->

---

## Architecture Overview

```
                         +---------------------------+
                         |    Nginx Reverse Proxy     |
                         |  (TLS, routing, previews)  |
                         +-----+-------------+-------+
                               |             |
                    +----------v--+    +-----v--------+
                    |   Angular   |    |    NestJS     |
                    |  Frontend   |<-->|    Backend    |
                    |   :4200     | WS |    :3100      |
                    +-------------+ +  +---+---+---+---+
                                  REST |   |   |   |
                    +-----------------+|   |   |   +------------------+
                    |                   |   |   |                     |
             +------v------+    +------v---v--+------+    +----------v---------+
             |  PostgreSQL  |    |     GitLab CE      |    |    LLM Providers    |
             |    :5432     |    |      :8929         |    |  Ollama (local)     |
             |   (Prisma)   |    |  (API v4 + Wiki)   |    |  Anthropic, OpenAI  |
             +-------------+    +--------------------+    |  Google, CLI Tools  |
                                                          +--------------------+
             +-------------+    +--------------------+
             |  Keycloak   |    |    MCP Servers      |
             |   :8081     |    |  filesystem, shell  |
             | (OIDC/PKCE) |    |  git, gitlab, ...   |
             +-------------+    +--------------------+

             +------------------+  (Optional)
             | Faster-Whisper   |  STT :8300
             | TTS Engine       |  TTS :8301
             +------------------+
```

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Monorepo | NX (package-based) | latest |
| Shared Types | `@vibcode/shared` (enums, models, config) | -- |
| Frontend | Angular | 21.2 |
| CSS | Tailwind CSS | 4.2 |
| Icons | Lucide | 0.575 |
| Fonts | Outfit (UI) + JetBrains Mono (Terminal) | -- |
| Backend | NestJS | 11.x |
| ORM | Prisma | 7.x |
| Database | PostgreSQL | 16+ |
| Auth | Keycloak (OIDC/PKCE) | 26+ |
| WebSocket | Socket.IO | 4.8 |
| API Docs | Swagger / OpenAPI | via @nestjs/swagger |
| VCS | GitLab CE (API v4) | self-hosted |
| MCP | @modelcontextprotocol/sdk | 1.27+ |
| LLM (Local) | Ollama | latest |
| LLM (Cloud) | Anthropic, OpenAI, Google AI SDKs | -- |
| LLM (CLI) | Claude Code, Codex CLI, Gemini CLI, Qwen3 Coder | -- |
| Testing | Jest (backend), Vitest (frontend), Playwright (UI agent) | -- |
| Security Tools | semgrep, trivy, nuclei, nmap (used by Pen Tester agent) | -- |
| Reverse Proxy | Nginx | -- |

---

## Prerequisites

### Required

| Dependency | Minimum Version | Purpose |
|---|---|---|
| **Node.js** | >= 22 | Runtime for frontend and backend |
| **npm** | >= 10 | Package manager |
| **PostgreSQL** | >= 16 | Application database |
| **Keycloak** | >= 26 | Authentication (OIDC / PKCE) |
| **GitLab CE** | self-hosted, API v4 | Source code management, issues, wiki, CI/CD |
| **Git** | >= 2.30 | Worktree support required for session isolation |

### Recommended (Production)

| Dependency | Purpose |
|---|---|
| **Nginx** | Reverse proxy with TLS termination |
| **Let's Encrypt / certbot** | Free SSL certificates |
| **systemd** | Process management for backend service |

### Optional

| Dependency | Purpose |
|---|---|
| **Ollama** | Local LLM inference (free, no API costs) |
| **NVIDIA GPU** | Required for Ollama (recommended: 24+ GB VRAM) |
| **Faster-Whisper** | Speech-to-text for voice chat feature |
| **TTS Engine** (e.g. Qwen3-TTS, Piper) | Text-to-speech for voice chat feature |
| **Claude Code CLI** | Cloud CLI LLM provider (requires Anthropic subscription) |
| **Codex CLI** | Cloud CLI LLM provider (requires OpenAI subscription) |
| **Gemini CLI** | Cloud CLI LLM provider (requires Google subscription) |
| **semgrep, trivy, nuclei, nmap** | Security scanning tools used by the Pen Tester agent |
| **Maven 3.9+ / JDK 21** | Required only if building Java/Vaadin/Spring Boot projects |
| **GitLab Runner** | Required for CI/CD pipeline execution on generated projects |

---

## Installation

### 1. Clone and Install

```bash
git clone https://github.com/your-org/vibcode-hub.git
cd vibcode-hub
npm install          # Installs NX workspace dependencies at root level
```

### 2. PostgreSQL

Create a dedicated database and user:

```bash
sudo -u postgres createuser -P vibcodehub
# Enter a strong password when prompted

sudo -u postgres createdb -O vibcodehub vibcodehub
```

Verify the connection:

```bash
psql -U vibcodehub -h 127.0.0.1 -d vibcodehub -c "SELECT 1;"
```

### 3. Keycloak Setup

VibCode Hub requires a Keycloak realm with two clients and a set of roles.

#### a) Create the Realm

1. Log in to your Keycloak admin console
2. Create a new realm named **`vibcodehub`**

#### b) Create the Frontend Client (Public, PKCE)

1. In the `vibcodehub` realm, go to **Clients** -> **Create client**
2. Client ID: **`vibcodehub-frontend`**
3. Client authentication: **OFF** (public client)
4. Authentication flow: **Standard flow** enabled
5. Under **Settings**:
   - Valid redirect URIs: `https://your-domain.com/*`, `http://localhost:4200/*`
   - Valid post logout redirect URIs: `https://your-domain.com/*`, `http://localhost:4200/*`
   - Web origins: `+` (allows all origins matching redirect URIs)
6. Under **Advanced** -> **Advanced Settings**:
   - Proof Key for Code Exchange (PKCE): **S256**

#### c) Create the Backend Client (Confidential, Service Account)

1. Create another client with Client ID: **`vibcodehub-backend`**
2. Client authentication: **ON** (confidential)
3. Service account roles: **ON** (enable service account)
4. Authentication flow: **Standard flow** can be disabled
5. Go to the **Credentials** tab and copy the **Client secret** -- you will need this for the backend `.env` file

#### d) Create Realm Roles

Create the following realm roles:

| Role | Description |
|---|---|
| `admin` | Full access to all features and settings |
| `project-manager` | Can create/manage projects, cannot change system settings |
| `developer` | Can view projects and interact with agents |
| `viewer` | Read-only access |

#### e) Create Users

1. **Admin user**: Create your personal user account and assign the `admin` role
2. **Bot user** (recommended): Create a service user (e.g. `vibcode-bot`) with the `admin` role -- this user is used by agents for operations that require authentication

### 4. GitLab Setup

VibCode Hub communicates with GitLab through its REST API. Project repositories are created automatically.

1. **Create a bot user** (recommended) or use an existing admin account
2. **Generate a personal access token** for the bot user with the following scopes:
   - `api` -- Full API access
   - `read_user` -- Read user information
   - `read_repository` -- Read repository content
   - `write_repository` -- Push code, create branches and merge requests
3. **Create a webhook secret** -- generate a random string (e.g. `openssl rand -hex 32`) that will be used to verify webhook payloads
4. Note the GitLab URL (e.g. `https://git.example.com`) -- you will configure this in the Settings UI after first login

> **Note:** You do not need to pre-create any repositories. VibCode Hub creates and configures GitLab projects automatically when you create a project in the portal.

### 5. Backend Setup

```bash
cd backend
npm install

# Create environment file
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# PostgreSQL connection string
DATABASE_URL="postgresql://vibcodehub:YOUR_DB_PASSWORD@127.0.0.1:5432/vibcodehub?schema=public"

# Keycloak configuration
KEYCLOAK_URL=https://your-keycloak.example.com
KEYCLOAK_REALM=vibcodehub
KEYCLOAK_CLIENT_ID=vibcodehub-backend
KEYCLOAK_CLIENT_SECRET=your-backend-client-secret

# API port (optional, default: 3100)
PORT=3100
```

Run database setup:

```bash
# Generate Prisma client
npx prisma generate

# Apply all migrations
npx prisma migrate deploy

# Seed initial system settings and agent role defaults
npx ts-node prisma/seed-settings.ts
npx ts-node prisma/seed-agent-roles.ts
```

Start the development server:

```bash
npm run start:dev    # Runs on http://localhost:3100
```

Verify it is running:

```bash
curl http://localhost:3100/api/docs    # Should return Swagger UI HTML
```

### 6. Frontend Setup

```bash
cd frontend
npm install
```

Edit `src/environments/environment.ts` with your Keycloak configuration:

```typescript
export const environment = {
  production: false,
  apiUrl: 'http://localhost:3100/api',
  keycloak: {
    url: 'https://your-keycloak.example.com',
    realm: 'vibcodehub',
    clientId: 'vibcodehub-frontend',
  },
};
```

For production, also edit `src/environments/environment.prod.ts`:

```typescript
export const environment = {
  production: true,
  apiUrl: 'https://your-domain.com/api',
  keycloak: {
    url: 'https://your-keycloak.example.com',
    realm: 'vibcodehub',
    clientId: 'vibcodehub-frontend',
  },
};
```

Start the development server:

```bash
npx ng serve    # Runs on http://localhost:4200
```

### 7. First Login and Configuration

After both backend and frontend are running:

1. Open **http://localhost:4200** in your browser
2. Log in with the Keycloak admin user you created in step 3
3. Navigate to **Settings** (gear icon)

#### System Tab

Configure the following in the **System** settings:

| Setting | Value | Description |
|---|---|---|
| GitLab URL | `https://git.example.com` | Your GitLab instance URL |
| GitLab API Token | _(paste token)_ | The personal access token from step 4 |
| GitLab Webhook Secret | _(paste secret)_ | The webhook secret string from step 4 |
| CORS Origins | `http://localhost:4200` | Comma-separated list of allowed frontend origins |

Then configure at least one LLM provider (see [LLM Provider Setup](#llm-provider-setup) below).

#### Agent Roles Tab

1. Select a **preset** to configure all 10 agent roles at once:
   - **Local (Ollama)** -- Uses local Ollama models, no API costs, requires GPU
   - **CLI (Cloud)** -- Uses Claude Code, Codex CLI, Gemini CLI (requires subscriptions)
2. Or configure each agent role individually with your preferred provider and model

---

## Production Deployment

### Backend Systemd Service

Create `/etc/systemd/system/vibcode-api.service` (or as a user service):

```ini
[Unit]
Description=VibCode Hub API
After=network.target postgresql.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/vibcode-hub/backend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/src/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Build and enable:

```bash
cd backend
npm run build
sudo systemctl enable vibcode-api
sudo systemctl start vibcode-api
```

### Frontend Build

```bash
cd frontend
npx ng build --configuration production
# Output is in dist/frontend/browser/
```

### Nginx Configuration

Example Nginx server block with reverse proxy and TLS:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Frontend (Angular SPA)
    root /path/to/vibcode-hub/frontend/dist/frontend/browser;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Backend API + WebSocket
    location /api/ {
        proxy_pass http://127.0.0.1:3100/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;   # Long timeout for WebSocket
        proxy_send_timeout 86400s;
    }

    # Socket.IO (default namespace + /monitor)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3100/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # GitLab Webhook (unauthenticated, verified via X-Gitlab-Token header)
    location /api/gitlab/webhook {
        proxy_pass http://127.0.0.1:3100/api/gitlab/webhook;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP redirect
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}
```

### SSL with Let's Encrypt

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Optional: Project Preview Subdomains

If you want subdomain-based previews for projects (e.g. `my-project.your-domain.com`), add a wildcard server block:

```nginx
server {
    listen 443 ssl http2;
    server_name *.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Map project slug to port (generated by VibCode Hub)
    include /etc/nginx/conf.d/hub-project-map.conf;

    location / {
        proxy_pass http://127.0.0.1:$hub_project;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

The map file (`hub-project-map.conf`) is automatically generated and maintained by VibCode Hub when projects are created. Preview ports are allocated in the 5000-5999 range.

---

## Configuration

### .env File (Startup Essentials Only)

The `.env` file contains only what the backend needs to start:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `KEYCLOAK_URL` | Yes | Keycloak server URL |
| `KEYCLOAK_REALM` | Yes | Keycloak realm name |
| `KEYCLOAK_CLIENT_ID` | Yes | Backend client ID |
| `KEYCLOAK_CLIENT_SECRET` | Yes | Backend client secret |
| `PORT` | No | API port (default: 3100) |

### Settings UI (Everything Else)

All other configuration is managed through the **Settings** page in the web UI and stored encrypted in the database. This includes:

- GitLab connection (URL, token, webhook secret)
- LLM provider API keys and URLs
- CORS allowed origins
- Agent role configurations (provider, model, temperature, max tokens per role)
- Pipeline configuration
- Voice settings (STT/TTS URLs)
- MCP server registry

### Pipeline Configuration

Configurable via Settings -> System -> Pipeline:

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable/disable the agent pipeline |
| `autoStart` | `true` | Auto-start pipeline on new issues |
| `maxConcurrentAgents` | `1` | Maximum agents running in parallel |
| `timeoutMinutes` | `30` | General agent timeout |
| `maxFixAttempts` | `5` | Max fix loop iterations before NEEDS_REVIEW |
| `maxParallelOllamaModels` | `1` | VRAM management (1 = unload after each request) |
| `mcpMaxIterations` | `30` | Max MCP agent loop iterations |
| `maxInterviewMessages` | `20` | Max interview conversation turns |
| `cliTimeoutMinutes` | `90` | Timeout for CLI-based LLM providers |
| `stuckCheckIntervalMinutes` | `5` | How often to check for stuck tasks |
| `maxReviewDiffs` | `50` | Max diff files in code review |
| `maxHistoryChars` | `60000` | Max chars for agent comment history in prompts |
| `maxDiffChars` | `20000` | Max chars per diff file |

### Agent Role Configuration

Each of the 10 agent roles can be individually configured with:

- **Provider** -- Which LLM provider to use (Ollama, Anthropic, OpenAI, Google, Claude Code, Codex CLI, Gemini CLI, Qwen3 Coder)
- **Model** -- Which model to use with that provider
- **Temperature** -- Creativity parameter (0.0 - 1.0)
- **Max Tokens** -- Maximum output length
- **Dual Provider/Model** -- Optional second provider for dual-testing
- **Dual Strategy** -- How to combine dual results: `merge` (union), `consensus` (intersection), `enrich` (secondary validates primary)

---

## LLM Provider Setup

You need at least one LLM provider configured. Here is how to set up each:

### Ollama (Local, Free)

Best for privacy and zero API costs. Requires a GPU with sufficient VRAM.

1. Install Ollama: https://ollama.com/download
2. Pull models you want to use:
   ```bash
   ollama pull qwen3.5:35b        # General purpose (35B, needs ~22GB VRAM)
   ollama pull deepseek-r1:32b    # Strong reasoning
   ollama pull qwen2.5-coder:32b  # Code-optimized
   ```
3. In VibCode Hub Settings -> System, set:
   - **Ollama URL**: `http://localhost:11434`
4. Select the **Local (Ollama)** preset in Settings -> Agent Roles, or assign Ollama models to individual roles

> **VRAM Tip:** Set `maxParallelOllamaModels` to `1` in Pipeline Config if you have a single GPU. This unloads models between requests. Also set `OLLAMA_MAX_LOADED_MODELS=1` as an environment variable on the Ollama process.

### Anthropic Claude (Cloud API)

1. Get an API key from https://console.anthropic.com/
2. In Settings -> System, set:
   - **Anthropic API Key**: _(paste key)_
3. Assign `ANTHROPIC` provider with model (e.g. `claude-sonnet-4-20250514`) to desired agent roles

### OpenAI (Cloud API)

1. Get an API key from https://platform.openai.com/
2. In Settings -> System, set:
   - **OpenAI API Key**: _(paste key)_
3. Assign `OPENAI` provider with model (e.g. `gpt-4o`) to desired agent roles

### Google AI / Gemini (Cloud API)

1. Get an API key from https://aistudio.google.com/
2. In Settings -> System, set:
   - **Google API Key**: _(paste key)_
3. Assign `GOOGLE` provider with model (e.g. `gemini-2.0-flash`) to desired agent roles

### Claude Code CLI

Uses the Claude Code CLI tool. Requires an Anthropic Max subscription or API credits.

1. Install: `npm install -g @anthropic-ai/claude-code`
2. Authenticate: `claude auth login`
3. No API key needed in Settings -- the CLI handles authentication
4. Assign `CLAUDE_CODE` provider to desired agent roles

### Codex CLI

Uses the OpenAI Codex CLI tool. Requires an OpenAI Pro subscription.

1. Install: `npm install -g @openai/codex`
2. Authenticate: `codex auth`
3. No API key needed in Settings -- the CLI handles authentication
4. Assign `CODEX_CLI` provider to desired agent roles

### Gemini CLI

Uses the Google Gemini CLI tool. Requires a Google AI Pro subscription.

1. Install: `npm install -g @anthropic-ai/gemini-cli` (check for latest package name)
2. Authenticate: `gemini auth login`
3. No API key needed in Settings -- the CLI handles authentication
4. Assign `GEMINI_CLI` provider to desired agent roles

### Qwen3 Coder CLI

Uses the Qwen Coder CLI for local/remote Qwen models.

1. Install: `npm install -g qwen-coder`
2. Configure as needed
3. Assign `QWEN3_CODER` provider to desired agent roles

---

## Project Structure

```
vibcode-hub/
├── nx.json                        # NX workspace configuration
├── tsconfig.base.json             # Shared TypeScript config + @vibcode/shared path alias
├── package.json                   # Root NX dependencies
│
├── libs/shared/                   # @vibcode/shared — shared types across frontend/backend
│   └── src/
│       ├── enums.ts               # ProjectStatus, AgentRole, LLMProvider, etc.
│       ├── models.ts              # Project, Issue, ChatSession, AgentTask, etc.
│       ├── config.ts              # PipelineConfig, AgentRoleConfig, McpServerDefinition
│       └── monitor.ts             # HardwareSnapshot, ActivityItem
│
├── frontend/                      # Angular 21 SPA
│   ├── src/
│   │   ├── app/
│   │   │   ├── pages/
│   │   │   │   ├── dashboard/     # Project grid, hardware stats, create modal
│   │   │   │   ├── project/       # Pipeline view, chat panel, issue board
│   │   │   │   ├── settings/      # User + System + Agent Roles tabs
│   │   │   │   ├── agents/        # Agent roles overview
│   │   │   │   └── live-feed/     # Real-time activity stream
│   │   │   ├── services/          # API, Auth, Chat, WebSocket, Voice, i18n
│   │   │   ├── components/        # Shared UI components (icons, etc.)
│   │   │   └── pipes/             # TranslatePipe
│   │   ├── assets/i18n/           # Translation files (de, en, it, fr)
│   │   └── environments/          # environment.ts / environment.prod.ts
│   └── project.json               # NX project targets
│
├── backend/                       # NestJS REST API + WebSocket
│   ├── prisma/
│   │   ├── schema.prisma          # Database schema (14+ models)
│   │   ├── migrations/            # Prisma migrations
│   │   ├── seed-settings.ts       # Initial system settings seed
│   │   └── seed-agent-roles.ts    # Default agent role configurations
│   ├── prompts/                   # Agent system prompts (Markdown files)
│   │   ├── interviewer.md
│   │   ├── architect-design.md
│   │   ├── architect-grounding.md
│   │   ├── issue-compiler.md
│   │   ├── code-reviewer.md
│   │   ├── functional-tester.md
│   │   ├── ui-tester.md
│   │   ├── pen-tester.md
│   │   └── documenter.md
│   ├── src/
│   │   ├── auth/                  # Keycloak JWT Guard + WebSocket JWT Guard
│   │   ├── agents/
│   │   │   ├── agent-orchestrator.service.ts   # Event router
│   │   │   ├── pipeline-flow.service.ts        # Agent lifecycle management
│   │   │   ├── pipeline-retry.service.ts       # Fix loops, resume logic
│   │   │   ├── pipeline-cleanup.service.ts     # Stuck/zombie task cleanup
│   │   │   ├── agent-base.ts                   # Base class (LLM, MCP, logging)
│   │   │   ├── agent-result-parser.ts          # Shared JSON response parsing
│   │   │   ├── prompt-loader.ts                # Loads prompts/*.md files
│   │   │   ├── interviewer/                    # Interviewer agent
│   │   │   ├── architect/                      # Architect agent (design + grounding)
│   │   │   ├── issue-compiler/                 # Issue Compiler agent
│   │   │   ├── coder/                          # Coder agent (MCP loop)
│   │   │   ├── code-reviewer/                  # Code Reviewer agent
│   │   │   ├── functional-tester/              # Functional Tester agent
│   │   │   ├── ui-tester/                      # UI Tester agent
│   │   │   ├── pen-tester/                     # Pen Tester agent
│   │   │   ├── documenter/                     # Documenter agent
│   │   │   ├── devops/                         # DevOps agent
│   │   │   └── loop-resolver/                  # Loop Resolver service
│   │   ├── chat/                  # Chat sessions, messages, WebSocket gateway
│   │   ├── gitlab/                # GitLab API client (core, issues, MRs, wiki)
│   │   ├── issues/                # Issue CRUD + GitLab sync
│   │   ├── projects/              # Project CRUD + GitLab integration
│   │   ├── llm/                   # LLM abstraction layer (8 providers)
│   │   │   ├── llm.service.ts     # Unified interface
│   │   │   └── providers/         # Ollama, Anthropic, OpenAI, Google, CLI providers
│   │   ├── mcp/                   # MCP server registry + agent loop
│   │   ├── settings/              # System settings + user settings + presets
│   │   ├── monitor/               # Hardware monitoring (GPU, CPU, RAM)
│   │   ├── voice/                 # Voice STT/TTS integration
│   │   ├── preview/               # Project preview port allocation
│   │   └── common/                # Guards, filters, middleware, logging
│   └── project.json               # NX project targets
│
└── docs/                          # Documentation
    ├── SPEC.md                    # Requirements and phase plan
    ├── ARCHITECTURE.md            # Technical architecture
    ├── API.md                     # Full API reference
    ├── DEVELOPMENT.md             # Development guidelines
    └── PROMPTS.md                 # Session prompt log
```

---

## Development

### Running in Development

```bash
# Terminal 1: Backend (auto-reload)
cd backend && npm run start:dev

# Terminal 2: Frontend (auto-reload)
cd frontend && npx ng serve
```

The backend runs on `http://localhost:3100` and the frontend on `http://localhost:4200`.

### Build Commands

```bash
# Frontend
cd frontend && npx ng build                    # Production build
cd frontend && npx ng test                     # Unit tests (Vitest)

# Backend
cd backend && npm run build                    # Production build (NestJS)
cd backend && npm run test                     # Unit tests (Jest)
cd backend && npm run test:e2e                 # E2E tests

# Prisma
cd backend && npx prisma migrate dev --name <name>   # Create new migration
cd backend && npx prisma generate                     # Regenerate Prisma client
cd backend && npx prisma studio                       # Database GUI (port 5555)
```

### Modifying Agent Prompts

Agent system prompts are stored as Markdown files in `backend/prompts/`. To modify an agent's behavior:

1. Edit the corresponding `.md` file (e.g. `backend/prompts/code-reviewer.md`)
2. The prompt is loaded at runtime by `prompt-loader.ts` -- no rebuild needed, just restart the backend

Each prompt file defines the agent's role, responsibilities, output format, and quality gates.

### Adding a New Agent Role

1. Add the role to `AgentRole` type in `libs/shared/src/enums.ts`
2. Create a new directory under `backend/src/agents/{role-name}/`
3. Implement the agent service extending `BaseAgent` from `agent-base.ts`
4. Create a prompt file in `backend/prompts/{role-name}.md`
5. Register the agent in `agents.module.ts`
6. Add event handlers in `agent-orchestrator.service.ts` and `pipeline-flow.service.ts`
7. Add default configuration in `backend/src/settings/agent-presets.ts`
8. Update the frontend pipeline view in `frontend/src/app/pages/project/`

### Adding a New Language

1. Create a new JSON file: `frontend/src/assets/i18n/{locale}.json` (copy from `en.json`)
2. Translate all values
3. Add the locale code to `SUPPORTED_LOCALES` in `frontend/src/app/services/translate.service.ts`
4. Add the language name to the `languages.*` keys in all existing locale files (`de.json`, `en.json`, `it.json`, `fr.json`, and your new file)

### Adding a New MCP Server

1. Go to Settings -> Agent Roles -> MCP Servers section
2. Click "Add Server" and fill in: name, display name, command, args, category
3. Use `argTemplate` placeholders for dynamic values: `{workspace}`, `{allowedPaths}`, `{shellServerPath}`
4. Use `envTemplate` for secrets from settings: `{settings:gitlab.token}`
5. Assign the server to agent roles via the role assignment matrix
6. Optionally create per-project overrides to enable/disable specific servers

---

## API Documentation

Interactive Swagger documentation is available at `/api/docs` when the backend is running.

For the full API reference, see [docs/API.md](docs/API.md).

Key API areas:
- `POST /api/projects` -- Project CRUD
- `GET /api/issues` -- Issue management
- `POST /api/chat/sessions` -- Chat session management
- `POST /api/agents/*/start` -- Manual agent triggers
- `GET /api/monitor/hardware` -- Hardware stats
- `POST /api/gitlab/webhook` -- GitLab webhook receiver (no auth, verified via X-Gitlab-Token)
- `GET /api/mcp-servers` -- MCP server registry (admin)
- `GET /api/settings/system` -- System configuration (admin)

WebSocket namespaces:
- Default (`/`) -- Chat messages, agent status updates, LLM token streaming
- `/monitor` -- Hardware stats push (3s interval), agent log streaming

---

## Security Notice

This project was developed using **AI vibecoding** -- a collaborative approach where AI coding assistants generate significant portions of the codebase. While this enables rapid development, please be aware:

- **Review before production use.** AI-generated code should be reviewed by experienced developers before deployment in production environments, especially security-critical components (authentication, encryption, access control).
- **Secrets management.** API keys and tokens are stored AES-256-GCM encrypted in the database. The encryption key is derived from the Keycloak client secret. Ensure your `.env` file is never committed to version control.
- **Authentication.** The application relies on Keycloak for authentication. Ensure your Keycloak instance is properly secured and up to date.
- **Network security.** The application is designed for deployment behind a reverse proxy (Nginx) with TLS. Do not expose the backend API, database, or Keycloak admin ports directly to the internet.
- **Input validation.** All API inputs are validated using DTOs with `class-validator`. The backend uses a global `ValidationPipe` with `whitelist: true`.
- **Rate limiting.** The backend uses `@nestjs/throttler` for rate limiting on API endpoints.
- **CORS.** Allowed origins are configured via the Settings UI and enforced dynamically. Only explicitly listed origins are permitted.
- **MCP sandboxing.** MCP servers (filesystem, shell) are sandboxed to the workspace directory of each project. The shell server uses `execFile` (no shell injection) with a whitelist of allowed commands.
- **No warranty.** This software is provided as-is. Use at your own risk. Always perform your own security assessment before deploying to production.
- **Dependencies.** Regularly update dependencies to patch known vulnerabilities (`npm audit`).

---

## License

This project is licensed under the **GNU General Public License v3.0 or later** (GPL-3.0-or-later).

See [LICENSE](LICENSE) for the full license text.

---

## Contributing

Contributions are welcome. Please open an issue to discuss proposed changes before submitting a pull request.

When contributing:
- Follow the existing code style (Prettier + ESLint configured)
- Write tests for new features
- Update documentation (`docs/API.md`, `docs/ARCHITECTURE.md`) for API or structural changes
- Commit messages follow conventional format: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`

---

*Built with AI by KobAIld -- where humans direct and AI delivers.*
