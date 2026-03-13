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

## Workspace Isolation (Git Worktrees)

Dev Sessions use **git worktrees** to provide isolated working copies of the repository. This prevents concurrent sessions and infrastructure commands from interfering with each other.

```
backend/workspaces/{projectSlug}/                  # Main workspace (workBranch)
  └── .session-worktrees/
      └── {projectSlug}--{sanitizedBranch}/        # Session worktree (session branch)
```

### Lifecycle

1. **Session Created** → `git worktree add .session-worktrees/{slug}--{branch} {branch}` creates an isolated copy
2. **Agents Work** → All session agents (Interviewer, Architect, Issue Compiler, Coder) operate in the worktree directory
3. **Session Archived** → Session branch is merged into workBranch, then `git worktree remove` cleans up the directory

### Workspace Resolution (`resolveWorkspace()`)

All agents use `BaseAgent.resolveWorkspace()` to determine the correct working directory:

- **Infrastructure Chat** → returns main workspace path (`backend/workspaces/{slug}/`)
- **Dev Session Chat** → returns worktree path (`.session-worktrees/{slug}--{branch}/`)

MCP servers (filesystem, shell, git) are sandboxed to the resolved workspace path.

### Key Properties

- **Main workspace stays clean** — always on workBranch, never touched by session agents
- **Concurrent sessions** — each session has its own worktree, no file conflicts
- **Shared `.git`** — worktrees share the git object store, so branches are visible across all worktrees
- **Cleanup on archive** — worktree directory is removed after successful merge

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

- **Project** → hat Issues, ChatSessions, AgentInstances. Status: `INTERVIEWING` | `SETTING_UP` | `READY` | `ARCHIVED`. Optional: `techStack` (JSON, Interview-Ergebnis), `previewPort` (unique, für Subdomain-Preview), `workBranch` (String?, Ziel-Branch für Feature-Branches — Feature-Branches werden davon abgezweigt und MRs dagegen erstellt; bei `null` wird der GitLab-Default-Branch verwendet)
- **Milestone** → Gruppierung von Issues pro Projekt, optional GitLab-gespiegelt (`gitlabMilestoneId`). Felder: title, description, sortOrder, startDate, dueDate. Wird vom Issue Compiler Agent automatisch erzeugt.
- **Issue** → hierarchisch (parent/sub-issues), gespiegelt von GitLab, optional einem Milestone zugeordnet (`milestoneId`), optional einer ChatSession zugeordnet (`chatSessionId` für session-scoped Issues), `sortOrder` für Reihenfolge
- **IssueComment** → Kommentare auf Issues, Typ: AGENT/USER/SYSTEM, GitLab-Note-ID (`gitlabNoteId`) für 2-Wege-Sync, gleicher rich Markdown wie GitLab-Note, optional an AgentTask gebunden. Agent-Kommentare bilden einen sichtbaren "Chat" auf jedem Issue (Coder → Reviewer → Functional → UI → Pen → Docs)
- **ChatSession** → pro Projekt, enthält ChatMessages. `type`: `INFRASTRUCTURE` (permanenter Chat) | `DEV_SESSION` (eigener Git-Branch + eigener Worktree). `status`: `ACTIVE` | `MERGING` | `ARCHIVED` | `CONFLICT`. Optional: `branch` (Git-Branch-Name), `archivedAt`, `parentId` (Fortsetzung einer archivierten Session). Dev-Sessions werden bei Archivierung in main gemergt, Worktree wird entfernt. Issues können über `chatSessionId` einer Session zugeordnet sein.
- **AgentInstance** → konfigurierter Agent pro Projekt (Rolle + Provider + Model)
- **AgentTask** → einzelner Arbeitsschritt eines Agenten (13 Task-Typen, including `FEATURE_INTERVIEW` and `INFRA_COMMAND`)
- **AgentLog** → Echtzeit-Logs für Live-Dashboard
- **McpServerDefinition** → Registrierte MCP-Server (name unique, command, args, argTemplate, envTemplate, category, builtin-Flag). 14 Built-in Server beim Start geseeded: filesystem, git, gitlab, prisma, angular-cli, vaadin (HTTP remote), spring-docs, shell, playwright, eslint, security-audit, postgres, docker, sequential-thinking, memory, searxng. HTTP-Transport für Remote-Server via leeres command + argTemplate=URL Convention.
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

| Provider | Typ | Multimodal | Beschreibung |
|---|---|---|---|
| OLLAMA | Local | ✅ (images array) | Lokale Inferenz via Ollama API (2x RTX 3090) |
| CLAUDE_CODE | CLI | ❌ | Claude Code als Subprocess |
| CODEX_CLI | CLI | ❌ | OpenAI Codex CLI als Subprocess |
| QWEN3_CODER | CLI | ❌ | Qwen3 Coder CLI als Subprocess |
| ANTHROPIC | API | ✅ (ImageBlock) | Anthropic Claude API |
| OPENAI | API | ✅ (image_url) | OpenAI GPT API |
| GOOGLE | API | ✅ (inlineData) | Google Gemini API |

### Multimodal Content
- `LlmMessage.content` unterstützt `string | LlmContentPart[]` mit Text- und Image-Parts
- `LlmContentPart`: `{ type: 'text'; text } | { type: 'image'; mediaType; base64 }`
- Jeder Provider konvertiert in sein eigenes Image-Format (Anthropic `source.base64`, Google `inlineData`, OpenAI `image_url` data-URI, Ollama `images[]`)
- CLI-Provider nutzen `getTextContent()` — Images werden ignoriert (kein Inline-Support)
- Utilities: `getTextContent()`, `getImageParts()` in `llm.interfaces.ts`

## Agent Pipeline Flow

The pipeline is split into two chat types with distinct flows:

### Infrastructure Chat (INFRASTRUCTURE)

```
Interview → agent.interviewComplete
  → DevOps (project setup) → agent.devopsComplete → STOP
    ↓
  Generates: ENVIRONMENT.md in project workspace
  Project status → READY
    ↓
  Infrastructure Chat enters YOLO mode:
    User sends infra commands → DevOps handleInfraCommand()
    (MCP agent loop with filesystem/shell/git tools)
```

After initial setup completes, the Infrastructure Chat becomes a persistent YOLO mode terminal. The user can send infrastructure commands (e.g., "install tailwind", "update dependencies", "fix build") and the DevOps agent executes them via MCP tools without going through the full pipeline.

### Dev Session Chat (DEV_SESSION)

```
User creates Dev Session → session.devSessionCreated
  → git worktree add (isolated workspace on session branch)
  → Feature Interview (Interviewer) → agent.featureInterviewComplete
    → Architect (Phase A: Design) → agent.architectDesignComplete
      - Reads session features from FeatureInterviewResult (FEATURE_INTERVIEW task output)
      - Includes ENVIRONMENT.md context from worktree
      → Issue Compiler → agent.issueCompilerComplete
        - Reads features from FeatureInterviewResult (not project.techStack)
        - Issues get chatSessionId linking them to the session
        → Architect (Phase B: Grounding) → agent.architectGroundingComplete
          - Only grounds issues belonging to the current session (filtered by chatSessionId)
          → Coder Agent (pro Issue im Milestone, sequenziell)
            - Only processes session-scoped issues (filtered by chatSessionId)
            - Works in worktree directory (resolveWorkspace())
            - Direct commits on session branch (no MR per issue)
            → agent.codingComplete → DONE (no review/test per issue)

Session archive merges session branch → workBranch, removes worktree.
```

**Session-Scoped Pipeline** (simplified — no MR/review/test per issue):
- Feature Interview → Architect (Phase A) → Issue Compiler → Architect (Phase B) → Coder → DONE
- The session merge into workBranch replaces per-issue MRs
- Review/testing happens at the session level, not per issue

**Full Pipeline** (issues outside dev sessions, e.g. from GitLab webhooks):
```
Coder → agent.codingComplete
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

### Key Differences from Previous Flow

| Aspect | Before | After |
|---|---|---|
| DevOps completion | Triggers Architect | STOPS (pipeline ends for infra chat) |
| Feature interview | Same as project interview | Separate `startFeatureInterview()` / `continueFeatureInterview()` on Interviewer |
| Workspace | Shared workspace for all agents | Worktree per session, main workspace for infra |
| Issue scoping | All issues in project | Session issues filtered by `chatSessionId` |
| Coder in session | Feature branch + MR per issue | Direct commits on session branch, no MR |
| Review/Test in session | Full pipeline per issue | Skipped — session merge replaces per-issue review |
| New events | — | `session.devSessionCreated`, `agent.featureInterviewComplete` |
| New task types | — | `FEATURE_INTERVIEW`, `INFRA_COMMAND` |
| Infra after setup | One-shot | YOLO mode (persistent, MCP-based) |

### Interviewer Agent (2 Modes)
- **Project Interview** (`startInterview()` / `continueInterview()`): Initial project interview in Infrastructure Chat. Gathers tech stack, features, deployment requirements. Triggers `agent.interviewComplete` → DevOps setup.
- **Feature Interview** (`startFeatureInterview()` / `continueFeatureInterview()`): Per-session interview in Dev Session Chats. Gathers feature requirements within the context of an existing project. Triggers `agent.featureInterviewComplete` → Architect. Task type: `FEATURE_INTERVIEW`.

### Architect Agent (2 Phasen)
- **Phase A — Design** (after Feature Interview in Dev Session, Task: `DESIGN_ARCHITECTURE`)
  - Reads session features from `FeatureInterviewResult` (stored in FEATURE_INTERVIEW AgentTask output)
  - Includes ENVIRONMENT.md context from the session worktree
  - Liest Projektstruktur via MCP Filesystem (bestehender Code) oder entwirft Architektur (leeres Repo)
  - Postet Architektur-Überblick als Chat-Message
  - Adaptiv: Analysiert vorhandenen Code ODER designt von Grund auf
- **Phase B — Grounding** (nach Issue Compiler, Task: `ANALYZE_ISSUES`)
  - Iteriert nur über OPEN Issues der aktuellen Session (filtered by `chatSessionId`)
  - Pro Issue: Liest relevanten Code via MCP → postet Grounding-Kommentar auf das Issue
  - Kommentar enthält: Relevante Dateien, zu erstellende Dateien, Approach, Patterns
  - Nutzt `postAgentComment()` → sichtbar in GitLab + lokaler DB
  - Coder bekommt Grounding via `getAgentCommentHistory()` automatisch
- **MCP-Server**: filesystem, sequential-thinking (konfigurierbar via MCP Registry)
- **Fallback**: Wenn kein MCP konfiguriert → Plain LLM Call

### Coder Agent
- Nutzt **MCP Agent Loop**: Ollama (Tool-Calling) + MCP Filesystem Server
- LLM liest/schreibt/editiert Dateien selbst über MCP-Tools (read_file, write_file, edit_file, search_files, directory_tree etc.)
- **Session mode** (Dev Session): Works in session worktree (`resolveWorkspace()`), direct commits on session branch — no feature branch, no MR per issue. Only processes issues with matching `chatSessionId`.
- **Standalone mode** (outside session): Pro Issue: Feature-Branch erstellen → Agent Loop (LLM ↔ Tools) → Commit & Push → GitLab MR → Issue IN_REVIEW
- Fix-Modus: Bestehenden Branch auschecken, Feedback in Prompt, Push auf MR
- 10 Minuten Timeout, max 30 Iterationen

### MCP Integration (McpModule)
- **McpClientService**: Startet MCP-Server als Subprozesse (stdio) oder verbindet Remote-Server (HTTP/StreamableHTTP), verwaltet Connections, Tool-Discovery
- **McpAgentLoopService**: Generischer Agent-Loop (LLM-Call → tool_calls → MCP-Execution → Repeat)
- **Filesystem MCP Server**: `@modelcontextprotocol/server-filesystem` — 14 Tools (read, write, edit, search, tree etc.)
- **Shell MCP Server**: `shell-server.mjs` — `run_command` Tool für Shell-Befehle im Workspace
- **Vaadin MCP Server**: Remote HTTP-Server (`https://mcp.vaadin.com/`) — Vaadin Flow Doku, Component API, Best Practices
- **Spring Docs MCP**: `@enokdev/springdocs-mcp` — Spring Boot, Data JPA, Security Doku und Guides
- **Sandboxing**: MCP-Server erhalten nur Zugriff auf den Workspace-Ordner des Projekts
- **Transport**: stdio (lokale Server) + StreamableHTTPClientTransport (remote Server via URL)

### MCP Server Registry
- **McpRegistryService**: CRUD für MCP-Server-Definitionen, Rollen-Zuordnung, Runtime-Auflösung, Project Overrides
- **McpRegistryController**: 6 REST-Endpoints unter `/api/mcp-servers` (Admin only)
- **McpProjectOverrideController**: 3 REST-Endpoints unter `/api/projects/:projectId/mcp-overrides` (Admin, PM)
- **16 Built-in Server**: filesystem, git, gitlab, prisma, angular-cli, vaadin (remote HTTP), spring-docs, shell, playwright, eslint, security-audit, postgres, docker, sequential-thinking, memory, searxng — beim Start geseeded, nicht löschbar
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
- **MCP Agent Loop** — Shell-Zugriff auf Workspace (filesystem, shell, git MCP-Server)
- Holt Issue-Description + Acceptance Criteria (Sub-Issues) + MR-Diffs
- **Kontext-Injection**: Bekommt Kommentare von Coder + Code Reviewer als LLM-Kontext
- Kann Build/Tests selbst ausführen (`npm run build`, `npm test`, `mvn compile`, `mvn test`)
- LLM prüft ob Code die Criteria erfüllt — verifiziert durch echte Build/Test-Ergebnisse
- **Fallback**: Plain LLM-Call wenn kein Workspace/MCP verfügbar
- **retryJsonExtraction**: Zweistufig — bei leeren Findings ODER komplettem Parse-Failure
- PASS: Alle Criteria adressiert, keine Critical Findings → UI Tester
- FAIL: → Coder fixIssue() mit Test-Feedback

### UI Tester Agent
- **MCP Agent Loop** — Shell-Zugriff auf Workspace (filesystem, shell, git MCP-Server)
- Kann Build/Compilation verifizieren und Templates/Styles im vollen Kontext lesen
- Wenn Preview-URL vorhanden: Optional Playwright (Headless Chromium Screenshots, DOM-Snapshot, Accessibility-Audit)
- **Visual Screenshot Analysis (Multimodal)**: Screenshots werden als PNG im Workspace gespeichert (`{workspace}/.ui-screenshots/{issueId}/`), dann per multimodaler LLM-Call analysiert (Anthropic/Google/OpenAI/Ollama). Die visuelle Analyse wird ins Haupt-Prompt injiziert.
  - **Screenshot Manifest**: `manifest.json` mit Metadaten (Route, Viewport, LLM-generierte Beschreibung, gefundene Issues) — wird vom Documenter für Wiki-Pages konsumiert
  - **Image Limit**: Max 6 Screenshots pro Analyse (Token-Budget), priorisiert Desktop + Responsive Viewports
  - **Provider-Fallback**: CLI-Provider (Claude Code, Codex, etc.) unterstützen keine Inline-Images → automatischer Fallback auf Cloud-Provider
- **Fallback**: Dual-LLM-Call wenn kein Workspace/MCP verfügbar (zwei Provider, Findings gemergt)
- **Kontext-Injection**: Bekommt Kommentare von Coder + Code Reviewer + Functional Tester als LLM-Kontext
- Prüft: Layout, Responsivität, Accessibility (WCAG 2.1 AA), Visuals, Interaktionen
- **retryJsonExtraction**: Zweistufig — bei leeren Findings ODER komplettem Parse-Failure
- PASS: Keine Critical Findings, ≤3 Warnings → Pen Tester
- FAIL: → Coder fixIssue() mit UI-Feedback

### Pen Tester Agent
- **MCP Agent Loop** — Shell-Zugriff mit echten Security-Tools:
  - `semgrep --config auto --json .` — SAST Pattern-basierte Code-Analyse
  - `trivy fs --scanners vuln,secret,misconfig --format json .` — Filesystem Vulnerability + Secret Scanning
  - `nuclei` — Template-basiertes Vulnerability Scanning (wenn Preview-URL vorhanden)
  - `nmap` — Port/Service Scanning (wenn Preview-URL vorhanden)
  - `npm audit --omit=dev --json` — Dependency Vulnerability Audit
- **Pre-Checks**: npm audit + HTTP-Header-Check laufen vor dem MCP-Loop und werden als Kontext mitgegeben
- Security-Header-Check (CSP, HSTS, X-Frame-Options, etc.) gegen Preview-URL — abschaltbar via `pentester.skipHeaderCheck`
- **Tech-Stack-Kontext**: Project techStack (Framework, Backend, Projekttyp) wird ins LLM-Prompt injiziert → kontextbewusste Analyse
- **Kontext-Injection**: Bekommt alle bisherigen Agent-Kommentare als LLM-Kontext
- **Fallback**: Dual-LLM-Call wenn kein Workspace/MCP verfügbar
- **Konfigurierbare Schwellen**: `pentester.maxWarnings` (default: 3) — PASS/FAIL wird server-seitig anhand der Findings berechnet, nicht blind dem LLM vertraut
- **Rule-based Override**: Critical Findings → immer FAIL, unabhängig vom LLM-Urteil
- **retryJsonExtraction**: Zweistufig — bei leeren Findings ODER komplettem Parse-Failure
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
- **Pflicht-Updates nach jedem Merge**: `PROJECT_KNOWLEDGE.md` + `CHANGELOG.md`
- Optional: README.md, API-Docs, JSDoc
- **Hierarchical Wiki Structure**: Creates feature subpages `Features/Issue-{iid}-{slug}`, auto-updates `home` page with feature links, auto-regenerates `_sidebar` navigation from all wiki pages
- **Wiki-Sync**: ALL markdown files synced to GitLab Wiki (not just flagged ones)
- **Screenshot-Integration**: Liest UI Tester Screenshot-Manifest → lädt PNGs per GitLab Uploads API hoch → erstellt Wiki-Page `UI-Screenshots/Issue-{issueIid}` mit eingebetteten Screenshots, Beschreibungen und Findings
- **Cleanup**: Nach Upload + Issue DONE werden lokale Screenshots gelöscht (`{workspace}/.ui-screenshots/{issueId}/`), leerer Parent wird aufgeräumt
- Schreibt Dateien im Workspace, committed auf Feature-Branch
- Issue → DONE nach Abschluss

### DevOps Agent — CI/CD + YOLO Mode
- Generiert deterministische `.gitlab-ci.yml` basierend auf Tech-Stack
- Templates: Node/Angular/React (4 Stages), Python, Rust, Go, Java/Maven/Spring Boot/Vaadin (3 Stages), Generic
- Runner-Tags: `docker`, `vibcode`
- **Initiale Projekt-Dokumentation**: README.md, CHANGELOG.md, CONTRIBUTING.md, PROJECT_KNOWLEDGE.md
- **Wiki Scaffolding**: Creates `home`, `_sidebar`, `PROJECT_KNOWLEDGE`, `ENVIRONMENT`, `Architecture/Overview` wiki pages during project setup
- **ENVIRONMENT.md**: Generated during project setup in the workspace root — contains environment details, installed dependencies, tech stack summary, and workspace paths. Synced to GitLab Wiki. Used as context by other agents.
- **YOLO Mode** (`handleInfraCommand()`): After initial setup, the DevOps agent stays available in the Infrastructure Chat. User messages are treated as infrastructure commands and executed via MCP agent loop (filesystem, shell, git tools). Task type: `INFRA_COMMAND`. After each command, ENVIRONMENT.md is synced back to wiki.

### Project Knowledge Base — Wiki-First Architecture
- **Zentrales Gedächtnis**: GitLab Wiki ist die primäre Wissensquelle, lokale Workspace-Dateien sind Fallback
- **Wiki-First Pattern**: Alle Agents lesen Knowledge und Environment via Wiki API (mit File-Fallback bei 404/Timeout)
- **Schreiben**: DevOps + Documenter schreiben in Wiki UND lokale Dateien (Git-Tracking)
- **Wiki-Struktur**:
  - `home` — Projekt-Startseite mit Quick Links und Feature-Liste
  - `_sidebar` — Auto-generierte Navigation aus allen Wiki-Seiten
  - `PROJECT_KNOWLEDGE` — Akkumulatives Wissen (Tech Stack, Features, Patterns)
  - `ENVIRONMENT` — Tech Stack, Dependencies, Ports, MCP-Server
  - `Architecture/Overview` — System-Architektur
  - `Features/Issue-{iid}-{slug}` — Pro-Feature Dokumentation
  - `UI-Screenshots/Issue-{iid}` — Screenshots mit Beschreibungen
- **BaseAgent Methods**: `readKnowledge()`, `readEnvironment()`, `buildKnowledgeSectionWiki()` — Wiki-First mit File-Fallback
- **Injiziert in alle Agenten**:
  - Interviewer: Weiß was schon existiert → schlägt nur neue Features vor
  - Architect: Konsistente Architektur-Entscheidungen
  - Coder: Wiederverwendet bestehende Services/Patterns statt Code-Duplikation
  - Code Reviewer: Prüft gegen Projekt-Konventionen
  - Functional Tester: Versteht Feature-Kontext für bessere Tests
- Shared Utility in `BaseAgent`: `readProjectKnowledge(workspace)` + `buildKnowledgeSection(workspace)`

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
- WebSocket `/monitor` Namespace für Hardware-Stats (3s Push) + Agent-Log-Streaming
- GitLab Webhook unter `/api/gitlab/webhook` (ohne Auth, via X-Gitlab-Token)

### Monitor Module (Phase 4)

```
HardwareService (3s Polling)
  ├── nvtop -s → GPU Stats (2× RTX 3090)
  ├── /sys/class/hwmon → CPU Temp (k10temp AMD)
  ├── /proc/loadavg → CPU Load
  └── /proc/meminfo → RAM Usage
      ↓
MonitorGateway (WebSocket /monitor)
  ├── hardwareStats → alle Connected Clients (3s)
  ├── hardwareHistory → auf Connect (letzte 60 Snapshots)
  ├── agentLogEntry → Log Rooms (logs:project:{id}, logs:all)
  └── llmCall → Log Rooms
      ↓
MonitorController (REST /api/monitor/)
  ├── GET /hardware → Snapshot
  ├── GET /hardware/history → Sparkline-Daten
  ├── GET /logs → AgentLog mit Filtern
  ├── GET /activity → Unified Timeline
  └── GET /agents/overview → Agent-Rollen-Aggregation
```

BaseAgent.log() emittiert automatisch Agent-Logs per WebSocket an relevante Rooms (nicht für DEBUG-Level).

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
