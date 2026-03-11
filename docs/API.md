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
  workBranch?: string | null;  // Target branch for feature branches (null = GitLab default)
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

**Hinweis**: `slug` ist absichtlich NICHT editierbar (URL-Bestandteil). `techStack` wird deep-gemerged — nur übergebene Sub-Objekte überschreiben existierende Werte, der Rest bleibt erhalten. `workBranch` definiert den Ziel-Branch für Feature-Branches und Merge Requests — bei `null` wird der GitLab-Default-Branch verwendet.

---

## Issues

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/issues?projectId=xxx` | Ja | Alle Top-Level Issues eines Projekts (inkl. Sub-Issues) |
| `GET` | `/api/issues/:id` | Ja | Einzelnes Issue mit Sub-Issues, Agent, Projekt |
| `POST` | `/api/issues` | Ja | Neues Issue erstellen (optional mit GitLab-Sync) |
| `PUT` | `/api/issues/:id` | Ja | Issue aktualisieren (Status, Priorität, Labels, Agent) |
| `DELETE` | `/api/issues/:id` | Ja | Issue löschen |
| `GET` | `/api/issues/:id/comments` | Ja | Kommentare eines Issues (chronologisch) |
| `POST` | `/api/issues/:id/comments` | Ja | Kommentar erstellen (optional mit GitLab-Sync) |

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

**CreateIssueCommentDto**
```typescript
{
  content: string;           // Pflicht
  authorType?: 'AGENT' | 'USER' | 'SYSTEM';  // Default: USER
  authorName?: string;       // Display-Name des Autors
  syncToGitlab?: boolean;    // Auch als GitLab-Note posten
}
```

### Verhalten
- Status-Änderungen auf `CLOSED`/`DONE` werden automatisch an GitLab gesynct (close)
- Status-Änderung auf `OPEN` reopened das GitLab-Issue
- **Status Labels**: Jede Status-Änderung synct ein `status::*` Label nach GitLab (6 Labels pro Projekt, idempotent erstellt). Alte Status-Labels werden entfernt, neues gesetzt. Sync erfolgt in: IssuesService.update(), CodeReviewerAgent, DocumenterAgent, AgentOrchestratorService (Pipeline-Failure, User-Kommentar, Max Fix Attempts)
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
| `GET` | `/api/chat/sessions?projectId=xxx&type=` | Ja | Chat-Sessions eines Projekts, optional nach type filtern |
| `GET` | `/api/chat/sessions/archived?projectId=xxx` | Ja | Archivierte Dev-Sessions eines Projekts |
| `GET` | `/api/chat/sessions/:id` | Ja | Session mit allen Nachrichten |
| `POST` | `/api/chat/sessions` | Ja | Neue Chat-Session erstellen (INFRASTRUCTURE) |
| `POST` | `/api/chat/sessions/dev` | Ja | Neue Dev-Session mit Git-Branch erstellen |
| `POST` | `/api/chat/sessions/:id/archive` | Ja | Session archivieren (Merge in main) |
| `POST` | `/api/chat/sessions/:id/resolve` | Ja | Merge-Konflikt erneut versuchen |
| `POST` | `/api/chat/sessions/:id/continue` | Ja | Archivierte Session fortsetzen (neue Session mit parentId) |
| `PATCH` | `/api/chat/sessions/:id` | Ja | Session-Titel ändern |
| `DELETE` | `/api/chat/sessions/:id` | Ja | Chat-Session löschen |

### Session DTOs

**CreateDevSessionDto**
```typescript
{
  projectId: string;   // Pflicht
  title?: string;      // Default: "New Session"
  branch?: string;     // Optional, auto-generiert: session/<slug>-<id>
}
```

**UpdateSessionDto**
```typescript
{
  title?: string;
}
```

**ArchiveResult** (Response)
```typescript
{
  success: boolean;
  merged: boolean;
  conflicts?: string[];   // Bei CONFLICT-Status
  error?: string;
}
```

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
| `POST` | `/api/settings/system/refresh` | Admin | In-Memory Settings-Cache aus DB neu laden |

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
| `POST` | `/api/agents/architect/start` | Ja | Architect Agent manuell starten |
| `POST` | `/api/agents/issue-compiler/start` | Ja | Issue Compiler manuell starten |
| `POST` | `/api/agents/coding/start` | Ja | Coder Agent für ein Projekt starten |
| `POST` | `/api/agents/review/start` | Ja | Code Review für MR starten |
| `POST` | `/api/agents/functional-test/start` | Ja | Functional Test für MR starten |
| `POST` | `/api/agents/ui-test/start` | Ja | UI Test für MR starten |
| `POST` | `/api/agents/pen-test/start` | Ja | Security Test für MR starten |
| `POST` | `/api/agents/docs/start` | Ja | Documenter für MR starten |
| `GET` | `/api/agents/status/:projectId` | Ja | Agent-Status für ein Projekt |

### DTOs

**StartInterviewDto**
```typescript
{
  projectId: string;  // Pflicht, 1-100 Zeichen
}
```

**StartCodingDto**
```typescript
{
  projectId: string;
  chatSessionId: string;
}
```

**StartReviewDto**
```typescript
{
  projectId: string;
  chatSessionId: string;
  issueId: string;
  mrIid: number;
  gitlabProjectId: number;
}
```

**StartTestDto** (für functional-test, ui-test, pen-test, docs)
```typescript
{
  projectId: string;
  chatSessionId: string;
  issueId: string;
  mrIid: number;
  gitlabProjectId: number;
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

Der Issue Compiler Agent startet automatisch after the Architect design phase in a Dev Session, triggered by `agent.architectDesignComplete`.

**Flow:**
1. Feature Interview completes in Dev Session → `agent.featureInterviewComplete` → Architect Phase A
2. Architect design completes → `agent.architectDesignComplete` → `startIssueCompilation()`
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

**Flow (Initial Setup):**
1. Interviewer-Agent beendet Interview → `agent.interviewComplete` Event
2. AgentOrchestratorService empfängt Event → `startDevopsSetup()`
3. DevOps-Agent erstellt AgentInstance (DEVOPS) + AgentTask (DEPLOY) in gleicher ChatSession
4. 8-Schritte-Setup: loadProject → prepareWorkspace → cloneRepo → initCommand → additionalCommands → generateMcpConfig → gitCommitPush → finalize
5. Generates `ENVIRONMENT.md` in workspace root (environment details, dependencies, tech stack)
6. Projekt-Status wechselt zu `READY`
7. `agent.devopsComplete` → pipeline STOPS (no longer triggers Architect)

**Flow (YOLO Mode — Infra Commands):**
After setup, user messages in the Infrastructure Chat trigger `handleInfraCommand()`:
1. Creates AgentTask with type `INFRA_COMMAND`
2. Executes command via MCP agent loop (filesystem, shell, git tools)
3. Reports result back in chat

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
| `note` (Issue-Kommentar) | Speichert User-Kommentar als IssueComment, emittiert `gitlab.userComment` → Coder Agent re-trigger |
| `pipeline` (success/failed) | Emittiert `gitlab.pipelineResult` → Bei Failure: Job-Logs holen, Coder Agent re-trigger |
| `merge_request` | Logging (für spätere Workflows) |

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
- `addWebhook(projectId, url, secret)` → Webhook registrieren (issues, notes, pipeline, MR events)
- `createIssueNote(projectId, issueIid, body)` → Kommentar auf GitLab-Issue erstellen
- `getIssueNotes(projectId, issueIid)` → Kommentare eines GitLab-Issues auflisten
- `createMergeRequest(projectId, options)` → Merge Request erstellen
- `getMergeRequest(projectId, mrIid)` → MR-Details holen
- `getMergeRequestDiffs(projectId, mrIid)` → MR-Diffs holen (für Code Review)
- `createBranch(projectId, name, ref)` → Branch erstellen
- `deleteBranch(projectId, name)` → Branch löschen
- `getPipeline(projectId, pipelineId)` → Pipeline-Details holen
- `getPipelineJobs(projectId, pipelineId)` → Jobs einer Pipeline auflisten
- `getJobLog(projectId, jobId)` → Job-Log holen (für Fehleranalyse)
- `getRepositoryTree(projectId, ref, path?)` → Dateibaum eines Repos auflisten
- `getWorkItemId(projectPath, issueIid)` → WorkItem Global ID holen (GraphQL)
- `createTask(namespacePath, parentWorkItemId, options)` → Task als Child-WorkItem erstellen (GraphQL)
- `getWorkItemChildren(workItemId)` → Child-Tasks eines WorkItems auflisten (GraphQL)
- `createMilestone(projectId, title, description, startDate, dueDate)` → Milestone in GitLab erstellen
- `getMilestones(projectId)` → Milestones eines GitLab-Projekts auflisten
- `updateMilestone(projectId, milestoneId, data)` → Milestone in GitLab aktualisieren
- `listWikiPages(projectId)` → Alle Wiki-Seiten eines Projekts auflisten
- `getWikiPage(projectId, slug)` → Einzelne Wiki-Seite lesen
- `createWikiPage(projectId, title, content, format?)` → Wiki-Seite erstellen
- `updateWikiPage(projectId, slug, title, content)` → Wiki-Seite aktualisieren
- `deleteWikiPage(projectId, slug)` → Wiki-Seite löschen
- `upsertWikiPage(projectId, title, content)` → Wiki-Seite erstellen oder aktualisieren (409-Fallback)

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

## MCP Server Registry (Admin only)

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/mcp-servers` | Admin | Alle MCP-Server-Definitionen mit Rollen-Zuordnungen |
| `GET` | `/api/mcp-servers/:id` | Admin | Einzelne MCP-Server-Definition |
| `POST` | `/api/mcp-servers` | Admin | Custom MCP-Server erstellen |
| `PUT` | `/api/mcp-servers/:id` | Admin | MCP-Server aktualisieren |
| `DELETE` | `/api/mcp-servers/:id` | Admin | Custom MCP-Server löschen (built-in geschützt) |
| `PUT` | `/api/mcp-servers/:id/roles` | Admin | Rollen-Zuordnungen setzen (welche Agenten diesen Server nutzen) |

### Project-Level MCP Overrides

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/mcp-overrides` | Admin, PM | Alle Overrides für ein Projekt |
| `PUT` | `/api/projects/:projectId/mcp-overrides` | Admin, PM | Override setzen (Upsert: ENABLE/DISABLE) |
| `DELETE` | `/api/projects/:projectId/mcp-overrides` | Admin, PM | Override entfernen (zurück zu Global) |

### DTOs

**CreateMcpServerDto**
```typescript
{
  name: string;          // Pflicht, unique (z.B. "git")
  displayName: string;   // Pflicht (z.B. "Git Server")
  description?: string;
  category?: string;     // "coding" | "execution" | "security" | "knowledge" | "custom" (Default: "custom")
  command: string;       // Pflicht (z.B. "npx", "node")
  args: string[];        // Pflicht (z.B. ["@modelcontextprotocol/server-git"])
  env?: Record<string, string>;  // Umgebungsvariablen
  argTemplate?: string;  // Platzhalter: {workspace}, {allowedPaths}, {shellServerPath}
  enabled?: boolean;     // Default: true
}
```

**UpdateMcpServerDto** — Alle Felder optional (außer `name`, nicht änderbar):
```typescript
{
  displayName?: string;
  description?: string;
  category?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  argTemplate?: string;
  enabled?: boolean;
}
```

**SetRoleAssignmentsDto**
```typescript
{
  roles: AgentRole[];  // z.B. ["CODER", "CODE_REVIEWER"]
}
```

**SetProjectOverrideDto**
```typescript
{
  mcpServerId: string;   // ID des MCP-Servers
  agentRole: AgentRole;  // z.B. "CODER"
  action: "ENABLE" | "DISABLE";
}
```

**DeleteProjectOverrideDto**
```typescript
{
  mcpServerId: string;
  agentRole: AgentRole;
}
```

### Verhalten
- **Built-in Server** (13 Stück: filesystem, git, gitlab, prisma, angular-cli, shell, playwright, eslint, security-audit, postgres, docker, sequential-thinking, memory) werden beim API-Start automatisch geseeded und können nicht gelöscht werden
- **Rollen-Zuordnung**: Many-to-many über `McpServerOnRole` — ein Server kann mehreren Rollen zugeordnet sein, eine Rolle kann mehrere Server haben
- **Project Overrides**: `McpServerProjectOverride` erlaubt pro Projekt+Rolle Overrides (ENABLE/DISABLE) gegenüber der globalen Konfiguration
- **Runtime Resolution**: `resolveServersForRole(role, context)` löst `argTemplate`-Platzhalter auf (`{workspace}`, `{allowedPaths}`, `{shellServerPath}`, `{postgresConnectionString}`) und `envTemplate` Platzhalter (`{settings:key}` → SystemSettings-Wert)
- **Coder Agent**: Lädt MCP-Server dynamisch aus der Registry, inkl. projectId für Override-Auflösung

### Datenmodell

**McpServerDefinition**
| Feld | Typ | Beschreibung |
|---|---|---|
| `id` | cuid | Primary Key |
| `name` | String (unique) | Technischer Name |
| `displayName` | String | Anzeigename |
| `description` | String? | Beschreibung |
| `category` | String | Kategorie (coding, execution, security, knowledge, custom) |
| `command` | String | Ausführbares Kommando |
| `args` | String[] | Argumente |
| `env` | Json? | Statische Umgebungsvariablen |
| `envTemplate` | Json? | Runtime-Env: `{ "KEY": "{settings:some.key}" }` → aus SystemSettings aufgelöst |
| `argTemplate` | String? | Argument-Template mit Platzhaltern |
| `builtin` | Boolean | Built-in-Server (nicht löschbar) |
| `enabled` | Boolean | Aktiviert/Deaktiviert |

**McpServerOnRole** (Join-Tabelle)
| Feld | Typ | Beschreibung |
|---|---|---|
| `id` | cuid | Primary Key |
| `mcpServerId` | String (FK) | → McpServerDefinition |
| `agentRole` | AgentRole (Enum) | Agent-Rolle |
| | | @@unique(mcpServerId, agentRole) |

**McpServerProjectOverride**
| Feld | Typ | Beschreibung |
|---|---|---|
| `id` | cuid | Primary Key |
| `projectId` | String (FK) | → Project |
| `mcpServerId` | String (FK) | → McpServerDefinition |
| `agentRole` | AgentRole (Enum) | Agent-Rolle |
| `action` | ENABLE / DISABLE | Override-Aktion |
| | | @@unique(projectId, mcpServerId, agentRole) |

---

## Monitor

| Method | Endpoint | Auth | Beschreibung |
|---|---|---|---|
| `GET` | `/api/monitor/hardware` | Public | Aktueller Hardware-Snapshot (GPUs, CPU, RAM) |
| `GET` | `/api/monitor/hardware/history` | Public | Letzte 60 Snapshots (~3 Min) für Sparkline-Charts |
| `GET` | `/api/monitor/logs` | Ja | Agent-Log-History mit Filtern (projectId, agentRole, level, limit, offset) |
| `GET` | `/api/monitor/activity` | Ja | Unified Activity Timeline (Logs + Comments + Chat Messages) |
| `GET` | `/api/monitor/agents/overview` | Ja | Aggregierte Agent-Übersicht pro Rolle (Status, Tasks, aktive Projekte) |

### Hardware-Snapshot Format

```typescript
{
  gpus: [{
    index: number;
    name: string;        // "NVIDIA GeForce RTX 3090"
    temp: number;        // °C
    fanSpeed: number;    // %
    powerDraw: number;   // W
    gpuUtil: number;     // %
    memUtil: number;     // %
    gpuClock: number;    // MHz
    memClock: number;    // MHz
  }];
  cpu: {
    temp: number;        // °C (k10temp)
    load1: number;       // 1-min load average
    load5: number;
    load15: number;
  };
  ram: {
    totalMb: number;
    usedMb: number;
    availableMb: number;
    usedPercent: number;
  };
  timestamp: number;     // Unix ms
}
```

### WebSocket Namespace `/monitor`

| Event | Richtung | Beschreibung |
|---|---|---|
| `hardwareStats` | Server → Client | Hardware-Snapshot alle 3 Sekunden |
| `hardwareHistory` | Server → Client | History-Array bei Connect (letzte ~3 Min) |
| `agentLogEntry` | Server → Client | Neuer Agent-Log-Eintrag (level, message, agentRole, projectId) |
| `llmCall` | Server → Client | LLM-Call-Tracking (provider, model, duration) |
| `joinLogRoom` | Client → Server | In Log-Room joinen (`{ projectId?: string }`) |
| `leaveLogRoom` | Client → Server | Log-Room verlassen |

**Datenquelle GPU**: `nvtop -s` (JSON-Output, v3.2.0). nvidia-smi nicht verfügbar in NVIDIA Driver 590.
**Datenquelle CPU**: `/sys/class/hwmon/hwmon2/temp1_input` (k10temp AMD), `/proc/loadavg`
**Datenquelle RAM**: `/proc/meminfo`

---

## Changelog

| Datum | Änderung |
|---|---|
| 2026-03-11 | Pipeline Split: Infrastructure Chat (Interview → DevOps → STOP + YOLO mode for infra commands) vs Dev Session Chat (Feature Interview → Architect → Issue Compiler → full pipeline). New task types: FEATURE_INTERVIEW, INFRA_COMMAND. DevOps generates ENVIRONMENT.md. New events: session.devSessionCreated, agent.featureInterviewComplete. agent.devopsComplete no longer triggers Architect. Interviewer has startFeatureInterview/continueFeatureInterview. DevOps has handleInfraCommand() YOLO mode. No new REST endpoints (uses existing + events). |
| 2026-03-11 | Session-Based Branching: ChatSession erweitert um type/status/branch/archivedAt/parentId. 6 neue Endpoints (POST dev, archive, resolve, continue; PATCH :id; GET archived). SessionBranchService: create/archive/continue/resolve Lifecycle. Coder Option A: direkte Commits auf Session-Branch. 3-Tier Frontend UI (Infrastructure/Dev Sessions/Archive). |
| 2026-03-09 | Pipeline Bugfixes (8 total): Atomic start-lock für Agent-Duplikat-Verhinderung, Architect modelSupportsTools() für deepseek-r1, fetch MCP-Server deaktiviert (npm removed), maxTokens hochgesetzt (8K-16K je Rolle), Issue-Deduplizierung im Issue Compiler (title-check), Cache-Refresh Endpoint POST /settings/system/refresh. |
| 2026-03-09 | LLM Timeouts entfernt: Alle Provider (Ollama, Anthropic, OpenAI, Google, CLI) ohne Timeout — Agenten dürfen unbegrenzt arbeiten. Ollama keep_alive von '0' auf '2m' geändert. MCP Agent Loop nur durch maxIterations (30) begrenzt. Neuer Endpoint: POST /agents/architect/start für manuelles Triggern. |
| 2026-03-09 | Phase 4: MonitorModule (HardwareService + MonitorGateway + MonitorController). Live GPU/CPU/RAM via nvtop/sysfs/proc. WebSocket /monitor Namespace. 3 neue Frontend-Pages: /projects (Tabelle), /agents (Rollen-Overview), /live-feed (Unified Activity Stream). Dashboard Hardware-Widget ersetzt statische Placeholder. Sidebar-Links alle aktiv. 4 neue i18n-Sektionen (monitor, liveFeed, projectsList, agentsPage). |
| 2026-03-09 | 2 neue MCP Server: fetch (@modelcontextprotocol/server-fetch) für Doku-Abruf, searxng (mcp-searxng, lokale SearXNG-Instanz auf :8088, envTemplate: search.searxng_url) für Web-Recherche. Architect bekommt auch filesystem-Zugriff. Gesamt: 15 Built-in Server. |
| 2026-03-09 | Architect Agent: 2-Phasen-Architektur (Phase A: Design nach DevOps, Phase B: Issue Grounding nach Issue Compiler). MCP-basierte Code-Analyse, Grounding-Kommentare auf Issues via postAgentComment(). Pipeline: DevOps→Architect(A)→IssueCompiler→Architect(B)→Coder. Neuer TaskType ANALYZE_ISSUES. |
| 2026-03-09 | Ollama VRAM Management: `keep_alive` basierend auf `pipeline.maxParallelOllamaModels` (default: 1 → sofort entladen). Max Fix Attempts: `pipeline.maxFixAttempts` (default: 20), alle fixIssue-Pfade konsolidiert über `retriggerCoder()`, neuer IssueStatus `NEEDS_REVIEW` + GitLab Label `status::needs-review`. PipelineConfig um 2 Felder erweitert. |
| 2026-03-09 | Stuck Task Cleanup jetzt Activity-Based: Prüft AgentLog + ChatMessage Recency statt reinem Zeitlimit. Agenten dürfen beliebig lange laufen — nur bei fehlender Aktivität (default: 30 Min) wird aufgeräumt. |
| 2026-03-09 | Pen Tester Kalibrierung: npm audit --omit=dev (nur Prod-Deps), Tech-Stack-Kontext im LLM-Prompt, konfigurierbare Schwellen (pentester.maxWarnings, pentester.skipHeaderCheck), server-seitige PASS/FAIL-Berechnung. Stuck Task Cleanup: Automatischer 5-Min-Check für hängende Tasks (pipeline.stuckTimeoutMinutes), Agent-Reset, Issue-Reset, Orphaned-Agent-Erkennung. |
| 2026-03-09 | 4 neue Built-in MCP Server: postgres (DB-Schema + read-only SQL), docker (Container-Management), sequential-thinking (strukturiertes Reasoning), memory (Knowledge Graph). Gesamt: 13 Built-in Server. |
| 2026-03-09 | MCP Project Overrides: Per-project ENABLE/DISABLE overrides (3 Endpoints /api/projects/:id/mcp-overrides), envTemplate resolution ({settings:key} → SystemSettings), 9 built-in servers (filesystem, git, gitlab, prisma, angular-cli, shell, playwright, eslint, security-audit), Frontend Override-Matrix in Projekt-Settings |
| 2026-03-09 | MCP Server Registry: Admin CRUD + Role Assignment API (6 Endpoints unter /api/mcp-servers), Built-in Server Seeding (filesystem, shell), Coder Agent dynamische MCP-Server-Auflösung, Frontend Settings-Integration |
| 2026-03-09 | GitLab Status Labels: `status::*` labels synced on every issue status transition (6 color-coded labels, idempotent). Shell MCP Server for Coder Agent (`shell-server.mjs`, whitelisted commands, security-hardened). |
| 2026-03-04 | Agent Comment Chat: Unified postAgentComment() utility (same rich markdown for local DB + GitLab, gitlabNoteId stored). Context injection: test agents receive previous agent comments in LLM prompts. GitLab Wiki CRUD (6 methods). Documenter Wiki sync (wikiPage flag in DocFile). |
| 2026-03-03 | Phase 3 Testing + Documenter: Functional Tester (LLM Acceptance Criteria Check), UI Tester (Playwright + LLM), Pen Tester (npm audit + HTTP headers + LLM OWASP), Documenter (LLM + Git). Erweiterte Pipeline: Review APPROVED → Functional → UI → Pen → Docs → DONE. 4 neue manuelle Trigger-Endpoints, StartTestDto, Feedback Loops für alle Test-Agents |
| 2026-03-03 | Coder Agent + Code Reviewer + Pipeline/User Feedback Loops: Komplette Coding-Pipeline von Issue→Code→Review→CI/CD→Fix. Qwen CLI --yolo, GitLab MRs, Issue Comments, Webhook-Expansion (note/pipeline/merge_request), IssueComment Model, .gitlab-ci.yml auto-generation, Frontend Issue-Detail Slide-over mit Comment-Timeline |
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
