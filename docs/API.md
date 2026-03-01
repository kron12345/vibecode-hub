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
| `PUT` | `/api/projects/:id` | Ja | Projekt aktualisieren |
| `DELETE` | `/api/projects/:id` | Ja | Projekt löschen |

### DTOs

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
  gitlabProjectId?: number;
  gitlabUrl?: string;
}
```

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
| `agents` | `agents.defaults.{ROLE}` (6x) | nein |
| `app` | `app.name` | nein |

---

## Agents

> Noch nicht implementiert — Phase 2

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
- `createIssue(projectId, title, description, labels)` → Issue erstellen
- `getIssues(projectId, state)` → Issues auflisten
- `getIssue(projectId, iid)` → Einzelnes Issue holen
- `updateIssue(projectId, iid, data)` → Issue aktualisieren
- `closeIssue(projectId, iid)` → Issue schließen
- `addWebhook(projectId, url, secret)` → Webhook registrieren

---

## Changelog

| Datum | Änderung |
|---|---|
| 2026-03-01 | Settings: User + System Settings API (6 Endpunkte), AES-256-GCM Encryption, RBAC Admin Guard |
| 2026-02-28 | Chat: Sessions + Messages REST API, WebSocket Gateway (/chat namespace) |
| 2026-02-28 | Issues CRUD: 5 Endpunkte mit GitLab-Sync, Sub-Issues, Agent-Assignment |
| 2026-02-28 | GitLab-Integration: Service, Webhook-Controller, Projects-Integration |
| 2026-02-28 | Initial: Projects CRUD (5 Endpunkte) |
