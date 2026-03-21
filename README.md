# VibCode Hub

**AI-powered developer team portal** — orchestrate autonomous AI agents that turn your ideas into working code.

VibCode Hub provides a web interface where you describe what you want to build. AI agents — each with a specialized role — collaboratively create issues, write code, review it, test it, and document it, all managed through GitLab.

> **Built with AI Vibecoding.** This project was developed collaboratively between a human developer and AI coding assistants (Claude Code). While every effort is made to ensure quality and security, please review the [Security Notice](#security-notice) below.

---

## Features

- **Agent Pipeline** — 6 specialized AI agent roles: Ticket Creator, Coder, Code Reviewer, UI Tester, Pen Tester, Documenter
- **Multi-LLM Support** — Use cloud providers (Anthropic Claude, OpenAI, Google AI) or local models via Ollama (dual RTX 3090 ready)
- **GitLab Integration** — Automatic repository creation, issue sync, webhooks, merge request tracking
- **Real-time Chat** — WebSocket-powered terminal-style chat interface per project
- **Settings UI** — All configuration (API keys, LLM providers, agent defaults, CORS) managed through the web UI with AES-256-GCM encryption for secrets
- **Role-Based Access** — Keycloak SSO with admin/project-manager/developer/viewer roles
- **Internationalization** — Multi-language support (German, English, Italian, French) with easy extensibility
- **Dark Mode UI** — Glass morphism design with Tailwind CSS, responsive layout

---

## Tech Stack

| Layer | Technology |
|---|---|
| Monorepo | NX (package-based), @vibcode/shared types |
| Frontend | Angular 21, Tailwind CSS v4, Keycloak PKCE Auth |
| Backend | NestJS 11, Prisma 7 (PostgreSQL), Passport JWT |
| Auth | Keycloak (OIDC/PKCE), WebSocket JWT Guard |
| VCS | GitLab CE (API v4) |
| LLM | Ollama, Anthropic, OpenAI, Google AI, Claude Code, Codex CLI, Gemini CLI |
| Database | PostgreSQL 17 |
| Security | Rate limiting (@nestjs/throttler), CORS validation, input DTOs |

---

## Prerequisites

- **Node.js** >= 22
- **PostgreSQL** >= 16
- **Keycloak** >= 26 (or compatible OIDC provider)
- **GitLab CE** (self-hosted, API v4)
- **Ollama** (optional, for local LLM inference)

---

## Installation

### 1. Clone and install NX

```bash
git clone https://github.com/your-org/vibcode-hub.git
cd vibcode-hub
npm install          # Installs NX at root level
```

### 2. Backend setup

```bash
cd backend
npm install

# Configure environment (only startup essentials — everything else is in Settings UI)
cp .env.example .env
# Edit .env: set DATABASE_URL, KEYCLOAK_* credentials, PORT

# Run database migrations
npx prisma migrate deploy

# Seed initial system settings from .env values
npx ts-node prisma/seed-settings.ts

# Start development server
npm run start:dev    # → http://localhost:3100
```

### 3. Frontend setup

```bash
cd frontend
npm install

# Configure Keycloak connection
# Edit src/environments/environment.ts with your Keycloak URL, realm, clientId

# Start development server
npx ng serve          # → http://localhost:4200
```

### 4. Keycloak setup

1. Create a realm named `vibcodehub`
2. Create a **public** client `vibcodehub-frontend` with PKCE enabled
3. Create a **confidential** client `vibcodehub-backend` with service account
4. Create roles: `admin`, `project-manager`, `developer`, `viewer`
5. Create your admin user and assign the `admin` role

### 5. Production deployment

```bash
# Backend
cd backend
npx nest build
node dist/src/main.js    # or use systemd/pm2

# Frontend
cd frontend
npx ng build
# Serve dist/frontend/ via Nginx with proxy_pass for /api/ → :3100
```

---

## Environment Variables

The `.env` file only needs startup essentials:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `KEYCLOAK_URL` | Yes | Keycloak server URL |
| `KEYCLOAK_REALM` | Yes | Keycloak realm name |
| `KEYCLOAK_CLIENT_ID` | Yes | Backend client ID |
| `KEYCLOAK_CLIENT_SECRET` | Yes | Backend client secret |
| `PORT` | No | API port (default: 3100) |

All other configuration (GitLab, LLM API keys, CORS origins, agent defaults) is managed through the **Settings** page in the web UI and stored encrypted in the database.

---

## Adding a New Language

1. Create a new JSON file in `frontend/src/assets/i18n/{locale}.json` (copy from `en.json`)
2. Translate all values
3. Add the locale code to `SUPPORTED_LOCALES` in `frontend/src/app/services/translate.service.ts`
4. Add the language name to the `languages` section in all existing locale files

---

## Project Structure

```
vibcode-hub/
├── backend/              # NestJS REST API + WebSocket
│   ├── prisma/           # Database schema & migrations
│   └── src/
│       ├── auth/         # Keycloak JWT authentication
│       ├── settings/     # Settings management (encrypted)
│       ├── projects/     # Project CRUD + GitLab integration
│       ├── issues/       # Issue management + GitLab sync
│       ├── chat/         # Chat sessions + WebSocket gateway
│       └── gitlab/       # GitLab API client
├── frontend/             # Angular 21 SPA
│   └── src/
│       ├── app/
│       │   ├── pages/    # Dashboard, Project, Settings
│       │   ├── services/ # API, Auth, Chat, i18n
│       │   └── pipes/    # TranslatePipe
│       └── assets/i18n/  # Translation files (de, en, it, fr)
└── docs/                 # Spec, Architecture, API docs
```

---

## Security Notice

This project was developed using **AI vibecoding** — a collaborative approach where AI coding assistants generate significant portions of the codebase. While this enables rapid development, please be aware:

- **Review before production use.** AI-generated code should be reviewed by experienced developers before deployment in production environments, especially security-critical components (authentication, encryption, access control).
- **Secrets management.** API keys and tokens are stored AES-256-GCM encrypted in the database. The encryption key is derived from the Keycloak client secret. Ensure your `.env` file is never committed to version control.
- **Authentication.** The application relies on Keycloak for authentication. Ensure your Keycloak instance is properly secured and up to date.
- **Network security.** The application is designed for deployment behind a reverse proxy (Nginx) with TLS. Do not expose the backend API or database ports directly to the internet.
- **No warranty.** This software is provided as-is. Use at your own risk. Always perform your own security assessment before deploying to production.
- **Dependencies.** Regularly update dependencies to patch known vulnerabilities (`npm audit`).

---

## API Documentation

Interactive Swagger documentation is available at `/api/docs` when the backend is running.

See [docs/API.md](docs/API.md) for the full API reference.

---

## License

MIT

---

*Built with AI by [KobAIld](https://github.com/your-org/vibcode-hub) — where humans direct and AI delivers.*
