# VibCode Hub — Spezifikation

## Vision
VibCode Hub ist ein AI-Entwicklerteam-Portal. Der Nutzer agiert als "Chef" und steuert verschiedene AI-Agenten, die wie ein echtes Entwicklerteam Anforderungen aufnehmen, in Issues zerlegen und automatisiert abarbeiten.

## Kernkonzept
1. **Projekte** — Jedes Projekt ist ein eigenständiger Workspace mit GitLab-Repo, Issues und Agenten
2. **Zentraler Chat** — Pro Projekt ein Chat-Interface zur Anforderungsaufnahme
3. **Issue-Pipeline** — Chat → Issues/Sub-Issues → automatische Zuweisung an Agenten
4. **AI-Agenten** — Spezialisierte Rollen arbeiten Issues selbstständig ab
5. **Live-Dashboard** — Echtzeit-Ansicht aller Agenten-Aktivitäten

## Agenten-Rollen

| Rolle | Verantwortung |
|---|---|
| Ticket Creator | Wandelt Chat-Anforderungen in strukturierte GitLab-Issues um |
| Coder | Schreibt Code, erstellt Branches und Merge Requests |
| Code Reviewer | Reviewed Merge Requests, gibt Feedback, approved/declined |
| UI Tester | Führt automatisierte UI-Tests aus |
| Pen Tester | Sicherheitsanalysen und Penetration Testing |
| Dokumentierer | Erstellt/aktualisiert technische Dokumentation |

## Agenten-Backends

| Provider | Typ | Details |
|---|---|---|
| Anthropic (Claude) | Cloud | claude-sonnet-4-6, claude-opus-4-6 |
| OpenAI (Codex) | Cloud | gpt-4o, codex |
| Google (Gemini) | Cloud | gemini-2.0-flash, gemini-pro |
| Ollama | Lokal | Läuft auf 2x RTX 3090, Port 11434 |

## Phasenplan

### Phase 1 — Foundation (aktuell)
- [x] Projektstruktur (Angular 21 + NestJS + Prisma)
- [x] Keycloak-Integration (Realm, Clients, User)
- [x] Datenmodell (Projects, Issues, Chat, Agents, Tasks, Logs)
- [x] Projekt-CRUD API & Dashboard
- [ ] GitLab-Integration (Projekte erstellen, Issues sync)
- [ ] Chat-Interface Grundgerüst

### Phase 2 — Agent-Orchestrierung
- [ ] Agent-Framework (abstraktes Interface für alle LLM-Provider)
- [ ] Erster Agent: Ticket Creator (Chat → Issues)
- [ ] Zweiter Agent: Coder (Issue → Branch → MR)
- [ ] WebSocket-basierte Live-Updates

### Phase 3 — Erweiterung
- [ ] Code Reviewer Agent
- [ ] UI Tester Agent
- [ ] Pen Tester Agent
- [ ] Dokumentierer Agent
- [ ] Erweitertes Live-Dashboard

### Phase 4 — Lokale LLMs
- [ ] Ollama-Integration für alle Agenten-Rollen
- [ ] Model-Auswahl pro Agent konfigurierbar
- [ ] GPU-Monitoring (RTX 3090 Auslastung)

## User-Modell
- **MVP**: Single-User (Sebastian als Admin)
- **Später**: Multi-User via Keycloak-Rollen (admin, project-manager, developer, viewer)

## Entwicklungs-Tooling

### MCP-Server (für AI-gestützte Entwicklung)
| Server | Paket | Zweck |
|---|---|---|
| angular | `angular-mcp-server` | Angular-Doku, Best Practices, Beispielsuche |
| prisma | `npx prisma mcp` (built-in) | Schema-Analyse, Migration, Query-Hilfe |
| mcp-nest | `@rekog/mcp-nest` | NestJS-Module, Decorator-Patterns |

### Arbeitsregeln
Siehe `docs/DEVELOPMENT.md` — MCP-First-Ansatz, Umsetzungsschleife, Dokumentationspflicht.
