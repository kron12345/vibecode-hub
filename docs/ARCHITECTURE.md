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
| Backend | NestJS | 11.x |
| ORM | Prisma | 7.4.x |
| Datenbank | PostgreSQL | 17.8 |
| Auth | Keycloak | 26.1 |
| Reverse Proxy | Nginx | - |
| Container | Docker | 26.1.5 |

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
│   │   ├── chat/      # Chat-Sessions & Messages
│   │   ├── agents/    # Agent-Orchestrierung
│   │   ├── gitlab/    # GitLab API Integration
│   │   └── common/    # Decorators, Guards, Filters
│   └── prisma/
│       └── schema.prisma
├── docs/              # Spezifikation, Architektur, Prompts
└── shared/            # Geteilte Types (Frontend ↔ Backend)
```

## Datenmodell

- **Project** → hat Issues, ChatSessions, AgentInstances
- **Issue** → hierarchisch (parent/sub-issues), gespiegelt von GitLab
- **ChatSession** → pro Projekt, enthält ChatMessages
- **AgentInstance** → konfigurierter Agent pro Projekt (Rolle + Provider + Model)
- **AgentTask** → einzelner Arbeitsschritt eines Agenten
- **AgentLog** → Echtzeit-Logs für Live-Dashboard

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

## API-Design

- REST unter `/api/`
- Swagger/OpenAPI unter `/api/docs`
- WebSocket für Live-Agent-Updates
- GitLab Webhook unter `/api/gitlab/webhook` (ohne Auth, via Token)

## MCP-Server (Entwicklungs-Tooling)

Konfiguriert in `.claude/settings.local.json`:

| Server | Command | Transport |
|---|---|---|
| angular | `angular-mcp-server` | stdio |
| prisma | `npx prisma mcp --schema ./backend/prisma/schema.prisma` | stdio |
| mcp-nest | `npx @rekog/mcp-nest` | stdio |

## Entwicklungsrichtlinien

Siehe `docs/DEVELOPMENT.md` für:
- MCP-Nutzungspflicht und Prioritäten
- Umsetzungsschleife (Planen → MCP → Implementieren → Verifizieren)
- Dokumentationspflicht pro Session
