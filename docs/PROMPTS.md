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
