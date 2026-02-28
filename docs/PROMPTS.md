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
