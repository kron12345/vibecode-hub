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
- [x] Milestone-Support (Issue Compiler auto-grouping)
- [x] DevOps-Agent (Projekt einrichten, CI/CD generieren, .mcp.json, Git-Push)
- [x] Coder Agent (Issue → Feature-Branch → MCP Agent Loop → Commit → MR)
- [x] Code Reviewer Agent (MR-Diffs → Ollama Review → Approve/Request Changes)
- [x] Issue Comments (IssueComment Model, CRUD API, GitLab-Sync, Frontend Detail-Panel)
- [x] Pipeline Feedback Loop (CI/CD Failure → Job-Logs → Coder fixIssue)
- [x] User Feedback Loop (GitLab Comment → Coder re-triggered)
- [x] GitLab Webhook Expansion (note, pipeline, merge_request Events)
- [x] Streaming (Token-für-Token im Chat via WebSocket)

### Phase 3 — Testing Agents, Documenter, Extended Pipeline
- [x] Functional Tester Agent (LLM-basiert, Acceptance Criteria Verification)
- [x] UI Tester Agent (Playwright + LLM, Layout/Responsive/Accessibility/Visual/Interaction)
- [x] Pen Tester Agent (npm audit + HTTP Headers + LLM OWASP Top 10)
- [x] Documenter Agent (LLM → README/API-Docs/JSDoc, Git Commit)
- [x] Extended Pipeline (Review APPROVED → Functional → UI → Pen → Docs → DONE)
- [x] Feedback Loops für alle Test-Agents (fail → Coder fixIssue)
- [x] Manuelle Trigger-Endpoints (POST /agents/{functional-test,ui-test,pen-test,docs}/start)
- [ ] Erweitertes Live-Dashboard

### Phase 4 — MCP + Lokale LLMs
- [x] MCP Client Integration (@modelcontextprotocol/sdk)
- [x] MCP Filesystem Server für Coder Agent (14 Tools)
- [x] MCP Shell Server für Coder Agent (run_command, whitelisted commands, security-hardened)
- [x] Ollama Tool-Calling Support (native function calling)
- [x] MCP Agent Loop (generisch, LLM ↔ Tool-Calls ↔ MCP)
- [x] Coder Agent umgebaut: Qwen CLI → MCP Agent Loop
- [x] MCP Server Registry (McpServerDefinition + McpServerOnRole, Admin CRUD API, Built-in Seeding, Frontend Settings UI)
- [ ] MCP Git Server anbinden
- [ ] MCP Angular CLI Server anbinden
- [ ] MCP Prisma Server anbinden
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
