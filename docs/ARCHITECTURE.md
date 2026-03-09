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
- **IssueComment** → Kommentare auf Issues, Typ: AGENT/USER/SYSTEM, GitLab-Note-ID (`gitlabNoteId`) für 2-Wege-Sync, gleicher rich Markdown wie GitLab-Note, optional an AgentTask gebunden. Agent-Kommentare bilden einen sichtbaren "Chat" auf jedem Issue (Coder → Reviewer → Functional → UI → Pen → Docs)
- **ChatSession** → pro Projekt, enthält ChatMessages
- **AgentInstance** → konfigurierter Agent pro Projekt (Rolle + Provider + Model)
- **AgentTask** → einzelner Arbeitsschritt eines Agenten (11 Task-Typen)
- **AgentLog** → Echtzeit-Logs für Live-Dashboard
- **McpServerDefinition** → Registrierte MCP-Server (name unique, command, args, argTemplate, envTemplate, category, builtin-Flag). 9 Built-in Server (filesystem, git, gitlab, prisma, angular-cli, shell, playwright, eslint, security-audit) beim Start geseeded, nicht löschbar.
- **McpServerOnRole** → Many-to-many Join zwischen McpServerDefinition und AgentRole. Definiert welche MCP-Server einer Agent-Rolle zur Verfügung stehen. @@unique(mcpServerId, agentRole).
- **McpServerProjectOverride** → Pro-Projekt Override der globalen MCP-Server-Konfiguration. ENABLE/DISABLE pro Server+Rolle. @@unique(projectId, mcpServerId, agentRole).
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
    → Architect (Phase A: Design) → agent.architectDesignComplete
      → Issue Compiler → agent.issueCompilerComplete
        → Architect (Phase B: Grounding) → agent.architectGroundingComplete
          → Coder Agent (pro Issue im Milestone, sequenziell)
            → agent.codingComplete
              → Code Reviewer
                → agent.reviewApproved
                  → Functional Tester → agent.functionalTestComplete
                    → pass → UI Tester → agent.uiTestComplete
                      → pass → Pen Tester → agent.penTestComplete
                        → pass → Documenter → agent.docsComplete → Issue DONE
                        → fail → Coder fixIssue(security feedback)
                      → fail → Coder fixIssue(UI feedback)
                    → fail → Coder fixIssue(functional test feedback)
                → agent.reviewChangesRequested → Coder fixIssue()

GitLab Webhooks:
  gitlab.pipelineResult (failed) → Coder fixIssue() mit Job-Logs
  gitlab.userComment (auf DONE/IN_REVIEW/TESTING Issue) → Coder fixIssue()
```

### Architect Agent (2 Phasen)
- **Phase A — Design** (einmalig nach DevOps, Task: `DESIGN_ARCHITECTURE`)
  - Liest Projektstruktur via MCP Filesystem (bestehender Code) oder entwirft Architektur (leeres Repo)
  - Postet Architektur-Überblick als Chat-Message
  - Adaptiv: Analysiert vorhandenen Code ODER designt von Grund auf
- **Phase B — Grounding** (nach Issue Compiler, Task: `ANALYZE_ISSUES`)
  - Iteriert über alle OPEN Issues
  - Pro Issue: Liest relevanten Code via MCP → postet Grounding-Kommentar auf das Issue
  - Kommentar enthält: Relevante Dateien, zu erstellende Dateien, Approach, Patterns
  - Nutzt `postAgentComment()` → sichtbar in GitLab + lokaler DB
  - Coder bekommt Grounding via `getAgentCommentHistory()` automatisch
- **MCP-Server**: filesystem, sequential-thinking (konfigurierbar via MCP Registry)
- **Fallback**: Wenn kein MCP konfiguriert → Plain LLM Call

### Coder Agent
- Nutzt **MCP Agent Loop**: Ollama (Tool-Calling) + MCP Filesystem Server
- LLM liest/schreibt/editiert Dateien selbst über MCP-Tools (read_file, write_file, edit_file, search_files, directory_tree etc.)
- Pro Issue: Feature-Branch erstellen → Agent Loop (LLM ↔ Tools) → Commit & Push → GitLab MR → Issue IN_REVIEW
- Fix-Modus: Bestehenden Branch auschecken, Feedback in Prompt, Push auf MR
- 10 Minuten Timeout, max 30 Iterationen

### MCP Integration (McpModule)
- **McpClientService**: Startet MCP-Server als Subprozesse, verwaltet Connections, Tool-Discovery
- **McpAgentLoopService**: Generischer Agent-Loop (LLM-Call → tool_calls → MCP-Execution → Repeat)
- **Filesystem MCP Server**: `@modelcontextprotocol/server-filesystem` — 14 Tools (read, write, edit, search, tree etc.)
- **Shell MCP Server**: `shell-server.mjs` — `run_command` Tool für Shell-Befehle im Workspace
- **Sandboxing**: MCP-Server erhalten nur Zugriff auf den Workspace-Ordner des Projekts
- **Erweiterbar**: Weitere MCP-Server (Git, Angular CLI, Prisma) können über die MCP Server Registry hinzugefügt werden

### MCP Server Registry
- **McpRegistryService**: CRUD für MCP-Server-Definitionen, Rollen-Zuordnung, Runtime-Auflösung, Project Overrides
- **McpRegistryController**: 6 REST-Endpoints unter `/api/mcp-servers` (Admin only)
- **McpProjectOverrideController**: 3 REST-Endpoints unter `/api/projects/:projectId/mcp-overrides` (Admin, PM)
- **13 Built-in Server**: filesystem, git, gitlab, prisma, angular-cli, shell, playwright, eslint, security-audit, postgres, docker, sequential-thinking, memory — beim Start geseeded, nicht löschbar
- **Custom Server**: Admins können eigene MCP-Server registrieren
- **Rollen-Zuordnung**: Many-to-many (`McpServerOnRole`) — pro Agent-Rolle konfigurierbar welche Server verfügbar sind
- **Project Overrides**: `McpServerProjectOverride` erlaubt pro Projekt+Rolle Server zu ENABLE/DISABLE (überschreibt Global-Config)
- **Runtime Resolution**: `resolveServersForRole(role, context)` löst auf:
  - `argTemplate`: Platzhalter `{workspace}`, `{allowedPaths}`, `{shellServerPath}` → Laufzeitwerte
  - `envTemplate`: `{settings:key}` → SystemSettingsService (z.B. GitLab Token AES-256-GCM entschlüsselt)
  - Project Overrides: DISABLE entfernt Server, ENABLE fügt hinzu (auch wenn nicht global zugeordnet)
- **Coder Agent**: Lädt MCP-Server dynamisch aus Registry, übergibt `projectId` für Override-Auflösung
- **Frontend**: MCP Servers Section in Settings → Agents Tab + Project-Level Override-Matrix in Projekt-Settings

### Shell MCP Server (`shell-server.mjs`)

Eigener MCP-Server, der dem Coder Agent sichere Shell-Befehle im Workspace ermöglicht.

**Tool:** `run_command` — führt ein Kommando im Workspace-Verzeichnis aus.

**Whitelisted Commands:** `npm`, `npx`, `yarn`, `pnpm`, `node`, `git`, `tsc`, `ng`, `nest`, `prisma`, `eslint`, `prettier`, `jest`, `vitest`, `cat`, `ls`, `mkdir`, `cp`, `mv`, `touch`, `chmod`, `head`, `tail`, `wc`, `diff`, `find`, `which`

**Security:**
- `execFile` (kein Shell-Injection möglich)
- Blockierte Patterns: `rm -rf /`, `sudo`, `curl|sh`, `wget|sh`, `eval`, `> /dev/`
- 120 Sekunden Timeout pro Befehl
- 10 MB Output-Buffer
- Nur im übergebenen Workspace-Verzeichnis ausführbar

### Agent Comment System
- **Utility**: `agent-comment.utils.ts` — `postAgentComment()` speichert identischen rich Markdown in lokaler DB UND als GitLab Issue Note. `gitlabNoteId` wird gespeichert für 2-Wege-Sync.
- **Context Injection**: `getAgentCommentHistory()` lädt alle bisherigen Agent-Kommentare eines Issues als formatierten String. Wird in die LLM-Prompts von Functional Tester, UI Tester, Pen Tester und Documenter injiziert.
- **Agent-Chat**: Jeder Agent in der Pipeline sieht was seine Vorgänger geschrieben haben → weniger Redundanz, bessere Analyse.

### Code Reviewer Agent
- Nutzt **Ollama** (über BaseAgent.callLlm()) für Review
- Holt MR-Diffs via GitLab API, baut Review-Prompt
- APPROVED: ≤2 Warnings, keine Critical Findings → Functional Tester
- CHANGES REQUESTED: → Coder re-triggered mit Review-Findings
- Postet Review als unified Agent-Kommentar (lokal + GitLab)

### Functional Tester Agent
- **LLM-basiert** — nutzt BaseAgent.callLlm()
- Holt Issue-Description + Acceptance Criteria (Sub-Issues) + MR-Diffs
- **Kontext-Injection**: Bekommt Kommentare von Coder + Code Reviewer als LLM-Kontext
- LLM prüft ob Code die Criteria erfüllt
- PASS: Alle Criteria adressiert, keine Critical Findings → UI Tester
- FAIL: → Coder fixIssue() mit Test-Feedback

### UI Tester Agent
- **Zweistufig**: Playwright (optional) + LLM
- Wenn Preview-URL vorhanden: Headless Chromium Screenshots, DOM-Snapshot, Accessibility-Audit (axe-core), Responsive-Check
- Wenn kein Preview: Nur Code-Analyse per LLM (Fallback)
- **Kontext-Injection**: Bekommt Kommentare von Coder + Code Reviewer + Functional Tester als LLM-Kontext
- Prüft: Layout, Responsivität, Accessibility (WCAG 2.1 AA), Visuals, Interaktionen
- PASS: Keine Critical Findings, ≤3 Warnings → Pen Tester
- FAIL: → Coder fixIssue() mit UI-Feedback

### Pen Tester Agent
- **Dreistufig**: npm audit + HTTP-Header-Check + LLM-Analyse
- `npm audit --omit=dev --json` — nur Production-Dependencies (Dev-Deps gefiltert, reduziert false positives)
- Security-Header-Check (CSP, HSTS, X-Frame-Options, etc.) gegen Preview-URL — abschaltbar via `pentester.skipHeaderCheck`
- **Tech-Stack-Kontext**: Project techStack (Framework, Backend, Projekttyp) wird ins LLM-Prompt injiziert → kontextbewusste Analyse
- **Kontext-Injection**: Bekommt alle bisherigen Agent-Kommentare als LLM-Kontext
- LLM analysiert MR-Diffs auf OWASP Top 10
- **Konfigurierbare Schwellen**: `pentester.maxWarnings` (default: 3) — PASS/FAIL wird server-seitig anhand der Findings berechnet, nicht blind dem LLM vertraut
- PASS: Keine Critical Findings, Warnings ≤ maxWarnings → Documenter
- FAIL: → Coder fixIssue() mit Security-Feedback

### Stuck Task Cleanup (Activity-Based)
- **Automatisch**: Alle 5 Minuten prüft der Orchestrator auf RUNNING Tasks
- **Activity-Based**: Nicht rein zeitbasiert — prüft ob der Agent noch aktiv ist:
  - Letzte `AgentLog`-Einträge nach dem Inactivity-Cutoff?
  - Letzte `ChatMessage` zum Task nach dem Cutoff?
  - Nur wenn BEIDE Checks keine Aktivität zeigen → Task ist stuck
- **Inactivity-Timeout**: Konfigurierbar via `pipeline.stuckTimeoutMinutes` (default: 30 Minuten ohne jede Aktivität)
- **Cleanup**: Stuck Tasks → FAILED, Agent → IDLE, Issue → OPEN (für Retry)
- **Orphaned Agents**: WORKING/WAITING Agents ohne RUNNING Task → IDLE
- **Designprinzip**: Agenten dürfen so lange laufen wie sie brauchen — nur wirklich tote Agents werden aufgeräumt

### Ollama VRAM Management
- **Problem**: Mehrere 30B+ Modelle gleichzeitig im VRAM → GPU-Kontention → Timeouts (2×RTX 3090)
- **Lösung**: `keep_alive` Parameter auf Ollama-Requests — steuert wie lange ein Modell im VRAM bleibt
- **Setting**: `pipeline.maxParallelOllamaModels` (default: 1)
  - Bei 1: `keep_alive: "0"` → Modell wird nach jedem Request sofort entladen
  - Bei >1: `keep_alive: "5m"` → Modell bleibt 5 Minuten cached (für Multi-GPU-Setups)
- **Empfehlung**: Zusätzlich `OLLAMA_MAX_LOADED_MODELS=1` als Ollama-Server-Config (Belt & Suspenders)
- **UI**: Konfigurierbar in Settings → Pipeline-Konfiguration

### Max Fix Attempts (Review-Loop-Schutz)
- **Problem**: Code Review / Tests können Coder endlos re-triggern (Feedback-Loop)
- **Lösung**: Zähler für `FIX_CODE`-Tasks pro Issue, konfigurierbar via `pipeline.maxFixAttempts` (default: 20)
- **Konsolidiert**: Alle 4 fixIssue-Pfade (Review, Pipeline, Test, User-Comment) nutzen `retriggerCoder()`
- **Bei Limit**: Issue → `NEEDS_REVIEW` Status (rot), GitLab-Label `status::needs-review`, erklärender Kommentar
- **UI**: Konfigurierbar in Settings → Pipeline-Konfiguration

### Documenter Agent
- LLM analysiert MR-Diffs + bestehende Docs
- **Kontext-Injection**: Bekommt alle bisherigen Agent-Kommentare als LLM-Kontext
- Generiert/aktualisiert: README.md, API-Docs, JSDoc, CHANGELOG
- **Wiki-Sync**: Dateien mit `wikiPage: true` werden nach GitLab Wiki gesynct (Upsert)
- Schreibt Dateien im Workspace, committed auf Feature-Branch
- Issue → DONE nach Abschluss

### DevOps Agent — CI/CD
- Generiert deterministische `.gitlab-ci.yml` basierend auf Tech-Stack
- Templates: Node/Angular/React (4 Stages), Python, Rust, Go, Generic
- Runner-Tags: `docker`, `vibcode`

## GitLab Status Labels

Jede Issue-Status-Transition synct automatisch ein `status::*` Label nach GitLab. Die 6 Labels werden idempotent pro Projekt erstellt (einmal anlegen, danach wiederverwenden).

| Label | Farbe | Status |
|---|---|---|
| `status::open` | Blau (`#428BCA`) | OPEN |
| `status::in-progress` | Orange (`#ED9121`) | IN_PROGRESS |
| `status::in-review` | Lila (`#9B59B6`) | IN_REVIEW |
| `status::testing` | Gelb (`#F0AD4E`) | TESTING |
| `status::needs-review` | Rot (`#E74C3C`) | NEEDS_REVIEW |
| `status::done` | Grün (`#69D100`) | DONE |
| `status::closed` | Grau (`#CCCCCC`) | CLOSED |

**Sync-Punkte:**
- `IssuesService.update()` — bei jedem Status-Wechsel über die REST-API
- `CodeReviewerAgent` — setzt IN_REVIEW / IN_PROGRESS
- `DocumenterAgent` — setzt DONE
- `AgentOrchestratorService` — Pipeline-Failure, User-Kommentar-Feedback, Max Fix Attempts

**Verhalten:** Beim Label-Sync werden alle bestehenden `status::*` Labels vom Issue entfernt und das neue Label gesetzt. Labels werden pro Projekt einmalig erstellt (idempotent, kein Fehler bei Duplikat).

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
- **Tool-Calling**: Ollama unterstützt native Tool-Calls (`tool_calls` in Response), genutzt vom MCP Agent Loop
- **Fallback**: CLI-Provider (Claude Code, Codex) → Single-Chunk nach Completion
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
