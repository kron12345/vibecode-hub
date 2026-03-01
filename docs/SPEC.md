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
- [x] GitLab-Integration (Projekte erstellen, Issues sync)
- [x] Chat-Interface Grundgerüst

### Phase 2 — Agent-Orchestrierung
- [x] LLM Abstraction Layer (7 Provider: Ollama, Anthropic, OpenAI, Google, Claude Code, Codex CLI, Qwen Code)
- [x] Event-basierte Agent-Architektur (@nestjs/event-emitter)
- [x] Interviewer Agent (KI-Interview → Projekt-Requirements)
- [x] Quick-Create Flow (Name → Interview → Tech-Stack)
- [x] WebSocket-basierte Live-Updates (agentStatus, projectUpdated)
- [ ] DevOps-Agent (Projekt einrichten: Repo, Framework, .mcp.json)
- [ ] Zweiter Agent: Coder (Issue → Branch → MR)
- [ ] Streaming (Token-für-Token im Chat)

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
| context7 | `@upstash/context7-mcp` | NestJS-Doku, allgemeine Framework-Doku |

### Arbeitsregeln
Siehe `docs/DEVELOPMENT.md` — MCP-First-Ansatz, Umsetzungsschleife, Dokumentationspflicht.
