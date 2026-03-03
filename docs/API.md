# VibCode Hub — API-Dokumentation

> **Auto-gepflegt**: Diese Datei wird bei jeder Session automatisch aktualisiert.
> Swagger-UI: `https://hub.example.com/api/docs` (bzw. `http://localhost:3100/api/docs`)

## Basis

- **Prefix**: `/api/`
- **Auth**: Bearer Token (Keycloak JWT), außer `@Public()`-Endpunkte
- **Format**: JSON

---

## Projects

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/projects` | Ja | Alle Projekte auflisten |
| `GET` | `/api/projects/:slug` | Ja | Projekt nach Slug laden (inkl. Issues, Agents) |
| `POST` | `/api/projects` | Ja | Neues Projekt erstellen |
| `POST` | `/api/projects/quick` | Ja | Quick-Create: Name → Interview starten |
| `PUT` | `/api/projects/:id` | Ja | Projekt aktualisieren |
| `DELETE` | `/api/projects/:id` | Ja | Projekt löschen |

### DTOs

**CreateMinimalProjectDto** (für Quick-Create)
```typescript
{
  name: string;  // Pflicht, 2-100 Zeichen. Slug wird auto-generiert.
}
```

**Response** (Quick-Create)
```typescript
{
  project: Project;          // Status: INTERVIEWING
  interview: {
    agentInstanceId: string;
    agentTaskId: string;
    chatSessionId: string;
  }
}
```

**CreateProjectDto**
```typescript
{
  name: string;          // Pflicht
  slug: string;          // Pflicht, Pattern: /^[a-z0-9][a-z0-9-]*[a-z0-9]$/
  description?: string;
  gitlabProjectId?: number;
  gitlabUrl?: string;
}
```

**UpdateProjectDto**
```typescript
{
  name?: string;
  description?: string;
  status?: 'INTERVIEWING' | 'SETTING_UP' | 'READY' | 'ARCHIVED';
  techStack?: {
    techStack?: {
      framework?: string;
      language?: string;
      backend?: string;
      database?: string;
      additional?: string[];
    };
    deployment?: {
      isWebProject?: boolean;
      devServerPort?: number;
      devServerCommand?: string;
      buildCommand?: string;
    };
    setupInstructions?: {
      initCommand?: string;
      additionalCommands?: string[];
    };
  };
}
```

**Hinweis**: `slug` ist absichtlich NICHT editierbar (URL-Bestandteil). `techStack` wird deep-gemerged — nur übergebene Sub-Objekte überschreiben existierende Werte, der Rest bleibt erhalten.

---

## Issues

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/issues?projectId=xxx` | Ja | Alle Top-Level Issues eines Projekts (inkl. Sub-Issues) |
| `GET` | `/api/issues/:id` | Ja | Einzelnes Issue mit Sub-Issues, Agent, Projekt |
| `POST` | `/api/issues` | Ja | Neues Issue erstellen (optional mit GitLab-Sync) |
| `PUT` | `/api/issues/:id` | Ja | Issue aktualisieren (Status, Priorität, Labels, Agent) |
| `DELETE` | `/api/issues/:id` | Ja | Issue löschen |

### DTOs

**CreateIssueDto**
```typescript
{
  projectId: string;       // Pflicht
  title: string;           // Pflicht
  description?: string;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';  // Default: MEDIUM
  labels?: string[];
  parentId?: string;       // Für Sub-Issues
  syncToGitlab?: boolean;  // Erstellt das Issue auch in GitLab
}
```

**UpdateIssueDto**
```typescript
{
  title?: string;
  description?: string;
  status?: 'OPEN' | 'IN_PROGRESS' | 'IN_REVIEW' | 'TESTING' | 'DONE' | 'CLOSED';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  labels?: string[];
  assignedAgentId?: string;
}
```

### Verhalten
- Status-Änderungen auf `CLOSED`/`DONE` werden automatisch an GitLab gesynct (close)
- Status-Änderung auf `OPEN` reopened das GitLab-Issue
- Sub-Issues über `parentId` — Top-Level Issues werden mit `parentId: null` gefiltert

---

## Milestones

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/milestones?projectId=xxx` | Ja | Milestones eines Projekts mit zugehörigen Issues |

### Response

```typescript
[
  {
    id: string;
    projectId: string;
    gitlabMilestoneId: number | null;
    title: string;
    description: string | null;
    sortOrder: number;
    startDate: string | null;   // ISO date
    dueDate: string | null;     // ISO date
    issues: Issue[];            // Zugeordnete Issues
  }
]
```

### Verhalten
- Milestones werden vom Issue Compiler Agent automatisch erzeugt (auto-grouping der kompilierten Issues)
- Jedes Issue kann optional einem Milestone zugeordnet sein (`milestoneId`)
- Milestones werden nach `sortOrder` sortiert zurückgegeben
- GitLab-Sync: Milestones werden parallel in GitLab angelegt (`gitlabMilestoneId`)

---

## Chat

### Sessions

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/chat/sessions?projectId=xxx` | Ja | Chat-Sessions eines Projekts (inkl. letzter Nachricht) |
| `GET` | `/api/chat/sessions/:id` | Ja | Session mit allen Nachrichten |
| `POST` | `/api/chat/sessions` | Ja | Neue Chat-Session erstellen |
| `DELETE` | `/api/chat/sessions/:id` | Ja | Chat-Session löschen |

### Messages

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/chat/sessions/:id/messages` | Ja | Alle Nachrichten einer Session |
| `POST` | `/api/chat/messages` | Ja | Nachricht senden |

### DTOs

**CreateChatSessionDto**
```typescript
{
  projectId: string;   // Pflicht
  title?: string;      // Default: "New Chat"
}
```

**SendMessageDto**
```typescript
{
  chatSessionId: string;                              // Pflicht
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'AGENT';   // Pflicht
  content: string;                                     // Pflicht
  issueId?: string;      // Optional: verlinkt mit Issue
  agentTaskId?: string;  // Optional: verlinkt mit AgentTask
}
```

### WebSocket

- **Namespace**: `/chat`
- **Events**:
  - `joinSession` → Client joint einer Session-Room (`{ chatSessionId }`)
  - `leaveSession` → Client verlässt Session-Room
  - `sendMessage` → Nachricht senden (`{ chatSessionId, content }`)
  - `newMessage` → Server broadcastet neue Nachricht an Room

---

## Settings

### User Settings

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/settings/user` | Ja | Eigene User-Settings als Key-Value-Map |
| `PUT` | `/api/settings/user` | Ja | Bulk-Upsert eigener Settings |
| `PUT` | `/api/settings/user/:key` | Ja | Einzelnes User-Setting setzen |

### System Settings (Admin only)

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/settings/system` | Admin | Alle System-Settings (API-Keys maskiert) |
| `GET` | `/api/settings/system/:category` | Admin | Settings nach Kategorie filtern |
| `PUT` | `/api/settings/system` | Admin | Bulk-Upsert + Cache-Refresh |

### DTOs

**UpsertUserSettingDto**
```typescript
{
  key: string;    // z.B. "locale", "theme"
  value: string;  // JSON-encoded
}
```

**BulkUpsertUserSettingsDto**
```typescript
{
  settings: UpsertUserSettingDto[];
}
```

**UpsertSystemSettingDto**
```typescript
{
  key: string;          // z.B. "gitlab.url", "llm.ollama.url"
  value: string;        // JSON-encoded oder plain
  category?: string;    // z.B. "gitlab", "llm", "cors", "agents", "app"
  encrypted?: boolean;  // true für API-Keys/Secrets
  description?: string;
}
```

**BulkUpsertSystemSettingsDto**
```typescript
{
  settings: UpsertSystemSettingDto[];
}
```

### Verhalten
- **Verschlüsselung**: Secrets (API-Keys, Tokens) werden AES-256-GCM verschlüsselt in der DB gespeichert
- **Maskierung**: GET-Responses zeigen encrypted Fields als `****xxxx` (letzte 4 Zeichen)
- **Cache**: SystemSettings werden beim Start in einen In-Memory-Cache geladen, PUT aktualisiert den Cache
- **RBAC**: System-Endpunkte erfordern Keycloak `admin`-Rolle
- **Fallback**: DB → process.env → Hardcoded-Default

### System-Setting-Kategorien

| Kategorie | Keys | Verschlüsselt |
|---|---|---|
| `gitlab` | `gitlab.url`, `gitlab.api_token`, `gitlab.webhook_secret` | token, secret: ja |
| `llm` | `llm.ollama.url`, `llm.anthropic.api_key`, `llm.openai.api_key`, `llm.google.api_key` | api_keys: ja |
| `cors` | `cors.origins` | nein |
| `agents` | `agents.roles.{ROLE}` (10x), `agents.pipeline` | nein |
| `app` | `app.name` | nein |
| `devops` | `devops.workspace_path` | nein |

---

## Agent Roles & Providers (Admin only)

### Agent Role Configs

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/settings/agents/roles` | Admin | Alle 10 Agent-Rollen-Konfigurationen |
| `GET` | `/api/settings/agents/pipeline` | Admin | Pipeline-Konfiguration |

### Provider Discovery

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/settings/providers/models` | Admin | Modelle aller Provider (Ollama, Anthropic, OpenAI, Google, CLI) parallel |
| `GET` | `/api/settings/providers/ollama/models` | Admin | Verfügbare Ollama-Modelle (via /api/tags) |
| `GET` | `/api/settings/providers/ollama/health` | Admin | Ollama Health Check |
| `GET` | `/api/settings/providers/cli/status` | Admin | CLI-Tools Status (claude, codex, qwen3-coder) |

### Agent Roles (10)

| Rolle | Pipeline # | Beschreibung |
|---|---|---|
| `INTERVIEWER` | 1 | Feature-Interviews, fragt bis 95% Klarheit |
| `ARCHITECT` | 2 | Technisches Design, Architektur-Entscheidungen |
| `ISSUE_COMPILER` | 3 | Kompiliert Interview → GitLab Issues + Sub-Issues |
| `CODER` | 4 | Implementiert Code nach Issue-Spezifikation |
| `CODE_REVIEWER` | 5 | Code-Review: Qualität, Security, Patterns |
| `UI_TESTER` | 6 | UI-Tests: Layout, Responsivität, Accessibility |
| `FUNCTIONAL_TESTER` | 7 | Funktions-Tests: Acceptance Criteria, Integration |
| `PEN_TESTER` | 8 | Security-Tests: OWASP Top 10, Dependency Audit |
| `DOCUMENTER` | 9 | Dokumentation: API.md, README, i18n, JSDoc |
| `DEVOPS` | 10 | Deployment, Build, Git-Commits, Health Checks |

### LLM Provider Types (7)

| Provider | Typ | Beschreibung |
|---|---|---|
| `OLLAMA` | Local | Lokale Inferenz via Ollama API |
| `CLAUDE_CODE` | CLI | Claude Code CLI (subprocess) |
| `CODEX_CLI` | CLI | OpenAI Codex CLI (subprocess) |
| `QWEN3_CODER` | CLI | Qwen3 Coder CLI (subprocess) |
| `ANTHROPIC` | API | Anthropic Claude API |
| `OPENAI` | API | OpenAI GPT/Codex API |
| `GOOGLE` | API | Google Gemini API |

### Agent Role Config Format

Gespeichert als `agents.roles.{ROLE}` (JSON) in SystemSettings:

```typescript
{
  provider: string;       // LLMProvider enum
  model: string;          // Modellname
  systemPrompt: string;   // Behavior Profile (Markdown)
  parameters: {
    temperature: number;  // 0.0 - 1.0
    maxTokens: number;    // 256 - 32768
    topP?: number;
  };
  permissions: {
    fileRead: boolean;
    fileWrite: boolean;
    terminal: boolean;
    installPackages: boolean;
    http: boolean;
    gitOperations: boolean;
  };
  pipelinePosition: number;
  description: string;
  color: string;          // Tailwind-Farbname für UI
  icon: string;           // Lucide-Icon-Name
}
```

### Pipeline Config Format

Gespeichert als `agents.pipeline` (JSON):

```typescript
{
  enabled: boolean;            // Pipeline aktiv
  autoStart: boolean;          // Auto-Start nach Issue-Erstellung
  requireApproval: boolean;    // Mensch muss jeden Schritt genehmigen
  maxConcurrentAgents: number; // Max gleichzeitige Agenten
  timeoutMinutes: number;      // Timeout pro Agent-Schritt
}
```

---

## Agents

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `POST` | `/api/agents/interview/start` | Ja | Interview für ein Projekt starten |
| `GET` | `/api/agents/status/:projectId` | Ja | Agent-Status für ein Projekt |

### DTOs

**StartInterviewDto**
```typescript
{
  projectId: string;  // Pflicht, 1-100 Zeichen
}
```

### WebSocket Events

| Event | Richtung | Beschreibung |
|---|---|---|
| `agentStatus` | Server → Client | Agent-Status-Änderung (role, status, projectId) |
| `projectUpdated` | Server → Client | Projekt wurde aktualisiert (z.B. Interview abgeschlossen, Setup fertig) |

### Interview Result Normalizer

Der Interviewer-Agent enthält einen `normalizeInterviewResult()` Normalizer, der die JSON-Ausgabe lokaler LLMs (z.B. qwen3.5) auf das `InterviewResult`-Schema mappt:
- **Key-Varianten**: `tech_stack` → `techStack`, `summary` → `description`, `core_features` → `features`, etc.
- **Feature-Normalisierung**: Objekt-Arrays `[{name: "..."}]` → String-Arrays `["..."]`
- **Framework-Defaults**: Fehlende `deployment`-Felder werden anhand des Frameworks ergänzt (Angular=4200, React=3000, Vue=5173)

### Issue Compiler Agent (automatisch)

Der Issue Compiler Agent startet automatisch nach DevOps-Abschluss über das Event `agent.devopsComplete`.

**Flow:**
1. DevOps-Agent beendet Setup → `agent.devopsComplete` Event
2. AgentOrchestratorService empfängt Event → `startIssueCompilation()`
3. Issue Compiler erstellt AgentInstance (ISSUE_COMPILER) + AgentTask (CREATE_ISSUES) in gleicher ChatSession
4. Lädt Projekt-Features aus Interview-Result (`project.techStack.features`)
5. Sendet Features an LLM → erhält strukturierte Issues + Tasks als JSON
6. Erstellt Issues in DB via `IssuesService.create({ syncToGitlab: true })`
7. Erstellt Tasks als GitLab Work Items (Child-Tasks) via GraphQL `workItemCreate`
8. Speichert Tasks als Sub-Issues in DB (mit `parentId`)
9. Zusammenfassung im Chat

**LLM-Interaktion:**
- System Prompt definiert Output-Format: Issues mit Titel, Beschreibung, Priorität, Labels, Tasks
- Completion Marker: `:::ISSUES_COMPILED:::` + JSON
- Normalizer mappt LLM-Varianten (snake_case, Synonyme) auf Schema

**GitLab Work Items (GraphQL):**
- Issues werden per REST API erstellt (wie bisher)
- Tasks werden per GraphQL `workItemCreate` als Children erstellt
- Task Type ID: `gid://gitlab/WorkItems::Type/5`
- Parent-Verknüpfung via `hierarchyWidget: { parentId }`
- `getWorkItemId()` holt die WorkItem Global ID für ein Issue

**Fatal vs Non-Fatal:**

| Fehler | Verhalten |
|---|---|
| Projekt nicht gefunden | FAILED — Task abgebrochen |
| Keine Features im Interview | FAILED — nichts zu kompilieren |
| LLM-Aufruf fehlgeschlagen | FAILED — Provider-Config prüfen |
| Einzelne Issue-Erstellung fehlgeschlagen | Loggen, weitermachen |
| GitLab Task-Erstellung fehlgeschlagen | Loggen, weitermachen (DB-Issue existiert trotzdem) |

**IssueCompilerResult** (gespeichert als `AgentTask.output`):
```typescript
{
  issues: CompiledIssue[];  // title, description, priority, labels, tasks[]
  totalIssues: number;
  totalTasks: number;
}
```

---

### DevOps Agent (automatisch)

Der DevOps-Agent startet automatisch nach Interview-Abschluss über das Event `agent.interviewComplete`.

**Flow:**
1. Interviewer-Agent beendet Interview → `agent.interviewComplete` Event
2. AgentOrchestratorService empfängt Event → `startDevopsSetup()`
3. DevOps-Agent erstellt AgentInstance (DEVOPS) + AgentTask (DEPLOY) in gleicher ChatSession
4. 8-Schritte-Setup: loadProject → prepareWorkspace → cloneRepo → initCommand → additionalCommands → generateMcpConfig → gitCommitPush → finalize
5. Projekt-Status wechselt zu `READY`

**Schritte (deterministisch, kein LLM):**

| Schritt | Fatal | Beschreibung |
|---|---|---|
| loadProjectData | Ja | Projekt + GitLab-Daten laden |
| prepareWorkspace | Ja | Workspace-Verzeichnis erstellen (`devops.workspace_path` Setting) |
| cloneRepository | Ja | Git clone (oder pull falls schon vorhanden) |
| runInitCommand | Nein | Init-Befehl aus Interview (`setupInstructions.initCommand`) |
| runAdditionalCommands | Nein | Zusätzliche Befehle aus Interview |
| generateMcpConfig | Nein | `.mcp.json` aus `mcpServers[]` generieren |
| gitCommitAndPush | Nein | `git add . && git commit && git push` |
| finalize | Nein | Status → READY, Task → COMPLETED, Summary-Message |

**Security:**
- `execFile` (nicht `exec`) — keine Shell-Injection
- Binary-Allowlist: `npx, npm, node, git, pnpm, yarn, bun, cargo, go, python, python3, pip, pip3, dotnet, mvn, gradle`
- Token im Clone-URL wird beim Logging redacted
- Path-Traversal-Check via `path.resolve()` + `startsWith()`
- `CI=true` Environment Variable verhindert interaktive Prompts

**System-Setting:**

| Key | Default | Beschreibung |
|---|---|---|
| `devops.workspace_path` | `./workspaces/` | Basis-Pfad für geklonte Projekt-Repos |

**DevopsSetupResult** (gespeichert als `AgentTask.output`):
```typescript
{
  workspacePath: string;
  cloneSuccess: boolean;
  initCommandResult: CommandResult | null;
  additionalCommandResults: CommandResult[];
  mcpConfigGenerated: boolean;
  gitPushSuccess: boolean;
  webhookConfigured: boolean;
  steps: SetupStep[];  // name, status, message, durationMs
}
```

---

## GitLab Webhook

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `POST` | `/api/gitlab/webhook` | X-Gitlab-Token | GitLab Events empfangen (Issue sync) |

### Webhook-Events

| Event | Aktion |
|---|---|
| `issue` (open/update/close) | Upsert lokales Issue (Titel, Beschreibung, Status, Labels) |

**Setup**: Webhook-URL in GitLab-Projekt konfigurieren: `https://hub.example.com/api/gitlab/webhook`
Secret Token: Konfiguriert via Settings (Kategorie `gitlab`, Key `gitlab.webhook_secret`)

---

## GitLab-Integration (intern)

Der `GitlabService` wird intern vom `ProjectsService` genutzt:

| Aktion | Beschreibung |
|---|---|
| Projekt erstellen | Erstellt automatisch ein GitLab-Repo (private, mit README) |
| Projekt löschen | Löscht automatisch das GitLab-Repo |

**API-Methoden** (nicht als REST-Endpunkte exponiert, intern für Agenten):
- `createProject(name, path, description)` → GitLab-Projekt anlegen
- `getProject(id)` → Projekt-Info holen
- `deleteProject(id)` → Projekt löschen
- `createIssue(projectId, title, description, labels)` → Issue erstellen (REST API)
- `getIssues(projectId, state)` → Issues auflisten
- `getIssue(projectId, iid)` → Einzelnes Issue holen
- `updateIssue(projectId, iid, data)` → Issue aktualisieren
- `closeIssue(projectId, iid)` → Issue schließen
- `addWebhook(projectId, url, secret)` → Webhook registrieren
- `getWorkItemId(projectPath, issueIid)` → WorkItem Global ID holen (GraphQL)
- `createTask(namespacePath, parentWorkItemId, options)` → Task als Child-WorkItem erstellen (GraphQL)
- `getWorkItemChildren(workItemId)` → Child-Tasks eines WorkItems auflisten (GraphQL)
- `createMilestone(projectId, title, description, startDate, dueDate)` → Milestone in GitLab erstellen
- `getMilestones(projectId)` → Milestones eines GitLab-Projekts auflisten
- `updateMilestone(projectId, milestoneId, data)` → Milestone in GitLab aktualisieren

---

## Preview-System (intern)

Das Preview-System wird automatisch beim Interview-Abschluss aktiviert, wenn das Projekt ein Webprojekt ist.

| Aktion | Beschreibung |
|---|---|
| Interview-Abschluss | Bei `deployment.isWebProject = true` → Port-Allokation (5000–5999) + Nginx-Map-Sync + Reload |
| Projekt-Löschung | Gibt den Preview-Port frei, regeneriert Nginx-Map, Reload |
| API-Start | Synchronisiert Map-File aus DB (Recovery) |

### System-Settings (Kategorie: preview)

| Key | Default | Beschreibung |
|---|---|---|
| `preview.enabled` | `true` | Preview-System aktivieren/deaktivieren |
| `preview.port_min` | `5000` | Untergrenze Port-Range |
| `preview.port_max` | `5999` | Obergrenze Port-Range |
| `preview.domain` | `hub.example.com` | Base-Domain für Subdomains |
| `preview.nginx_map_path` | `/etc/nginx/conf.d/hub-project-map.conf` | Pfad zur Nginx-Map-Datei |

### Nginx Map-File Format

```nginx
# Auto-generated by VibCode Hub — DO NOT EDIT
map $hub_project $hub_upstream {
  default "";
  my-app "127.0.0.1:5000";
  cool-project "127.0.0.1:5001";
}
```

### Security

- Slug-Validierung: `^[a-z0-9][a-z0-9-]*[a-z0-9]$`, max 63 Zeichen
- Reservierte Subdomains blockiert: www, api, admin, mail, ftp, ns1, ns2, hub, sso, git
- `execFile` statt `exec` (keine Shell-Injection)
- Atomare Writes via Temp-File + `sudo cp`
- Map-File immer komplett aus DB regeneriert (nie inkrementell)

---

## Changelog

| Datum | Änderung |
|---|---|
| 2026-03-03 | Milestones: GET /api/milestones Endpunkt, Milestone-Modell (Prisma), Issue Compiler auto-grouping, GitLab-Sync (createMilestone, getMilestones, updateMilestone), Frontend collapsible Milestone-Gruppen |
| 2026-03-03 | Issue Compiler Agent: Automatische Feature→Issues+Tasks Kompilierung nach DevOps, GitLab GraphQL WorkItem-API (Tasks als Children), Normalizer für LLM-Output |
| 2026-03-02 | Interviewer: Robuster JSON-Normalizer (snake_case, Synonyme, Framework-Defaults), überarbeiteter System-Prompt (Pipeline-Fokus, Setup-First) |
| 2026-03-02 | Fix: REST POST /chat/messages emittiert jetzt chat.userMessage Event (Agent-Orchestrierung), Ollama think:false für qwen3.5/deepseek-r1 |
| 2026-03-02 | Agent Presets: GET/POST /settings/agents/presets, Local (3-Modell Ollama) + CLI Vorlagen, UI Preset-Selector |
| 2026-03-02 | DevOps Agent: Automatische Projekteinrichtung nach Interview (Clone, Init, MCP, Push), Event-basiert, deterministisch, Security-First |
| 2026-03-02 | Projekt-Settings: UpdateProjectDto mit nested DTOs (techStack, deployment, setup), Status-Update, Deep-Merge, Tab-UI mit 6 Glass-Cards |
| 2026-03-02 | Preview-System: Auto-Subdomain-Previews, Port-Allokation, Nginx-Map-Sync, Interview-Deployment-Erkennung |
| 2026-03-01 | Phase 2: LLM Abstraction Layer (7 Provider), Agent-Orchestrierung, Interviewer Agent, Quick-Create Flow, Event-System |
| 2026-03-01 | Agents: 10 Rollen (Interviewer→DevOps), 7 LLM-Provider, Ollama Discovery, CLI Health Check, Pipeline Config |
| 2026-03-01 | Settings: User + System Settings API (6 Endpunkte), AES-256-GCM Encryption, RBAC Admin Guard |
| 2026-02-28 | Chat: Sessions + Messages REST API, WebSocket Gateway (/chat namespace) |
| 2026-02-28 | Issues CRUD: 5 Endpunkte mit GitLab-Sync, Sub-Issues, Agent-Assignment |
| 2026-02-28 | GitLab-Integration: Service, Webhook-Controller, Projects-Integration |
| 2026-02-28 | Initial: Projects CRUD (5 Endpunkte) |
