/**
 * E2E Test Runner — Vaadin Task Manager Pipeline Test
 *
 * Simulates a user creating a Vaadin + Spring Boot + JPA project through VibCode Hub.
 * Tests the full pipeline: Interview → DevOps → Dev Session → Feature Interview → Architect → Issues → Coder
 *
 * Usage: npx tsx tests/e2e-vaadin-app.ts
 */

const API = 'http://localhost:3100/api';
const KEYCLOAK_URL = 'https://sso.example.com';
const REALM = 'vibcodehub';
const CLIENT_ID = 'vibcodehub-frontend';
const BOT_USER = 'vibcode-bot';
const BOT_PASS = 'REDACTED_BOT_PASSWORD';

const POLL_INTERVAL = 15_000; // 15 seconds
const INTERVIEW_TIMEOUT = 30 * 60_000; // 30 min
const DEVOPS_TIMEOUT = 60 * 60_000; // 60 min
const PIPELINE_TIMEOUT = 10 * 60 * 60_000; // 10 hours (Java builds are slower)

// ─── Interview Responses ──────────────────────────────────

const INFRA_INTERVIEW_RESPONSES = [
  // First response — comprehensive project description with Vaadin stack
  `Ich möchte eine Task-Management-App bauen mit Vaadin und Spring Boot. Details:

**Tech Stack:**
- Frontend: Vaadin Flow (Java-basiertes UI-Framework, Server-Side Rendering via Web Components)
- Styling: Tailwind CSS 4 (Utility-first CSS, integriert über Vite)
- Backend: Spring Boot 3.4 als Application Framework
- ORM: Spring Data JPA + Hibernate
- Datenbank: PostgreSQL
- Migrationen: Flyway
- Build: Maven
- Sprache: Java 21

**Init Command:**
\`\`\`
curl https://start.spring.io/starter.tgz -d type=maven-project -d language=java -d bootVersion=3.4.4 -d baseDir=. -d groupId=com.taskmanager -d artifactId=task-manager -d name=TaskManager -d packageName=com.taskmanager -d dependencies=web,data-jpa,flyway,postgresql,vaadin,validation -d javaVersion=21 | tar -xzvf -
\`\`\`

**Kern-Features:**
1. Task CRUD (erstellen, bearbeiten, löschen, anzeigen)
2. Kategorien für Tasks
3. Prioritäten (Low, Medium, High, Critical)
4. Status-Workflow: Open → In Progress → Done
5. Filterung und Suche

**Deployment:**
- Dev Server Port: 8080
- Dev Command: mvn spring-boot:run
- Build: mvn clean package -Pproduction
- PostgreSQL Datenbank wird benötigt`,

  // Follow-up: confirmation
  `Ja, das sind alle Details. Die App soll einfach und übersichtlich sein. Kein Auth/Login nötig, Single-User-App.

Bitte folgende MCP-Server einrichten:
- vaadin (Vaadin Flow Doku)
- spring-docs (Spring Boot Doku)
- context7 (allgemeine Doku)

PostgreSQL Datenbank "task_manager" auf localhost:5432. Flyway Migrationen in src/main/resources/db/migration/.`,

  // Additional info if needed
  `Keine weiteren Features. Kein Auth, kein File Upload, keine Echtzeit-Updates. Einfach eine saubere Task-Management App. Die App soll auf localhost:8080 laufen. Maven Wrapper (mvnw) bitte mit generieren.`,

  // Catch-all confirmations
  `Ja, das passt so. Bitte fasse zusammen und starte mit dem Setup.`,
  `Ja, einverstanden. Los geht's!`,
  `Bestätigt.`,
];

const FEATURE_INTERVIEW_RESPONSES = [
  // Comprehensive feature description for the dev session
  `Für diese Session möchte ich die Kern-Features der Task Manager App implementieren:

1. **Task Entity + Repository**
   - JPA Entity: Task mit id (UUID), title (String, required), description (String), priority (Enum: LOW/MEDIUM/HIGH/CRITICAL), status (Enum: OPEN/IN_PROGRESS/DONE), dueDate (LocalDate), createdAt, updatedAt
   - Spring Data JPA Repository mit custom Queries (findByStatus, findByPriority, search by title)
   - Flyway Migration V1__create_tasks_table.sql

2. **Category Entity + Repository**
   - JPA Entity: Category mit id (UUID), name (String, unique), color (String, hex)
   - ManyToOne Relation: Task → Category (optional)
   - Flyway Migration V2__create_categories_table.sql

3. **Task Service**
   - CRUD Operations (create, read, update, delete)
   - Filterung nach Status, Kategorie, Priorität
   - Suche über Titel + Beschreibung (LIKE query)

4. **Vaadin Task-Liste View**
   - Hauptseite (@Route "")
   - Grid/Tabelle mit allen Tasks (sortierbar)
   - Filter-Dropdowns für Status, Kategorie, Priorität
   - Suchfeld für Textsuche
   - Buttons: "New Task", Edit, Delete pro Zeile

5. **Vaadin Task-Formular**
   - Dialog oder separate View für Task erstellen/bearbeiten
   - FormLayout mit: Title (TextField), Description (TextArea), Priority (ComboBox), Category (ComboBox), DueDate (DatePicker), Status (ComboBox)
   - Validation: Title required, min 3 Zeichen

6. **Vaadin Category-Management**
   - Einfache View oder Dialog für Kategorien verwalten
   - Name + Farbe (ColorPicker oder TextField)`,

  // Follow-up confirmation
  `Ja, das sind alle Features. Prioritäten:
- Must-have: Task Entity + Repository, Category Entity, Task Service, Task-Liste View, Task-Formular
- Should-have: Category Management, Filterung, Suche
- Nice-to-have: Sortierung in der Tabelle

application.properties soll so konfiguriert sein:
- spring.datasource.url=jdbc:postgresql://localhost:5432/task_manager
- spring.jpa.hibernate.ddl-auto=validate (Flyway macht die Migrationen)
- spring.flyway.enabled=true
- vaadin.launch-browser=false`,

  // Additional confirmation
  `Perfekt, das passt so. Bitte mach weiter mit der Architektur.`,
  `Ja, einverstanden.`,
  `Bestätigt, weiter.`,
];

// ─── State ────────────────────────────────────────────────

interface TestState {
  token: string;
  projectId: string;
  projectSlug: string;
  infraSessionId: string;
  devSessionId: string;
  phase: string;
  startTime: number;
  errors: string[];
}

const state: TestState = {
  token: '',
  projectId: '',
  projectSlug: '',
  infraSessionId: '',
  devSessionId: '',
  phase: 'INIT',
  startTime: Date.now(),
  errors: [],
};

// ─── Logging ──────────────────────────────────────────────

function log(msg: string) {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const ts = `[${String(mins).padStart(3, '0')}:${String(secs).padStart(2, '0')}]`;
  const line = `${ts} [${state.phase}] ${msg}`;
  console.log(line);
}

function logError(msg: string) {
  state.errors.push(msg);
  log(`ERROR: ${msg}`);
}

// ─── HTTP Helpers ─────────────────────────────────────────

async function api(method: string, path: string, body?: any): Promise<any> {
  const url = `${API}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`API ${method} ${path} -> ${res.status}: ${text.substring(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getToken(): Promise<string> {
  const url = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: CLIENT_ID,
    username: BOT_USER,
    password: BOT_PASS,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keycloak auth failed: ${res.status} ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function refreshToken() {
  try {
    state.token = await getToken();
    log('Token refreshed');
  } catch (err: any) {
    logError(`Token refresh failed: ${err.message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message Helpers ──────────────────────────────────────

async function getMessages(sessionId: string): Promise<any[]> {
  return api('GET', `/chat/sessions/${sessionId}/messages`);
}

async function sendMessage(sessionId: string, content: string): Promise<any> {
  return api('POST', '/chat/messages', {
    chatSessionId: sessionId,
    role: 'USER',
    content,
  });
}

// ─── Interview Runner ─────────────────────────────────────

async function runInterview(
  sessionId: string,
  responses: string[],
  label: string,
  timeoutMs: number,
): Promise<boolean> {
  log(`Starting ${label}...`);

  let responseIdx = 0;
  let lastMessageId = '';
  let lastMessageCount = 0;
  let stableCount = 0;
  const start = Date.now();

  // Wait for first agent message
  await sleep(5000);

  while (Date.now() - start < timeoutMs) {
    // Refresh token every 4 minutes
    if ((Date.now() - start) % (4 * 60_000) < POLL_INTERVAL) {
      await refreshToken();
    }

    const messages = await getMessages(sessionId);
    const agentMsgs = messages.filter((m: any) => m.role === 'AGENT');

    // Check for completion markers in messages
    const allContent = messages.map((m: any) => m.content).join('\n');
    if (allContent.includes(':::INTERVIEW_COMPLETE:::') ||
        allContent.includes(':::FEATURE_INTERVIEW_COMPLETE:::') ||
        allContent.includes('Interview abgeschlossen') ||
        allContent.includes('interview complete') ||
        allContent.includes('setup complete') ||
        allContent.includes('Project setup complete')) {
      log(`${label} completed!`);
      return true;
    }

    // Check if the last message is from an agent and waiting for user input
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'AGENT' && lastMsg.id !== lastMessageId) {
      lastMessageId = lastMsg.id;
      stableCount = 0;

      // Check if agent is waiting for response
      const isQuestion = lastMsg.content.includes('?') ||
                         lastMsg.content.toLowerCase().includes('was') ||
                         lastMsg.content.toLowerCase().includes('welche') ||
                         lastMsg.content.toLowerCase().includes('tell me') ||
                         lastMsg.content.toLowerCase().includes('describe');

      if (isQuestion && responseIdx < responses.length) {
        log(`Agent asked (${lastMsg.content.substring(0, 80)}...) — sending response #${responseIdx + 1}`);
        await sleep(2000);
        await sendMessage(sessionId, responses[responseIdx]);
        responseIdx++;
        await sleep(3000);
        continue;
      }
    }

    // Check if messages haven't changed (agent might be processing)
    if (messages.length === lastMessageCount) {
      stableCount++;
      if (stableCount > 20) {
        if (responseIdx < responses.length) {
          log(`No activity for 5 min — sending nudge response #${responseIdx + 1}`);
          await sendMessage(sessionId, responses[responseIdx]);
          responseIdx++;
          stableCount = 0;
        }
      }
    } else {
      stableCount = 0;
    }
    lastMessageCount = messages.length;

    if (stableCount % 4 === 0 && stableCount > 0) {
      log(`Waiting... (${messages.length} messages, ${agentMsgs.length} from agents)`);
    }

    await sleep(POLL_INTERVAL);
  }

  logError(`${label} timed out after ${timeoutMs / 60000} minutes`);
  return false;
}

// ─── Pipeline Monitor ─────────────────────────────────────

async function monitorPipeline(sessionId: string): Promise<boolean> {
  log('Pipeline monitoring started...');
  const start = Date.now();
  let lastLogLine = '';
  let lastErrorId = '';

  while (Date.now() - start < PIPELINE_TIMEOUT) {
    // Refresh token every 4 minutes
    if ((Date.now() - start) % (4 * 60_000) < POLL_INTERVAL) {
      await refreshToken();
    }

    try {
      const agentStatus = await api('GET', `/agents/status/${state.projectId}`);
      const activeAgents = (agentStatus || []).filter((a: any) =>
        a.status === 'WORKING' || a.status === 'WAITING'
      );

      const issues = await api('GET', `/issues?projectId=${state.projectId}`);
      const topLevel = issues.filter((i: any) => !i.parentId);
      const openCount = topLevel.filter((i: any) => i.status === 'OPEN').length;
      const doneCount = topLevel.filter((i: any) => i.status === 'DONE' || i.status === 'CLOSED').length;
      const inProgressCount = topLevel.filter((i: any) => i.status === 'IN_PROGRESS').length;
      const inReviewCount = topLevel.filter((i: any) => i.status === 'IN_REVIEW').length;
      const testingCount = topLevel.filter((i: any) => i.status === 'TESTING').length;
      const needsReviewCount = topLevel.filter((i: any) => i.status === 'NEEDS_REVIEW').length;
      const pendingCount = openCount + inProgressCount + inReviewCount + testingCount;

      const parts = [`${doneCount}/${topLevel.length} done`];
      if (inProgressCount) parts.push(`${inProgressCount} coding`);
      if (inReviewCount) parts.push(`${inReviewCount} review`);
      if (testingCount) parts.push(`${testingCount} testing`);
      if (needsReviewCount) parts.push(`${needsReviewCount} needs-review`);
      if (openCount) parts.push(`${openCount} open`);
      const statusLine = `Agents: ${activeAgents.map((a: any) => a.role).join(', ') || 'none'} | Issues: ${parts.join(', ')}`;

      if (statusLine !== lastLogLine) {
        log(statusLine);
        lastLogLine = statusLine;
      }

      // Check for completion
      if (topLevel.length > 0 && pendingCount === 0 && activeAgents.length === 0) {
        log(`Pipeline complete! ${doneCount}/${topLevel.length} issues done.`);

        log('--- ISSUE SUMMARY ---');
        for (const issue of topLevel) {
          log(`  [${issue.status}] ${issue.title} (${issue.priority})`);
        }

        return true;
      }

      // Check for errors
      const messages = await getMessages(sessionId);
      const errorMsgs = messages.filter((m: any) =>
        m.content?.includes('error') || m.content?.includes('failed')
      );
      if (errorMsgs.length > 0) {
        const lastError = errorMsgs[errorMsgs.length - 1];
        if (lastError.id !== lastErrorId) {
          lastErrorId = lastError.id;
          log(`Warning: ${lastError.content.substring(0, 150)}`);
        }
      }

    } catch (err: any) {
      logError(`Monitor error: ${err.message}`);
    }

    await sleep(POLL_INTERVAL);
  }

  logError('Pipeline timed out');
  return false;
}

// ─── Project Status Check ─────────────────────────────────

async function waitForProjectReady(timeoutMs: number): Promise<boolean> {
  log('Waiting for project to reach READY status...');
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if ((Date.now() - start) % (4 * 60_000) < POLL_INTERVAL) {
      await refreshToken();
    }

    try {
      const project = await api('GET', `/projects/${state.projectSlug}`);
      if (project.status === 'READY') {
        log(`Project is READY`);
        return true;
      }

      const messages = await getMessages(state.infraSessionId);
      const lastAgent = messages.filter((m: any) => m.role === 'AGENT').pop();
      if (lastAgent) {
        log(`DevOps: ${lastAgent.content.substring(0, 100)}`);
      }
    } catch (err: any) {
      logError(`Status check failed: ${err.message}`);
    }

    await sleep(POLL_INTERVAL);
  }

  logError('Project READY timeout');
  return false;
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  log('=============================================');
  log('  VibCode Hub E2E Test — Vaadin Task Manager');
  log('=============================================');

  // ── Phase 0: Auth ──
  state.phase = 'AUTH';
  log('Getting Keycloak token...');
  state.token = await getToken();
  log('Authenticated');

  // ── Phase 1: Create Project ──
  state.phase = 'CREATE';
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const projectName = `Task Manager ${ts}`;
  log(`Creating project "${projectName}"...`);
  const result = await api('POST', '/projects/quick', { name: projectName });
  state.projectId = result.project.id;
  state.projectSlug = result.project.slug;
  state.infraSessionId = result.interview.chatSessionId;
  log(`Project created: ${state.projectId} (slug: ${state.projectSlug})`);
  log(`  Infrastructure session: ${state.infraSessionId}`);

  // ── Phase 2: Infrastructure Interview ──
  state.phase = 'INFRA_INTERVIEW';
  const interviewOk = await runInterview(
    state.infraSessionId,
    INFRA_INTERVIEW_RESPONSES,
    'Infrastructure Interview',
    INTERVIEW_TIMEOUT,
  );
  if (!interviewOk) {
    logError('Infrastructure interview failed — aborting');
    return printSummary();
  }

  // ── Phase 3: Wait for DevOps Setup ──
  state.phase = 'DEVOPS';
  const devopsOk = await waitForProjectReady(DEVOPS_TIMEOUT);
  if (!devopsOk) {
    logError('DevOps setup failed — aborting');
    return printSummary();
  }

  // ── Phase 4: Create Dev Session ──
  state.phase = 'DEV_SESSION';
  log('Creating Dev Session "Core Features"...');
  await sleep(3000);
  const devSession = await api('POST', '/chat/sessions/dev', {
    projectId: state.projectId,
    title: 'Core Features',
  });
  state.devSessionId = devSession.id;
  log(`Dev Session created: ${state.devSessionId} (branch: ${devSession.branch})`);

  // ── Phase 5: Feature Interview ──
  state.phase = 'FEATURE_INTERVIEW';
  const featureOk = await runInterview(
    state.devSessionId,
    FEATURE_INTERVIEW_RESPONSES,
    'Feature Interview',
    INTERVIEW_TIMEOUT,
  );
  if (!featureOk) {
    log('Feature interview may have completed (no explicit marker) — continuing...');
  }

  // ── Phase 6: Monitor Pipeline ──
  state.phase = 'PIPELINE';
  log('Dev Session pipeline starting...');
  log('Expected: Architect -> Issue Compiler -> Grounding -> Coder -> Review -> Test -> Docs -> Merge -> DONE');
  const pipelineOk = await monitorPipeline(state.devSessionId);

  // ── Phase 7: Verification ──
  state.phase = 'VERIFY';
  await runVerification();

  // ── Done ──
  printSummary();
}

async function runVerification() {
  log('--- VERIFICATION ---');

  try {
    const issues = await api('GET', `/issues?projectId=${state.projectId}`);
    const topLevel = issues.filter((i: any) => !i.parentId);
    const doneIssues = topLevel.filter((i: any) => i.status === 'DONE' || i.status === 'CLOSED');
    const needsReview = topLevel.filter((i: any) => i.status === 'NEEDS_REVIEW');
    log(`Issues: ${topLevel.length} total, ${doneIssues.length} done, ${needsReview.length} needs-review`);

    const milestones = await api('GET', `/milestones?projectId=${state.projectId}`);
    log(`Milestones: ${milestones.length}`);

    const project = await api('GET', `/projects/${state.projectSlug}`);
    log(`Project status: ${project.status}`);
    log(`GitLab project ID: ${project.gitlabProjectId || 'none'}`);

    if (state.devSessionId) {
      const session = await api('GET', `/chat/sessions/${state.devSessionId}`);
      log(`Dev Session status: ${session.status}`);
      log(`Dev Session branch: ${session.branch}`);
    }

    try {
      const logs = await api('GET', `/monitor/logs?projectId=${state.projectId}&agentRole=ALL&level=ERROR`);
      if (logs.length > 0) {
        log(`${logs.length} error logs found:`);
        for (const entry of logs.slice(-5)) {
          log(`  [${entry.agentRole ?? 'unknown'}] ${entry.message}`);
        }
      } else {
        log('No error logs');
      }
    } catch {
      // Monitor endpoint might not support these params
    }

  } catch (err: any) {
    logError(`Verification failed: ${err.message}`);
  }
}

function printSummary() {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  log('');
  log('=============================================');
  log(`  TEST COMPLETE — ${hours}h ${mins}m elapsed`);
  log('=============================================');
  log(`  Project: ${state.projectSlug} (${state.projectId})`);
  log(`  Infra Session: ${state.infraSessionId}`);
  log(`  Dev Session: ${state.devSessionId}`);
  log(`  Errors: ${state.errors.length}`);
  if (state.errors.length > 0) {
    log('  Error details:');
    for (const err of state.errors) {
      log(`    - ${err}`);
    }
  }
  log('=============================================');
}

// ─── Run ──────────────────────────────────────────────────

main().catch((err) => {
  logError(`Fatal: ${err.message}`);
  console.error(err.stack);
  printSummary();
  process.exit(1);
});
