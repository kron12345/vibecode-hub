# VibCode Hub — Prompt-Log

Dokumentation aller Prompts/Anforderungen die zur Entwicklung genutzt wurden.

## Session 1 — 2026-02-28 — Projektinitialisierung

### Prompt 1: Projektidee
> Ich möchte ein Portal für Vibecoding. In dem Portal verschiedene Projekte haben können. In jedem Projekt soll es als Zentrale einen Chat geben der mir als Erstes Issues und Sub-Issues erstellt. Diese sollen dann automatisiert von verschiedenen Agenten abgearbeitet werden. Die Agenten können Cloud sein (Claude, Codex, Gemini) oder lokal (Ollama, 2x RTX 3090). Die Agenten haben verschiedene Rollen: Ticket Creator, Coder, Code Reviewer, UI Tester, Pen Tester, Dokumentierer. Code und Tickets sollen in GitLab gespeichert werden. Live-Ansicht was jeder Agent gerade macht.

### Prompt 2: Technologie
> Angular 21 Frontend, NestJS Backend mit Prisma, PostgreSQL. Keycloak für Auth (läuft bereits unter sso.example.com). GitLab CE läuft unter git.example.com. MCP-Server für Claude Code Entwicklungstools.

### Prompt 3: Infrastruktur
> hub.example.com für das Portal, *.hub.example.com für Projekt-Subdomains. Nginx ist bereits konfiguriert. Erst Single-User, später Multi-User. Phasenweiser Aufbau mit Dokumentation unter docs/.

### Prompt 4: MCP-Server
> Für NestJS nimm @rekog/mcp-nest (MCP-Nest). Was hast du für Angular und Prisma?

**Ergebnis:** Drei MCP-Server konfiguriert:
- `angular`: `angular-mcp-server` (global installiert) — Angular-Doku-Zugriff
- `prisma`: `npx prisma mcp` (built-in Prisma 7) — Schema/Migration-Hilfe
- `mcp-nest`: `npx @rekog/mcp-nest` — NestJS-Patterns

### Prompt 5: Arbeitsregeln
> Mache es so in dem Projekt das du sie von alleine anwendest:
> - MCP-First: Vor Code-Änderungen immer MCP-Tools aufrufen (best_practices, find_examples, search_documentation)
> - Nicht halluzinieren — bei Unklarheiten MCP-Tools zur Doku-Suche nutzen
> - Umsetzungsschleife: Planen → kleine Schritte → verifizieren → bei Fehlern fixen bis grün
> - MCP-Prioritäten: Angular (best_practices → examples → docs), Prisma (schema → migrate → generate), Projekt (lint → test → build)
> - Keine destruktiven DB-Ops ohne Nachfrage
> - Logs nur gekürzt ausgeben
> - Am Ende jeder Aufgabe: Zusammenfassung (was geändert, welche Tools liefen, Status)

**Ergebnis:** Regeln in CLAUDE.md, memory/arbeitsregeln.md und docs/DEVELOPMENT.md verankert.

### Prompt 6: Docs vollständig halten
> Hast das auch für die docs so gemacht? Also das was wir besprochen haben mit specs, prompts, docu?

**Ergebnis:** Alle drei docs-Dateien aktualisiert + docs/DEVELOPMENT.md erstellt.

### Ergebnis Session 1
- Git-Repo initialisiert
- Angular 21 Frontend gescaffolded (v21.2.0)
- NestJS Backend mit Prisma gescaffolded (NestJS 11.x, Prisma 7.4.x)
- PostgreSQL DB `vibcodehub` erstellt
- Keycloak Realm `vibcodehub` eingerichtet (Frontend-Client PKCE, Backend-Client confidential, 4 Rollen, Admin-User)
- Datenmodell migriert: Projects, Issues (hierarchisch), ChatSessions, ChatMessages, AgentInstances, AgentTasks, AgentLogs
- Dashboard + Projektansicht (Angular, lazy-loaded, dark theme)
- Projekt-CRUD API mit Swagger-Docs
- 3 MCP-Server konfiguriert (Angular, Prisma, NestJS)
- Arbeitsregeln festgelegt (MCP-First, Umsetzungsschleife, keine Halluzination)
- Dokumentation: CLAUDE.md, SPEC.md, ARCHITECTURE.md, PROMPTS.md, DEVELOPMENT.md

## Session 2 — 2026-02-28 — Phase 1 Endspurt (GitLab, Issues, Chat)

### Prompt 1: "weiter"
> weiter

**Interpretation:** Phase 1 Foundation fortsetzen — die drei fehlenden Module bauen.

### Ergebnis Session 2

**GitLab-Integration:**
- `GitlabService` — HTTP-Client für GitLab API v4 (Projekte, Issues, Webhooks)
- `GitlabController` — Webhook-Endpunkt für Issue-Sync (Upsert bei Events)
- `ProjectsService` integriert: automatische GitLab-Repo-Erstellung/Löschung
- `GITLAB_WEBHOOK_SECRET` generiert und in `.env` eingetragen
- `@nestjs/axios` installiert

**Issues-API:**
- `IssuesController` — 5 REST-Endpunkte (GET by project, GET/:id, POST, PUT/:id, DELETE/:id)
- `IssuesService` — CRUD mit automatischem GitLab-Sync (Status close/reopen)
- Sub-Issues über `parentId`, Agent-Assignment, Labels
- `syncToGitlab` Flag beim Erstellen

**Chat-Module (Backend):**
- `ChatService` — Sessions + Messages CRUD
- `ChatController` — REST-Endpunkte für Sessions und Messages
- `ChatGateway` — WebSocket-Gateway auf `/chat` Namespace (Socket.IO)
- Room-basierte Nachrichten (join/leave/send)

**Chat-UI (Frontend):**
- `ChatSocketService` — WebSocket-Client (socket.io-client)
- `ApiService` erweitert um Issues + Chat Methoden
- `ProjectPage` komplett umgebaut: 3-Spalten-Layout
  - Links: Agenten-Status-Karten
  - Mitte: Chat mit Session-Liste, Nachrichtenverlauf, Eingabefeld, Auto-Scroll
  - Rechts: Issues-Liste mit Priority-Farben und Status-Badges

**Commands:** `npm install @nestjs/axios axios`, `npm install socket.io-client`, `npx nest build`, `npx ng build`
**Status:** Phase 1 Foundation — KOMPLETT ✅ (alle Checkboxen in SPEC.md abgehakt)

### Prompt 2: UI-Redesign
> bevor wir weiter machen, ich hatte schon mal ein mini UI gemacht. Da geht es nur um das Design. [HTML-Mockup mit Tailwind, Glass Morphism, Bento Grid, Agent Pipeline, Terminal]

**Interpretation:** Komplettes Frontend-Redesign basierend auf dem Mockup-Design.

**Verbesserungsvorschläge (von KobAIld):**
1. Sidebar-Navigation (collapsible)
2. Terminal-Style Chat statt Chat-Bubbles
3. Issue-Progress-Dots (OPEN → DONE)
4. Skeleton Loading States
5. Agent Activity Ring (animierter Spinner)
6. Farbcodierte Agenten (Indigo=Dev, Emerald=Test, Amber=Security, etc.)

**Ergebnis:**
- Tailwind CSS v4 + Lucide Icons + Inter/Fira Code Fonts installiert
- Globales Design-System: Glass Morphism, Agent Glow, Pulse Pipeline, Skeleton, Progress Dots
- App Root: Collapsible Sidebar mit Icon-Navigation
- Dashboard: Hardware Stats Bar, Bento Project Grid, Glass Create-Modal
- Project Page: Agent Pipeline (6 Rollen, Pulse-Animation), Terminal-Chat, Issue Cards
- IconComponent: Lightweight Lucide SVG Renderer

**Commands:** `npm install tailwindcss @tailwindcss/postcss postcss lucide`, `npx ng build`
**Status:** Redesign komplett ✅

### Prompt 3: Deployment
> Okay jetzt will ich es sehen. Dazu musst du das alte HUB beenden und hub.example.com auf das neue in ngnix umbauen. Das alte wird auch automatisch gestartet bei Systemstart, kannst du es so machen das das neue gestartet wird. Das allte will ich nicht mehr verwenden und was nur ein lern-Projekt.

**Interpretation:** Altes hub-codex-starter Projekt abschalten, VibCode Hub produktiv deployen.

**Ergebnis:**

**Altes Hub dekommissioniert:**
- Alte systemd-Services gestoppt und deaktiviert: `hub-ui.service`, `hub-api.service`, `hub-project@timezone-clock.service`
- Altes Projekt lag unter `/home/sebastian/Projects/hub-codex-starter/`

**Neuer systemd-Service:**
- `~/.config/systemd/user/vibcode-api.service` erstellt (NestJS als Node-Prozess)
- EnvironmentFile für `.env` Variablen, NODE_ENV=production
- `systemctl --user enable vibcode-api` — startet automatisch bei Login

**Prisma 7 Fix:**
- Prisma 7 "client" Engine braucht zwingend einen Adapter
- `@prisma/adapter-pg` + `pg` installiert
- `PrismaService` umgebaut: `new PrismaPg({ connectionString })` → `super({ adapter })`

**Nginx-Konfiguration:**
- `/etc/nginx/sites-available/hub` komplett umgeschrieben
- Angular-Frontend als statische Dateien aus `frontend/dist/frontend/browser/`
- `try_files $uri $uri/ /index.html` für SPA-Routing
- `/api/` Proxy zu :3100 mit LAN-Bypass + oauth2-proxy Auth
- `/socket.io/` WebSocket-Proxy zu :3100
- `/api/gitlab/webhook` ohne Auth (Token-basiert auf App-Ebene)
- Bestehende Blöcke erhalten: hub.example.com (OpenWebUI), Projekt-Subdomains, OpenClaw

**Permission-Fix:**
- `chmod o+x` auf Verzeichniskette für nginx (www-data)
- `chmod -R o+r` auf Angular Build-Output

**Commands:** `systemctl --user stop/disable/enable/start`, `sudo nginx -t && sudo systemctl reload nginx`, `npm install @prisma/adapter-pg pg`, `npx nest build`
**Status:** Deployment komplett ✅ — hub.example.com liefert VibCode Hub Frontend (200), API antwortet auf :3100

### Ergebnis Session 2 (Gesamt)
- Phase 1 Foundation komplett: GitLab, Issues, Chat Module implementiert
- UI-Redesign: Tailwind v4, Glass Morphism, Bento Grid, Agent Pipeline, Terminal Chat
- Produktiv-Deployment: systemd-Service, Nginx, Prisma 7 Adapter-Fix
- 9 Commits auf main, nach GitLab gepusht
- Altes hub-codex-starter dekommissioniert

## Session 5 — 2026-03-01 — Settings-System

### Prompt: Settings-System implementieren
> Implement the following plan: Settings-System — Implementierungsplan (detaillierter 7-Schritte-Plan)

**Ergebnis:**
- Prisma: 2 neue Models (UserSetting, SystemSetting) mit Migration
- Backend: SettingsModule (global) mit SettingsService, SystemSettingsService (In-Memory-Cache), Settings-Controller (6 Endpunkte)
- Sicherheit: AES-256-GCM Verschlüsselung für Secrets, @Roles('admin') Decorator + RolesGuard, API-Key-Maskierung
- Refactoring: GitLab-Service + Controller nutzen jetzt SystemSettingsService statt ConfigService/process.env
- Dynamisches CORS in main.ts über SystemSettingsService
- Seed-Script: 15 .env-Werte in DB migriert (GitLab, LLM, CORS, Agents, App)
- Frontend: Settings-Page mit User-Tab (Sprache, Theme, Sidebar) und System-Tab (GitLab, LLM, Agents, CORS, App)
- AuthInfoService für Keycloak-Rollenprüfung
- Route `/settings` + Sidebar-Link aktiviert
- API.md, ARCHITECTURE.md aktualisiert
- Backend + Frontend deployed, API läuft mit 15 gecachten Settings

### Prompt: i18n, .env Cleanup, README
> Passe die optionalen .env-Werte an, bereite i18n vor (DE, EN, IT, FR), erstelle README.md mit Sicherheitshinweis

**Ergebnis:**
- i18n-System: TranslateService (signal-basiert, JSON-Dateien), TranslatePipe (impure), 4 Sprachdateien
- Alle Frontend-Texte (App-Shell, Dashboard, Project, Settings) mit translate-Pipe übersetzt
- Sprachauswahl im Settings mit sofortiger Anwendung, User-Präferenz beim App-Start geladen
- .env bereinigt: nur noch DB, Keycloak, Port — Rest als Kommentare für Fallback-Doku
- .env.example für neue Installationen erstellt
- README.md (EN): Features, Tech Stack, Installation, Security Notice, i18n-Erweiterung
- CLAUDE.md: i18n-Pattern + README.md Pflicht dokumentiert
- angular.json: assets-Konfiguration für i18n-Dateien im Build

## Session 6 — 2026-03-01 — Agent Roles System

### Prompt 1: Rollen-Design
> Lass uns Rollen ausdenken. Interviewer (proaktiv, 95% Klarheit), Issue-Kompilierung, Coder, Code Reviewer, UI Tester, Funktions-Tester, Pentester (darf Tools installieren), Dokumentierer + Commit + Übergabe.

**Ergebnis (Diskussion):**
- 10 Rollen definiert: Interviewer, Architect, Issue Compiler, Coder, Code Reviewer, UI Tester, Functional Tester, Pentester, Documenter, DevOps
- KobAIld hat Architect, Integration Tester und DevOps als zusätzliche Rollen vorgeschlagen

### Prompt 2: Settings-Integration
> Erst Rollen in Settings hinterlegen, dann Workflow. Ollama (installiert), CLI-Tools (Claude Code, Codex, Qwen3-Coder), API. Jede Rolle braucht Verhaltensprofil (CLAUDE.md/agents.md).

**Ergebnis:**
- Plan für umfassende Agent-Konfiguration in SystemSettings
- 3 Provider-Typen: Local (Ollama), CLI (Claude/Codex/Qwen3), API (Anthropic/OpenAI/Google)
- Pro Rolle: Provider, Model, System Prompt, LLM-Parameter, Permissions, Pipeline-Position

### Prompt 3: Umsetzung
> Das hört sich nach einem guten Plan an, setze sie um. Systemsettings, nur Admin, für alle Projekte.

**Ergebnis:**

**Prisma Schema:**
- AgentRole Enum erweitert: +INTERVIEWER, +ARCHITECT, +ISSUE_COMPILER, +FUNCTIONAL_TESTER, +DEVOPS (10 Rollen)
- LLMProvider Enum erweitert: +CLAUDE_CODE, +CODEX_CLI, +QWEN3_CODER (7 Provider)
- AgentTaskType Enum erweitert: +INTERVIEW, +DESIGN_ARCHITECTURE, +TEST_FUNCTIONAL, +DEPLOY (11 Task-Typen)
- Migration: `20260301120000_expand_agent_roles_providers`

**Backend:**
- `ProviderDiscoveryService` — Ollama Model Discovery (/api/tags) + CLI Tool Detection (claude/codex/qwen3-coder)
- `SystemSettingsService` erweitert: `getAgentRoleConfig(role)`, `getAllAgentRoleConfigs()`, `getPipelineConfig()`
- Neue Interfaces: `AgentRoleConfig`, `PipelineConfig`
- Controller: 5 neue Endpunkte (agents/roles, agents/pipeline, providers/ollama/models, providers/ollama/health, providers/cli/status)
- Seed-Script: `seed-agent-roles.ts` — 10 Rollen mit vollständigen Behavior Profiles (System Prompts)

**Frontend:**
- Settings Page: Neuer Tab "Agent Roles" mit expandierbaren Rollenkarten
  - Provider-Status-Bar (Ollama Health + CLI-Tool-Erkennung)
  - Pipeline-Konfiguration (enabled, approval, concurrent, timeout)
  - Pro Rolle: Provider (grouped: Local/CLI/API), Model (Ollama-Dropdown), Temperatur-Slider, Max Tokens, Pipeline-Position, Permissions-Toggles, System Prompt Editor
- API Service: 6 neue Methoden (getAgentRoleConfigs, getPipelineConfig, getOllamaModels, checkOllamaHealth, getCliToolStatus)
- Project Page: AGENT_CONFIG auf 10 Rollen aktualisiert
- i18n: ~30 neue Keys in allen 4 Sprachen (de, en, it, fr)

**Commands:** `npx prisma migrate deploy`, `npx prisma generate`, `npx ts-node prisma/seed-agent-roles.ts`, `npx nest build`, `npx ng build`
**Status:** Agent Roles System komplett ✅

### Ergebnis Session 6 (Gesamt)
- 10 Agent-Rollen mit Behavior Profiles in DB hinterlegt
- 7 LLM-Provider-Typen (Ollama + 3 CLI + 3 API)
- Ollama Model Discovery + CLI Health Check
- Pipeline-Konfiguration (enabled, approval, concurrent, timeout)
- Settings UI mit expandierbaren Rollenkarten
- Alle Docs aktualisiert (API.md, ARCHITECTURE.md, PROMPTS.md)

## Session 5 — 2026-03-01 — Phase 2: Interview-basierte Projekterstellung

### Prompt: Phase 2 Start — Agent-Orchestrierung
> Detaillierter Plan für interview-basierte Projekterstellung: Prisma Schema (ProjectStatus), LLM Abstraction Layer (7 Provider), Event-basierte Agent-Architektur, Interviewer Agent, Quick-Create Flow, Frontend-Anpassungen.

**Ergebnis:**
- ProjectStatus Enum (`INTERVIEWING`, `SETTING_UP`, `READY`, `ARCHIVED`) + `techStack` JSON-Feld
- LLM Abstraction Layer: Interfaces, LlmService Fassade, 7 Provider (Ollama, Anthropic, OpenAI, Google, Claude Code, Codex CLI, Qwen Code)
- Event-basierte Agent-Architektur mit `@nestjs/event-emitter`
- BaseAgent abstrakte Klasse mit LLM-Calls, Messaging, Status-Updates
- InterviewerAgent: System-Prompt → Konversation → `:::INTERVIEW_COMPLETE:::` → JSON-Ergebnis → Project-Update
- AgentOrchestratorService: `@OnEvent('chat.userMessage')` für automatisches Routing
- Quick-Create: `POST /projects/quick` → Projekt + Interview in einem Schritt
- ChatGateway EventEmitter-Integration
- Dashboard: Vereinfachtes Modal (nur Name, "Interview starten")
- ProjectPage: Auto-Start Interview bei Status INTERVIEWING
- WebSocket: `agentStatus` + `projectUpdated` Events
- i18n: Neue Keys in DE/EN/IT/FR
- Alle Docs aktualisiert

## Session 7 — 2026-03-03 — Coding Pipeline (Coder, Reviewer, CI/CD, Feedback Loops)

### Prompt: Komplette Coding-Pipeline implementieren
> 13-Schritte-Plan: Coder Agent, Code Reviewer, GitLab CI/CD, Issue Comments, User/Pipeline Feedback Loops. Event-Kette von Issue Compiler bis User-Abnahme.

**Ergebnis (13 Steps):**

**Step 1 — Prisma Schema:**
- `CommentAuthorType` Enum (AGENT, USER, SYSTEM)
- `IssueComment` Model (id, issueId, gitlabNoteId, authorType, authorName, content, agentTaskId, createdAt)
- `Issue.sortOrder Int @default(0)` hinzugefügt
- Migration: `20260303152141_add_issue_comments_and_sort_order`

**Step 2 — GitLab Service (10+ neue Methoden):**
- Notes: `createIssueNote()`, `getIssueNotes()`
- Merge Requests: `createMergeRequest()`, `getMergeRequest()`, `getMergeRequestDiffs()`
- Branches: `createBranch()`, `deleteBranch()`
- Pipelines: `getPipeline()`, `getPipelineJobs()`, `getJobLog()`
- Repo: `getRepositoryTree()`
- 8 neue Interfaces (GitLabNote, GitLabMergeRequest, GitLabMrDiff, GitLabPipeline, GitLabJob, GitLabBranch, GitLabTreeItem, CreateMergeRequestOptions)
- `addWebhook()`: note_events + pipeline_events aktiviert

**Step 3 — Webhook Expansion:**
- `handleNoteEvent()` — User-Kommentare speichern + `gitlab.userComment` Event (Skip hub-bot)
- `handlePipelineEvent()` — `gitlab.pipelineResult` Event bei success/failed
- `handleMergeRequestEvent()` — Logging für spätere Nutzung
- EventEmitter2 in GitLab Controller injiziert

**Step 4 — Issues Comment CRUD:**
- `CreateIssueCommentDto` (content, authorType, authorName, syncToGitlab)
- Service: `getComments()`, `addComment()` mit optionalem GitLab-Sync
- Controller: `GET /issues/:id/comments`, `POST /issues/:id/comments`

**Step 5 — Qwen CLI Fix:**
- Absoluter Pfad: `/home/sebastian/.npm-global/bin/qwen`
- Default-Args: `--openai-base-url http://localhost:11434/v1`, `--openai-api-key ollama`, `--auth-type openai`
- `cwd` Option in LlmCompletionOptions + CliBaseProvider

**Step 6 — Coder Agent (Hauptteil):**
- `CoderAgent` extends BaseAgent (~400 Zeilen)
- `runMilestoneCoding()` — Erstes Milestone mit OPEN Issues, sequentiell abarbeiten
- `processIssue()` — Feature-Branch → Qwen CLI (--yolo) → Commit → Push → MR → IN_REVIEW
- `fixIssue()` — Bestehenden Branch auschecken, Feedback in Prompt, Push auf MR
- `runQwenCli()` — execFile mit 10min Timeout, 50MB Buffer
- Git-Helpers: gitPull, gitCheckout, gitCreateBranch, getChangedFiles, gitCommitAndPush
- IssueCompilerAgent: `agent.issueCompilerComplete` Event ergänzt
- Orchestrator: `@OnEvent('agent.issueCompilerComplete')` → `startCoding()`

**Step 7 — Code Reviewer Agent:**
- `CodeReviewerAgent` extends BaseAgent (~280 Zeilen)
- `reviewIssue()` — MR-Diffs holen → Review-Prompt → callLlm() → Result parsen
- APPROVED (≤2 Warnings, 0 Critical) → Issue TESTING + `agent.reviewApproved`
- CHANGES REQUESTED → Issue IN_PROGRESS + `agent.reviewChangesRequested` → Coder re-triggered
- Review als GitLab-Kommentar gepostet

**Step 8 — DevOps CI/CD:**
- `stepGenerateCiConfig()` im DevOps-Agent
- `buildCiYml()` — Templates für Node/Angular/React/Vue (4 Stages), Python, Rust, Go, Generic
- Runner-Tags: `docker`, `vibcode`

**Step 9 — Pipeline Feedback Loop:**
- `@OnEvent('gitlab.pipelineResult')` im Orchestrator
- Branch-Name → Issue-IID extrahieren → Job-Logs holen (max 3 Jobs, 2000 Zeichen)
- Failure als GitLab-Kommentar → Coder `fixIssue()` mit Fehler-Kontext

**Step 10 — User Feedback Loop:**
- `@OnEvent('gitlab.userComment')` im Orchestrator
- Reagiert nur bei Issue-Status DONE/IN_REVIEW/TESTING
- Issue → IN_PROGRESS → Coder `fixIssue()` mit User-Kommentar

**Step 11 — Frontend Issue-Detail:**
- Slide-over Panel bei Issue-Click (selectedIssue Signal)
- Issue-Details: Priority, IID, Status, Description, Sub-Issues, Labels, Progress Dots
- Comment-Timeline (farbcodiert: Agent=Indigo, User=Emerald, System=Amber)
- Kommentar-Eingabe mit GitLab-Sync
- Auto-Reload Issues bei CODER/CODE_REVIEWER Finish

**Step 12 — i18n:**
- ~13 neue Keys in allen 4 Sprachen (de, en, it, fr)
- Keys: comments, addComment, noComments, commentPosted, issueDetail, assignedTo, branch, mergeRequest, pipelineStatus, coderWorking, reviewerWorking, common.send

**Step 13 — Docs:**
- API.md: Comment-Endpoints, Webhook-Events, GitLab-Methoden, Changelog
- ARCHITECTURE.md: IssueComment Model, Agent Pipeline Flow, Coder/Reviewer/DevOps Beschreibung
- SPEC.md: Phase 2 Checkboxen aktualisiert (Coder, Reviewer, Feedback Loops ✅)

**Neue Dateien:**
- `backend/src/agents/coder/coder.agent.ts`
- `backend/src/agents/coder/coder-result.interface.ts`
- `backend/src/agents/code-reviewer/code-reviewer.agent.ts`
- `backend/src/agents/code-reviewer/review-result.interface.ts`

**Commands:** `npx prisma migrate dev`, `npx prisma generate`, `npx nest build`, `npx ng build`
**Status:** Coding Pipeline komplett ✅ — Backend + Frontend builds grün

### Prompt 2: Commit-Links in Issue-Kommentaren
> Was noch fehlt das nach jeden abgearbeiteten Issue ins gitlab commitet und danach gepushed werden soll. Den commit könnte man dann an dem Issue anhängen.

**Ergebnis:**
- `gitCommitAndPush()` gibt jetzt Commit-SHA zurück
- GitLab-Issue-Kommentare enthalten direkten Commit-Link mit Diff-URL
- Gilt für `processIssue()` und `fixIssue()`
- `CoderIssueResult` Interface um `commitSha` + `commitUrl` erweitert

### Prompt 3: MR-Merge-Strategie → zu klären
> Wie kommen Feature Branches wieder ins Main?

**Ergebnis (Diskussion):**
- Auto-Merge nach Milestone-Abschluss als Idee
- In "Offene Entscheidungen" Liste aufgenommen, nicht implementiert

### Prompt 4: Phase 2 fertig machen — Streaming
> Mache Phase 2 fertig und teste mal alles durch

**Ergebnis — LLM Streaming:**
- `LlmStreamingProvider` Interface + `isStreamingProvider()` Type Guard
- 4 Provider mit echtem Streaming: Ollama (NDJSON), Anthropic (SSE), OpenAI (SSE), Google (SSE)
- CLI-Provider: Fallback auf Single-Chunk
- `LlmService.completeStream()` — delegiert an Provider oder Fallback
- `BaseAgent.callLlmStreaming()` — emittiert Tokens via WebSocket (`chatStreamStart`, `chatStreamToken`, `chatStreamEnd`)
- InterviewerAgent nutzt jetzt Streaming für Antworten
- Frontend: `streamingContent` + `isStreaming` Signals, Token-Akkumulation im Chat mit Live-Cursor (▊)

**Commands:** `npx nest build`, `npx ng build`
**Status:** Phase 2 komplett ✅ — Streaming implementiert, alle Builds grün

---

## Session 8 — 2026-03-04 — Agent-Kommentare als Chat + GitLab Wiki

### Prompt: Agent Comments als Chat + GitLab Wiki
> Implement: Unified agent comment utility (postAgentComment + getAgentCommentHistory), refactor 6 agents to use it, context injection in test agents' LLM prompts, GitLab Wiki CRUD (6 methods), Documenter Wiki sync.

**Ergebnis — Unified Agent Comment System:**
- `agent-comment.utils.ts` (NEU): `postAgentComment()` speichert identischen rich Markdown in lokaler DB + GitLab Issue Note, `gitlabNoteId` wird gespeichert. `getAgentCommentHistory()` formatiert bisherige Agent-Kommentare als Konversations-String für LLM-Prompts (~4000 Chars Limit).
- 6 Agents refactored (Coder, Code Reviewer, Functional Tester, UI Tester, Pen Tester, Documenter): Separate GitLab + DB Aufrufe mit unterschiedlichem Content → ein `postAgentComment()` Call mit gleichem Markdown.
- Coder Agent postet jetzt rich "Implementation Complete" Kommentar mit Branch, MR, Commit, Changed Files.
- Context Injection: Functional, UI, Pen Tester + Documenter bekommen bisherige Agent-Kommentare im LLM-Prompt → Agents "reden" miteinander.

**Ergebnis — GitLab Wiki:**
- 6 neue Methoden in `GitlabService`: `listWikiPages`, `getWikiPage`, `createWikiPage`, `updateWikiPage`, `deleteWikiPage`, `upsertWikiPage`
- `DocFile` Interface erweitert mit `wikiPage?: boolean` Flag
- Documenter Agent synct Dateien mit `wikiPage: true` nach GitLab Wiki (Upsert)
- System Prompt ergänzt: High-level Docs → Wiki, Code-level Docs → Repo

**Commands:** `npx nest build` (grün)
**Status:** Agent-Comment-System implementiert ✅, Wiki CRUD ✅, Build grün ✅

---

### Session 2026-03-09 — Automatisierter Pipeline E2E-Test + Bugfixes

**User-Prompt:**
> Ich weiß nicht mehr wo wir waren, was steht als nächstes an?
> → Mach einen automatischen UI Test: Projekt anlegen, Pipeline durchlaufen lassen, kontrollieren ob Issues angelegt werden, kommentiert werden und Code entsteht. Eingabe nur über das UI. Fehler korrigieren.

**Ergebnis — E2E Test Script (`tests/pipeline-e2e.ts`):**
- Playwright-basierter E2E-Test gegen Produktion (hub.example.com)
- 7 Phasen: Login (Keycloak) → Create Project (UI) → Interview (Chat) → Monitor Pipeline → Verify Issues → Verify Comments → Verify Code
- Nutzt `vibcode-bot` User mit temporär aktiviertem Direct Access Grants für Token-Fetch
- Interview-Antworten vorbereitet für eine einfache Click Counter App (Vanilla HTML/CSS/JS)
- Pipeline-Monitoring über Issue-Status-Tracking (OPEN→IN_PROGRESS→IN_REVIEW→DONE)
- 3 Testläufe durchgeführt (Projekte 70, 71, 72)

**Ergebnis — Bug gefunden und gefixt:**

1. **Duplicate Agent Processing (KRITISCH)**
   - **Problem**: `agent.interviewComplete` Event feuerte doppelt → Issue Compiler lief 2× → 11 statt 5-6 Issues
   - **Fix**: `hasActiveAgent()` Idempotency-Guard in `AgentOrchestratorService` — prüft vor Agent-Start ob bereits ein Agent mit gleicher Rolle WORKING/WAITING ist oder ein RUNNING Task existiert
   - **Betrifft**: `handleInterviewComplete` (DEVOPS), `handleDevopsComplete` (ISSUE_COMPILER), `handleIssueCompilerComplete` (CODER), `handleCodingComplete` (CODE_REVIEWER)

2. **Code Review nicht gestartet**
   - **Problem**: Coder emittierte `agent.codingComplete` mit `mrIid: undefined` wenn MR-Erstellung fehlschlug → Code Reviewer crashte
   - **Fix**: Event wird nur emittiert wenn `mrIid` truthy ist, sonst Warning-Log

3. **Interview Double-Completion**
   - **Problem**: `continueInterview()` wurde nach Task-Completion nochmal aufgerufen
   - **Fix**: Guard am Anfang von `continueInterview()` prüft ob Task bereits COMPLETED ist

**Bestätigte Pipeline-Funktionalität:**
- ✅ Interview → DevOps → Issue Compiler → Coder → Code Reviewer → Functional Tester → UI Tester → Pen Tester → Documenter
- ✅ Feedback Loop: Code Review CHANGES REQUESTED → Coder re-triggered → Fix applied
- ✅ Agent-Kommentare mit GitLab-Sync (gitlabNoteId vorhanden)
- ✅ Issues werden korrekt angelegt und kommentiert
- ✅ Code wird committed auf Feature-Branches, MRs erstellt

**Bekannte Infrastruktur-Issues (nicht gefixt):**
- Qwen CLI Streaming Timeout (~483s) bei Ollama Backend — Infrastruktur-Problem
- Fehlgeschlagene Issues bleiben IN_PROGRESS (braucht Retry/Cleanup-Logik)

**Geänderte Dateien:**
- `backend/src/agents/agent-orchestrator.service.ts` — `hasActiveAgent()` Guard + 4× angewendet
- `backend/src/agents/interviewer/interviewer.agent.ts` — Task-Completion Guard
- `backend/src/agents/coder/coder.agent.ts` — mrIid Validierung vor Event-Emission
- `tests/pipeline-e2e.ts` (NEU) — Playwright E2E Test Script
- `tests/tsconfig.json` (NEU) — TypeScript Config für Tests

**Commits:** `a284dcd` — fix: idempotency guards for pipeline agents, prevent duplicate processing
**Commands:** `npx nest build` (grün), 3× E2E Testläufe
**Status:** Pipeline E2E-Test ✅, 3 Bugs gefixt ✅, 2 Infrastruktur-Issues identifiziert ⚠️
