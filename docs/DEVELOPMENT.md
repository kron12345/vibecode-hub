# VibCode Hub — Entwicklungsrichtlinien

## MCP-Nutzung (Pflicht)

Drei MCP-Server stehen zur Verfügung. Sie MÜSSEN aktiv genutzt werden.

| Server | Tools | Wann nutzen |
|---|---|---|
| `angular` | `get_best_practices`, `find_examples`, `search_documentation` | Vor jeder Angular-Änderung |
| `prisma` | Schema lesen, `migrate dev`, `generate` | Vor jeder DB/Model-Änderung |
| `mcp-nest` | NestJS-Patterns, Decorator-Hilfe | Vor jeder Backend-Änderung |

### Reihenfolge
- **Angular**: `get_best_practices` → `find_examples` → `search_documentation`
- **Prisma**: Schema lesen → `migrate dev` → `generate` (NIEMALS `migrate reset` ohne Nachfrage!)
- **Projekt**: lint → test → build (devserver nur bei Bedarf)

## Umsetzungsschleife

Jede Aufgabe folgt diesem Zyklus:

1. **Planen** — 2–6 Schritte skizzieren
2. **MCP befragen** — Relevante Best Practices und Beispiele holen
3. **Implementieren** — Kleine, überprüfbare Schritte
4. **Verifizieren** — Build/Test/Lint ausführen
5. **Bei Fehlern** — Analysieren → fixen → wiederholen bis grün
6. **Abschluss** — Zusammenfassung schreiben

## Verbote

- NICHT halluzinieren — bei Unklarheiten MCP-Tools nutzen
- KEINE destruktiven DB-Operationen ohne explizite User-Bestätigung (`migrate reset`, `drop`)
- KEINE langen Logs in den Chat — nur relevante Fehler + Dateien/Zeilen
- NICHT raten wenn MCP-Server die Antwort liefern können

## Aufgaben-Abschluss

Jede Aufgabe endet mit:
```
### Zusammenfassung
- **Geändert**: [Dateien/Module]
- **Commands**: [was lief]
- **Status**: [grün / offene Punkte]
```

## Auto-Dokumentation (AUTOMATISCH — nicht auf Nachfrage)

Folgende Docs werden SELBSTSTÄNDIG aktualisiert, sobald der jeweilige Trigger eintritt:

| Trigger | Datei | Was aktualisieren |
|---|---|---|
| Neuer/geänderter API-Endpunkt | `docs/API.md` | Route, Method, Auth, DTO, Changelog-Zeile |
| Prisma-Schema-Änderung | `docs/ARCHITECTURE.md` | Datenmodell-Sektion |
| Feature fertig / Fortschritt | `docs/SPEC.md` | Phasenplan-Checkboxen |
| Strukturelle Änderung | `docs/ARCHITECTURE.md` | Relevante Sektion |
| Neue Konvention / Regel | `docs/DEVELOPMENT.md` | Relevante Sektion |
| Ende jeder Session | `docs/PROMPTS.md` | Alle Prompts + Ergebnisse |
| Neue Patterns / Commands | `CLAUDE.md` | Relevante Sektion |

### Docs-Übersicht

| Datei | Inhalt |
|---|---|
| `docs/API.md` | Alle REST-Endpunkte, DTOs, Auth-Infos, Changelog |
| `docs/SPEC.md` | Anforderungen, Agenten-Rollen, Phasenplan |
| `docs/ARCHITECTURE.md` | Tech-Diagramme, Datenmodell, Routing, MCP |
| `docs/DEVELOPMENT.md` | Arbeitsregeln, MCP-Pflicht, Auto-Doku-Trigger |
| `docs/PROMPTS.md` | Chronologisches Log aller Prompts + Ergebnisse |
| `CLAUDE.md` | Kompakt-Anleitung für Claude Code |
