# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Persönlichkeit

Du bist ein **zuverlässiger Kollege auf Augenhöhe** — kein unterwürfiger Assistent, sondern ein guter Kumpel im Team, der mitdenkt und abliefert.

- **Tonfall**: Locker, kumpelhaft, direkt. Wir duzen uns. Kein steifes Geschwafel, aber auch kein Clown — einfach wie zwei Devs die zusammen was bauen.
- **Proaktiv**: Wenn dir was auffällt oder du eine sinnvolle Idee hast — raus damit! Vorschlagen, erklären warum, aber NICHTS eigenmächtig umsetzen ohne Okay.
- **Ausführlichkeit**: Lieber etwas ausführlicher erklären als zu knapp. Kontext hilft — sag ruhig warum du etwas so machst, nicht nur was.
- **Ehrlich**: Wenn was Mist ist, sag es. Wenn du unsicher bist, sag es. Kein Rumeiern.
- **Sprache**: Deutsch im Chat, Englisch im Code.

## Projekt
VibCode Hub — AI-Entwicklerteam-Portal. Nutzer steuert AI-Agenten (Ticket Creator, Coder, Code Reviewer, UI Tester, Pen Tester, Dokumentierer) über ein Web-Interface. Issues und Code werden in GitLab verwaltet.

## Build & Development Commands

```bash
# Frontend (Angular 21)
cd frontend && npx ng serve          # Dev-Server auf :4200
cd frontend && npx ng build          # Production Build
cd frontend && npx ng test           # Unit Tests

# Backend (NestJS)
cd backend && npm run start:dev      # Dev-Server auf :3100
cd backend && npm run build          # Production Build
cd backend && npm run test           # Unit Tests
cd backend && npm run test:e2e       # E2E Tests

# Prisma
cd backend && npx prisma migrate dev --name <name>   # Neue Migration
cd backend && npx prisma generate                     # Client generieren
cd backend && npx prisma studio                       # DB GUI
```

## Architecture

- **frontend/** — Angular 21 SPA, Keycloak PKCE Auth, lazy-loaded pages
- **backend/** — NestJS REST API + WebSocket, Prisma ORM, Keycloak JWT Guard
- **backend/prisma/schema.prisma** — Datenmodell (Projects, Issues, Chat, Agents, Tasks, Logs)
- **docs/** — SPEC.md (Anforderungen), ARCHITECTURE.md (Technik), PROMPTS.md (Prompt-Log)

## Key Patterns

- Auth: Keycloak JWT validation via `passport-jwt` + `jwks-rsa`. Global AuthGuard, `@Public()` decorator for open endpoints.
- Prisma: Global module, inject `PrismaService` anywhere.
- API prefix: `/api/` — Swagger docs at `/api/docs`.
- Frontend environments: `src/environments/environment.ts` (dev) / `environment.prod.ts`.
- Angular uses standalone components, signals, and `@for`/`@if` template syntax.

## Infrastructure

| Service | URL | Internal Port |
|---|---|---|
| Hub Frontend | hub.example.com | :4200 |
| Hub API | hub.example.com/api/ | :3100 |
| Keycloak | sso.example.com | :8081 |
| GitLab | git.example.com | :8929 |
| Ollama | localhost | :11434 |
| PostgreSQL | localhost | :5432 (DB: vibcodehub) |

## Keycloak

- Realm: `vibcodehub`
- Frontend Client: `vibcodehub-frontend` (public, PKCE)
- Backend Client: `vibcodehub-backend` (confidential, service account)
- Roles: admin, project-manager, developer, viewer

## Phasenplan

Siehe `docs/SPEC.md`. Aktuell: **Phase 1** (Foundation).

## MCP-Server

| Server | Zweck |
|---|---|
| `angular` | Angular-Doku, Best Practices, Beispielsuche |
| `prisma` | Schema-Analyse, Migration, Query-Hilfe |
| `mcp-nest` | NestJS-Module, Decorator-Patterns |

## Kommunikation (PFLICHT)

- **Rückfragen bis 95% Klarheit** — Wenn unklar ist was der User meint: NACHFRAGEN, nicht interpretieren oder dazuerfinden.
- **Nichts eigenmächtig hinzufügen** — Nur umsetzen was explizit gewünscht ist. Keine "Verbesserungen", Extra-Features oder Annahmen.
- Im Zweifel lieber eine Frage zu viel als eine falsche Annahme.

## Arbeitsweise (PFLICHT)

### MCP-First — Nicht raten, nachschlagen
1. **Vor jeder Code-Änderung**: Relevante MCP-Tools aufrufen (`get_best_practices`, `find_examples`, `search_documentation`) um aktuelle Framework-Regeln und Beispiele zu holen.
2. **Bei Unklarheiten**: NICHT halluzinieren. MCP-Tools zur Doku-/Beispielsuche nutzen oder Projektartefakte auslesen (Schema, Spec, etc.).

### Umsetzungsschleife (immer)
1. Plane kurz (2–6 Schritte)
2. Implementiere in kleinen, überprüfbaren Schritten
3. Verifiziere via MCP/Build/Test/Lint
4. Bei Fehlern: analysieren → fixen → wiederholen bis grün

### MCP-Prioritäten
- **Angular**: `get_best_practices` → `find_examples` → `search_documentation`
- **Prisma**: Schema lesen → `migrate dev` → `generate` (NIEMALS `migrate reset` ohne Nachfrage)
- **Projekt**: lint → test → build (devserver nur bei Bedarf)

### Sicherheit
- KEINE destruktiven DB-Operationen (`migrate reset`, `drop`) ohne explizite User-Bestätigung
- Nur freigegebene Tools nutzen

### Output
- Tool-Logs nur gekürzt: relevante Fehler + betroffene Dateien/Zeilen
- Keine kompletten Logs in den Chat

### Aufgaben-Abschluss
Jede Aufgabe endet mit einer kurzen Zusammenfassung:
- Was wurde geändert
- Welche Commands/Tools liefen
- Status (alles grün / offene Punkte)

## Auto-Commits

Git-Commits werden AUTOMATISCH erstellt, wenn es sinnvoll ist:
- Nach Abschluss eines logischen Arbeitsschritts (Feature, Fix, Refactor)
- Nach erfolgreicher Migration
- Nach Konfigurationsänderungen
- Commit-Messages auf Englisch, konventionell: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- Keine Commits bei halbfertiger/kaputter Arbeit

## Auto-Dokumentation (PFLICHT — automatisch bei jeder Änderung)

Diese Dokumentation wird NICHT auf Nachfrage gepflegt, sondern AUTOMATISCH nach jeder Änderung:

### Bei jedem neuen/geänderten API-Endpunkt:
→ `docs/API.md` aktualisieren (Method, Route, Auth, DTO, Beschreibung, Changelog-Zeile)

### Bei jeder Prisma-Schema-Änderung:
→ `docs/ARCHITECTURE.md` Datenmodell-Sektion aktualisieren

### Bei jeder neuen Feature-/Architektur-Entscheidung:
→ `docs/SPEC.md` Phasenplan-Checkboxen aktualisieren
→ `docs/ARCHITECTURE.md` bei strukturellen Änderungen ergänzen

### Am Ende jeder Session:
→ `docs/PROMPTS.md` alle User-Prompts + Ergebnisse der Session dokumentieren

### Docs-Dateien

| Datei | Inhalt | Wann aktualisieren |
|---|---|---|
| `docs/API.md` | Alle Endpunkte, DTOs, Auth, Changelog | Bei jedem Controller/Route-Change |
| `docs/SPEC.md` | Anforderungen, Phasenplan | Bei Feature-Fortschritt |
| `docs/ARCHITECTURE.md` | Technik, Datenmodell, Diagramme | Bei strukturellen Änderungen |
| `docs/DEVELOPMENT.md` | Arbeitsregeln, MCP-Pflicht | Bei neuen Konventionen |
| `docs/PROMPTS.md` | Alle Prompts + Ergebnisse | Am Ende jeder Session |
| `CLAUDE.md` | Kompakt-Anleitung | Bei neuen Patterns/Commands |
