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

> Noch nicht implementiert — Phase 1

---

## Chat

> Noch nicht implementiert — Phase 1

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
Secret Token: Wert von `GITLAB_WEBHOOK_SECRET` aus `.env`

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
| 2026-02-28 | GitLab-Integration: Service, Webhook-Controller, Projects-Integration |
| 2026-02-28 | Initial: Projects CRUD (5 Endpunkte) |
