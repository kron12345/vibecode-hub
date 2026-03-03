# VibCode Hub — Architektur

## Überblick

```
┌─────────────────────────────────────────────────────┐
│                    Nginx Reverse Proxy               │
│  hub.example.com → :4200  │  /api/ → :3100         │
│  *.hub.example.com → Projekt-Previews               │
│  sso.example.com → :8081 (Keycloak)                │
└──────────┬──────────────────────┬────────────────────┘
           │                      │
    ┌──────▼──────┐       ┌──────▼──────┐
    │   Angular   │       │   NestJS    │
    │  Frontend   │◄─────►│   Backend   │
    │  :4200      │  REST │   :3100     │
    └─────────────┘  +WS  └──────┬──────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
     ┌────────▼──┐      ┌───────▼───────┐   ┌──────▼──────┐
     │ PostgreSQL │      │  GitLab CE    │   │ LLM Providers│
     │  :5432     │      │  :8929        │   │ Claude, GPT  │
     │  (Prisma)  │      │  (API v4)     │   │ Gemini,Ollama│
     └────────────┘      └───────────────┘   └─────────────┘
```

## Tech-Stack

| Layer | Technologie | Version |
|---|---|---|
| Frontend | Angular | 21.2.0 |
| CSS | Tailwind CSS | 4.2.x |
| Icons | Lucide | 0.575.x |
| Fonts | Inter + Fira Code | Google Fonts |
| Backend | NestJS | 11.x |
| ORM | Prisma | 7.4.x |
| Datenbank | PostgreSQL | 17.8 |
| Auth | Keycloak | 26.1 |
| Reverse Proxy | Nginx | - |
| Container | Docker | 26.1.5 |

## Design-System

- **Theme**: Dark Slate (`#020617`), Glass Morphism (`backdrop-filter: blur`)
- **Farben**: Indigo (Dev/Primary), Emerald (Test), Amber (Security), Violet (Review), Cyan (Docs), Rose (Critical)
- **Typography**: Inter (UI), Fira Code (Terminal/Mono)
- **Layout**: Sidebar-Navigation + Bento Grid Cards
- **Agent Pipeline**: Horizontale Karten mit Pulse-Animation und Glow-States
- **Chat**: Terminal-Style mit `>` Prompt, farbcodierte Rollen

## Projektstruktur

```
vibcode-hub/
├── frontend/          # Angular 21 SPA
│   ├── src/app/
│   │   ├── pages/     # Lazy-loaded Seiten
│   │   ├── services/  # API, Auth, WebSocket Services
│   │   └── app.ts     # Root Component
│   └── src/environments/
├── backend/           # NestJS API
│   ├── src/
│   │   ├── auth/      # Keycloak JWT Guard
│   │   ├── prisma/    # DB Service (global)
│   │   ├── projects/  # Projekt-CRUD
│   │   ├── issues/    # Issue-Verwaltung
│   │   ├── chat/      # Chat-Sessions & Messages + EventEmitter
│   │   ├── llm/       # LLM Abstraction Layer (7 Provider)
│   │   ├── agents/    # Agent-Orchestrierung + Interviewer
│   │   ├── gitlab/    # GitLab API Integration
│   │   └── common/    # Decorators, Guards, Filters
│   └── prisma/
│       └── schema.prisma
├── docs/              # Spezifikation, Architektur, Prompts
└── shared/            # Geteilte Types (Frontend ↔ Backend)
```

## Preview-Infrastruktur

```
Browser → https://{slug}.hub.example.com
   ↓
Nginx Wildcard Server-Block (*.hub.example.com)
   ↓ $hub_project → map lookup
hub-project-map.conf: slug → 127.0.0.1:{port}
   ↓
Dev-Server auf localhost:{port}
```

- **Port-Range**: 5000–5999 (konfigurierbar via SystemSettings)
- **Map-File**: `/etc/nginx/conf.d/hub-project-map.conf` — komplett aus DB generiert
- **Trigger**: Interview-Abschluss (Webprojekt) → allocatePort → syncMap → reloadNginx
- **Cleanup**: Projekt-Löschung → releasePort → syncMap → reloadNginx
- **Recovery**: API-Start → Map aus DB synchronisieren
- **Security**: Slug-Validierung, reservierte Subdomains blockiert, `execFile` (keine Shell-Injection), atomare Writes

## Datenmodell

- **Project** → hat Issues, ChatSessions, AgentInstances. Status: `INTERVIEWING` | `SETTING_UP` | `READY` | `ARCHIVED`. Optional: `techStack` (JSON, Interview-Ergebnis), `previewPort` (unique, für Subdomain-Preview)
- **Milestone** → Gruppierung von Issues pro Projekt, optional GitLab-gespiegelt (`gitlabMilestoneId`). Felder: title, description, sortOrder, startDate, dueDate. Wird vom Issue Compiler Agent automatisch erzeugt.
- **Issue** → hierarchisch (parent/sub-issues), gespiegelt von GitLab, optional einem Milestone zugeordnet (`milestoneId`), `sortOrder` für Reihenfolge
- **IssueComment** → Kommentare auf Issues, Typ: AGENT/USER/SYSTEM, optional mit GitLab-Note-ID gespiegelt, optional an AgentTask gebunden
- **ChatSession** → pro Projekt, enthält ChatMessages
- **AgentInstance** → konfigurierter Agent pro Projekt (Rolle + Provider + Model)
- **AgentTask** → einzelner Arbeitsschritt eines Agenten (11 Task-Typen)
- **AgentLog** → Echtzeit-Logs für Live-Dashboard
- **UserSetting** → Pro-User Key-Value Settings (Sprache, Theme, UI-Präferenzen)
- **SystemSetting** → Globale Konfiguration (GitLab, LLM-Provider, CORS, Agent-Rollen, Pipeline), Secrets AES-256-GCM verschlüsselt

## Agent-Rollen (10)

| # | Rolle | Aufgabe | Farbe |
|---|---|---|---|
| 1 | Interviewer | Feature-Interviews, fragt bis 95% Klarheit | Sky |
| 2 | Architect | Technisches Design, Architektur-Entscheidungen | Violet |
| 3 | Issue Compiler | Interview → Milestones + GitLab Issues + Sub-Issues | Amber |
| 4 | Coder | Implementiert Code nach Issue-Spezifikation | Indigo |
| 5 | Code Reviewer | Code-Review: Qualität, Security, Patterns | Emerald |
| 6 | UI Tester | UI-Tests: Layout, Responsivität, Accessibility | Pink |
| 7 | Functional Tester | Funktionale Tests, Acceptance Criteria | Teal |
| 8 | Pentester | Security-Tests: OWASP Top 10, Dependency Audit | Red |
| 9 | Documenter | Dokumentation: API.md, README, i18n, JSDoc | Cyan |
| 10 | DevOps | Deployment, Build, Git-Commits, Health Checks | Orange |

Jede Rolle hat ein vollständiges Behavior Profile (System Prompt) mit: Verantwortlichkeiten, Verhaltensregeln, Output-Format, Quality Gate.

## LLM Provider Types (7)

| Provider | Typ | Beschreibung |
|---|---|---|
| OLLAMA | Local | Lokale Inferenz via Ollama API (2x RTX 3090) |
| CLAUDE_CODE | CLI | Claude Code als Subprocess |
| CODEX_CLI | CLI | OpenAI Codex CLI als Subprocess |
| QWEN3_CODER | CLI | Qwen3 Coder CLI als Subprocess |
| ANTHROPIC | API | Anthropic Claude API |
| OPENAI | API | OpenAI GPT API |
| GOOGLE | API | Google Gemini API |

## Agent Pipeline Flow

```
Interview → agent.interviewComplete
  → DevOps → agent.devopsComplete
    → Issue Compiler → agent.issueCompilerComplete
      → Coder Agent (pro Issue im Milestone, sequenziell)
        → agent.codingComplete
          → Code Reviewer
            → agent.reviewApproved → Issue TESTING
            → agent.reviewChangesRequested → Coder fixIssue()

GitLab Webhooks:
  gitlab.pipelineResult (failed) → Coder fixIssue() mit Job-Logs
  gitlab.userComment (auf DONE/IN_REVIEW/TESTING Issue) → Coder fixIssue()
```

### Coder Agent
- Nutzt **Qwen CLI** (`/home/sebastian/.npm-global/bin/qwen`) im `--yolo` Mode mit Ollama Backend
- Pro Issue: Feature-Branch erstellen → Qwen CLI → Commit & Push → GitLab MR → Issue IN_REVIEW
- Fix-Modus: Bestehenden Branch auschecken, Feedback in Prompt, Push auf MR
- 10 Minuten Timeout, 50 MB max Buffer

### Code Reviewer Agent
- Nutzt **Ollama** (über BaseAgent.callLlm()) für Review
- Holt MR-Diffs via GitLab API, baut Review-Prompt
- APPROVED: ≤2 Warnings, keine Critical Findings → Issue TESTING
- CHANGES REQUESTED: → Coder re-triggered mit Review-Findings
- Postet Review als GitLab-Kommentar

### DevOps Agent — CI/CD
- Generiert deterministische `.gitlab-ci.yml` basierend auf Tech-Stack
- Templates: Node/Angular/React (4 Stages), Python, Rust, Go, Generic
- Runner-Tags: `docker`, `vibcode`

## Auth-Flow

1. Frontend nutzt Keycloak PKCE Flow (public client)
2. Bearer Token wird automatisch an API-Requests angehängt
3. Backend validiert JWT gegen Keycloak JWKS endpoint
4. Nginx oauth2-proxy als zusätzliche Schutzschicht

## Domains & Routing

| URL | Ziel |
|---|---|
| hub.example.com | Angular Frontend (:4200) |
| hub.example.com/api/* | NestJS Backend (:3100) |
| *.hub.example.com | Projekt-Preview (dynamischer Port) |
| sso.example.com | Keycloak (:8081) |
| git.example.com | GitLab CE (:8929) |

## GitLab-Integration

- **GitlabService** (`backend/src/gitlab/gitlab.service.ts`) — HTTP-Client für GitLab API v4
- **Automatisch**: Bei Projekt-Erstellung wird ein GitLab-Repo erstellt, bei Löschung gelöscht
- **Webhook**: `POST /api/gitlab/webhook` — empfängt Issue-Events und synct sie lokal (Upsert)
- **Intern**: Service wird von Agenten genutzt um Issues zu erstellen/updaten

### GitLab CI/CD Runner

Ein **shared GitLab Runner** (Docker-Executor) läuft als systemd-Service auf dem Server.

| Setting | Wert |
|---|---|
| Binary | `/usr/local/bin/gitlab-runner` (v18.9.0) |
| Config | `/etc/gitlab-runner/config.toml` |
| Working Dir | `/home/gitlab-runner` |
| Executor | `docker` (Default-Image: `node:22-alpine`) |
| Concurrency | 4 parallele Jobs |
| Tags | `docker`, `vibcode` |
| Scope | Shared (instance-level, alle Projekte) |
| Service | `sudo gitlab-runner status/start/stop/restart` |

**Wartung:**
```bash
# Status prüfen
sudo gitlab-runner status

# Logs anzeigen
sudo journalctl -u gitlab-runner -f

# Config ändern → automatisch reloaded
sudo nano /etc/gitlab-runner/config.toml

# Binary aktualisieren
sudo curl -L --output /usr/local/bin/gitlab-runner \
  "https://s3.dualstack.us-east-1.amazonaws.com/gitlab-runner-downloads/latest/binaries/gitlab-runner-linux-amd64"
sudo chmod +x /usr/local/bin/gitlab-runner
sudo gitlab-runner restart
```

## API-Design

- REST unter `/api/`
- Swagger/OpenAPI unter `/api/docs`
- WebSocket für Live-Agent-Updates + LLM-Token-Streaming
- GitLab Webhook unter `/api/gitlab/webhook` (ohne Auth, via X-Gitlab-Token)

### LLM Streaming

```
Agent → LlmService.completeStream() → Provider.streamComplete()
  → AsyncGenerator<LlmStreamChunk>
    → chatStreamStart (WebSocket)
    → chatStreamToken (pro Token)
    → chatStreamEnd (WebSocket)
    → Message in DB speichern
```

- **Streaming-Provider**: Ollama (NDJSON), Anthropic (SSE), OpenAI (SSE), Google (SSE)
- **Fallback**: CLI-Provider (Claude Code, Codex, Qwen) → Single-Chunk nach Completion
- **Frontend**: Token-Akkumulation mit Live-Cursor (▊) im Terminal-Chat

## MCP-Server (Entwicklungs-Tooling)

Konfiguriert in `.claude/settings.local.json`:

| Server | Command | Transport |
|---|---|---|
| angular | `angular-mcp-server` | stdio |
| prisma | `npx prisma mcp --schema ./backend/prisma/schema.prisma` | stdio |
| context7 | `npx -y @upstash/context7-mcp@latest` | stdio |

## Entwicklungsrichtlinien

Siehe `docs/DEVELOPMENT.md` für:
- MCP-Nutzungspflicht und Prioritäten
- Umsetzungsschleife (Planen → MCP → Implementieren → Verifizieren)
- Dokumentationspflicht pro Session
