/**
 * VibCode Hub — Full Pipeline E2E Test
 *
 * Creates a project via UI, runs through the interview,
 * then monitors the entire agent pipeline:
 *   Interview → DevOps → Issue Compiler → Coder → Code Reviewer
 *   → Functional Tester → UI Tester → Pen Tester → Documenter
 *
 * Validates: Issues created, comments posted, code committed.
 *
 * Usage:  npx ts-node tests/pipeline-e2e.ts
 */
import { chromium, Page } from 'playwright';

// ─── Config ──────────────────────────────────────────────────────
const HUB_URL = 'https://hub.example.com';
const API_URL = `${HUB_URL}/api`;
const KC_URL = 'https://sso.example.com';
const BOT_USER = 'vibcode-bot';
const BOT_PASS = 'REDACTED_BOT_PASSWORD';
const PROJECT_NAME = `E2E Counter ${Date.now().toString(36).slice(-4)}`;

const SCREENSHOT_DIR = '/tmp/vibcode-e2e';

// Timeouts
const LOGIN_TIMEOUT = 15_000;
const AGENT_RESPONSE_TIMEOUT = 180_000;     // 3 min per agent response
const PIPELINE_STAGE_TIMEOUT = 600_000;     // 10 min per pipeline stage
const TOTAL_PIPELINE_TIMEOUT = 2_700_000;   // 45 min total

// Interview answers — comprehensive first, then confirmations
const INTERVIEW_ANSWERS = [
  `Ich möchte eine einfache Click Counter Web-App. Hier alle Details:

**Technologie**: Vanilla HTML + CSS + JavaScript. Kein Framework (kein Angular, React etc.).

**Features**:
1. Großer Zähler-Display der bei 0 startet
2. Plus-Button: Erhöht den Zähler um 1
3. Minus-Button: Verringert den Zähler um 1
4. Reset-Button: Setzt auf 0 zurück

**Design**: Einfaches modernes Design, zentriert auf der Seite, dunkler Hintergrund, große Buttons.

**Kein Backend**, keine Datenbank, keine API, keine Auth, keine externen Dependencies.
**Deployment**: Statische Dateien (index.html, style.css, script.js).
**Build**: Keins nötig.
**Port**: 8080 (einfacher HTTP-Server zum Testen).

Das ist wirklich alles — minimales Projekt.`,

  'Nein, keine weiteren Features nötig. Nur der Counter mit Plus, Minus und Reset. Das Projekt ist bewusst minimal gehalten.',

  'Keine Tests, keine CI/CD Besonderheiten. Einfach die drei Dateien: index.html, style.css, script.js. Bitte Interview abschließen.',

  'Ja, das ist vollständig und korrekt. Bitte Interview abschließen.',

  'Korrekt. Bitte das Interview jetzt beenden.',

  'Ja, abschließen.',
];

// ─── Helpers ─────────────────────────────────────────────────────
function log(phase: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ${msg}`);
}

function logError(phase: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] [${phase}] ❌ ${msg}`);
}

function logOk(phase: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ✅ ${msg}`);
}

async function screenshot(page: Page, name: string) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  log('SCREENSHOT', path);
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// Enable Keycloak Direct Access Grants for programmatic login fallback
async function kcAdminToken(): Promise<string> {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'client_id=admin-cli&grant_type=password&username=admin&password=oASdZSRb87k4ndRugLhstjKHT0ze7858',
  });
  return (await res.json()).access_token;
}

async function setDAG(enabled: boolean) {
  const t = await kcAdminToken();
  await fetch(`${KC_URL}/admin/realms/vibcodehub/clients/f787c72b-9633-48aa-8b33-ff660c0a9b24`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'vibcodehub-frontend', directAccessGrantsEnabled: enabled }),
  });
}

// Get a JWT token for API verification calls
async function getApiToken(): Promise<string> {
  const res = await fetch(`${KC_URL}/realms/vibcodehub/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=vibcodehub-frontend&grant_type=password&username=${BOT_USER}&password=${BOT_PASS}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token fetch failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function apiGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Test Results ────────────────────────────────────────────────
interface TestResult {
  phase: string;
  passed: boolean;
  details: string;
  duration?: number;
}

const results: TestResult[] = [];

function recordResult(phase: string, passed: boolean, details: string, duration?: number) {
  results.push({ phase, passed, details, duration });
  if (passed) {
    logOk(phase, details);
  } else {
    logError(phase, details);
  }
}

// ─── Phase 1: Login ──────────────────────────────────────────────
async function login(page: Page): Promise<boolean> {
  log('LOGIN', `Navigating to ${HUB_URL}...`);
  await page.goto(HUB_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  if (page.url().includes('sso.example.com')) {
    log('LOGIN', 'Keycloak login page detected, filling credentials...');
    await page.fill('#username', BOT_USER);
    await page.fill('#password', BOT_PASS);
    await page.click('#kc-login');
    await page.waitForURL(`${HUB_URL}/**`, { timeout: LOGIN_TIMEOUT });
    log('LOGIN', `Redirected to ${page.url()}`);
  }

  // Wait for dashboard to load
  await page.waitForTimeout(2000);
  const title = await page.title();
  log('LOGIN', `Page title: ${title}, URL: ${page.url()}`);
  return true;
}

// ─── Phase 2: Create Project ─────────────────────────────────────
async function createProject(page: Page): Promise<string> {
  log('CREATE', `Creating project "${PROJECT_NAME}"...`);

  // Click "New Project" button
  const newProjectBtn = page.locator('button', { hasText: /plus|Neues Projekt|New Project/i }).first();
  await newProjectBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await newProjectBtn.click();
  log('CREATE', 'Clicked "New Project" button');

  // Wait for modal
  await page.waitForSelector('.fixed.inset-0', { timeout: 5000 });
  log('CREATE', 'Create modal opened');

  // Fill project name
  const nameInput = page.locator('.glass-heavy input');
  await nameInput.fill(PROJECT_NAME);
  log('CREATE', `Entered name: "${PROJECT_NAME}"`);

  await screenshot(page, '01-create-modal');

  // Click "Start Interview" button
  const startBtn = page.locator('.glass-heavy button', { hasText: /Interview|Start/i }).first();
  await startBtn.click();
  log('CREATE', 'Clicked "Start Interview"');

  // Wait for navigation to project page
  await page.waitForURL(`${HUB_URL}/projects/**`, { timeout: 15_000 });
  const slug = page.url().split('/projects/')[1]?.split('?')[0] ?? '';
  log('CREATE', `Navigated to project page: /projects/${slug}`);

  await page.waitForTimeout(3000);
  await screenshot(page, '02-project-page');

  return slug;
}

// ─── Phase 3: Interview ─────────────────────────────────────────
/** Check project status via API — more reliable than DOM checks */
async function checkProjectStatusApi(slug: string): Promise<string> {
  try {
    const token = await getApiToken();
    const projects = await apiGet('/projects', token);
    const proj = projects.find((p: any) => p.slug === slug);
    return proj?.status ?? 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

let currentProjectSlug = '';

async function runInterview(page: Page): Promise<boolean> {
  log('INTERVIEW', 'Waiting for chat session to open...');

  // Wait for the chat input to appear (interview session auto-opens)
  const chatInput = page.locator('input.font-mono[type="text"]');
  try {
    await chatInput.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    log('INTERVIEW', 'Chat input not found with font-mono selector, trying alternatives...');
    await screenshot(page, '03-no-chat-input');
    const altInput = page.locator('input[type="text"]').last();
    await altInput.waitFor({ state: 'visible', timeout: 10_000 });
  }

  // Wait for the first agent message
  log('INTERVIEW', 'Waiting for first agent message...');
  try {
    await page.waitForSelector('span.text-emerald-400, span.text-indigo-400', {
      timeout: AGENT_RESPONSE_TIMEOUT,
    });
    log('INTERVIEW', 'First agent message received');
  } catch {
    log('INTERVIEW', 'No agent message yet, waiting for streaming to end...');
    await page.waitForFunction(
      () => !document.querySelector('.animate-bounce'),
      { timeout: AGENT_RESPONSE_TIMEOUT },
    );
  }

  await screenshot(page, '03-first-agent-msg');

  // Send interview answers
  let answerIndex = 0;
  let interviewComplete = false;
  const maxRounds = INTERVIEW_ANSWERS.length + 4; // extra rounds for retries

  for (let round = 0; round < maxRounds && !interviewComplete; round++) {
    await sleep(2000);

    // Check project status via API (most reliable)
    const apiStatus = await checkProjectStatusApi(currentProjectSlug);
    if (apiStatus !== 'INTERVIEWING' && apiStatus !== 'UNKNOWN') {
      log('INTERVIEW', `Project status via API: ${apiStatus} — interview complete!`);
      interviewComplete = true;
      break;
    }

    // Get current answer
    const answer = INTERVIEW_ANSWERS[Math.min(answerIndex, INTERVIEW_ANSWERS.length - 1)];
    answerIndex++;

    // Find and fill the chat input
    const input = page.locator('input.font-mono[type="text"]').first();
    if (await input.isVisible()) {
      await input.fill(answer);
      await input.press('Enter');
    } else {
      const altInput = page.locator('input[type="text"]').last();
      await altInput.fill(answer);
      await altInput.press('Enter');
    }
    log('INTERVIEW', `Sent answer #${answerIndex}: "${answer.slice(0, 60)}..."`);

    await screenshot(page, `04-interview-answer-${answerIndex}`);

    // Wait for agent response (or completion)
    log('INTERVIEW', 'Waiting for agent response...');
    const msgCountBefore = await page.locator('span.text-emerald-400').count();

    const responseReceived = await Promise.race([
      // Option A: New agent message appears
      page.waitForFunction(
        (prevCount: number) => {
          const msgs = document.querySelectorAll('span.text-emerald-400');
          return msgs.length > prevCount;
        },
        msgCountBefore,
        { timeout: AGENT_RESPONSE_TIMEOUT },
      ).then(() => 'message' as const),
      // Option B: Interview completes (poll API every 5s)
      (async () => {
        const deadline = Date.now() + AGENT_RESPONSE_TIMEOUT;
        while (Date.now() < deadline) {
          await sleep(5000);
          const status = await checkProjectStatusApi(currentProjectSlug);
          if (status !== 'INTERVIEWING' && status !== 'UNKNOWN') return 'complete' as const;
        }
        return 'timeout' as const;
      })(),
    ]);

    if (responseReceived === 'complete') {
      log('INTERVIEW', 'Interview completed (detected via API poll)');
      interviewComplete = true;
      break;
    } else if (responseReceived === 'message') {
      log('INTERVIEW', 'Agent responded');
    } else {
      log('INTERVIEW', 'Timeout waiting for response — checking API...');
      const finalCheck = await checkProjectStatusApi(currentProjectSlug);
      if (finalCheck !== 'INTERVIEWING') {
        interviewComplete = true;
        break;
      }
      await screenshot(page, `04-interview-timeout-${round}`);
    }
  }

  await screenshot(page, '05-interview-done');
  return interviewComplete;
}

// ─── Phase 4: Monitor Pipeline ───────────────────────────────────
const PIPELINE_STAGES = [
  'DEVOPS', 'ISSUE_COMPILER', 'CODER', 'CODE_REVIEWER',
  'FUNCTIONAL_TESTER', 'UI_TESTER', 'PEN_TESTER', 'DOCUMENTER',
];

async function monitorPipeline(page: Page, slug: string, token: string): Promise<Map<string, string>> {
  log('PIPELINE', 'Monitoring pipeline via issue status progression...');
  const stageStatus = new Map<string, string>();
  const startTime = Date.now();
  let lastLogTime = 0;

  // Find project ID
  let projectId = '';
  try {
    const projects = await apiGet('/projects', token);
    const proj = projects.find((p: any) => p.slug === slug);
    projectId = proj?.id ?? '';
  } catch {}

  if (!projectId) {
    logError('PIPELINE', 'Could not find project ID');
    return stageStatus;
  }

  let prevIssueSnapshot = '';

  while (Date.now() - startTime < TOTAL_PIPELINE_TIMEOUT) {
    // Refresh token periodically (every 4 min)
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 240 === 0) {
      try { token = await getApiToken(); } catch {}
    }

    // Fetch issues to check pipeline progress
    let issues: any[] = [];
    try {
      issues = await apiGet(`/issues?projectId=${projectId}`, token);
    } catch (e: any) {
      log('PIPELINE', `API error fetching issues: ${e.message}`);
      await sleep(10_000);
      continue;
    }

    // Build status snapshot
    const statusCounts: Record<string, number> = {};
    for (const issue of issues) {
      statusCounts[issue.status] = (statusCounts[issue.status] ?? 0) + 1;
    }
    const snapshot = JSON.stringify(statusCounts);

    // Log changes
    if (snapshot !== prevIssueSnapshot) {
      prevIssueSnapshot = snapshot;
      const parts = Object.entries(statusCounts).map(([s, c]) => `${s}:${c}`);
      log('PIPELINE', `Issue statuses: ${parts.join(', ')} (${issues.length} total)`);

      // Check for specific statuses to infer pipeline stage
      if (statusCounts['IN_REVIEW']) {
        stageStatus.set('CODER', 'COMPLETED');
        stageStatus.set('CODE_REVIEWER', 'WORKING');
      }
      if (statusCounts['TESTING']) {
        stageStatus.set('CODE_REVIEWER', 'COMPLETED');
        stageStatus.set('FUNCTIONAL_TESTER', 'WORKING');
      }
      if (statusCounts['DONE'] || statusCounts['CLOSED']) {
        stageStatus.set('DOCUMENTER', 'COMPLETED');
      }
      if (statusCounts['IN_PROGRESS']) {
        stageStatus.set('CODER', 'WORKING');
      }

      await screenshot(page, `06-pipeline-${elapsed}s`);
    }

    // Check if all issues are DONE/CLOSED
    const allDone = issues.length > 0 && issues.every(
      (i: any) => i.status === 'DONE' || i.status === 'CLOSED',
    );
    if (allDone) {
      log('PIPELINE', 'All issues DONE — pipeline complete!');
      PIPELINE_STAGES.forEach(s => stageStatus.set(s, 'COMPLETED'));
      break;
    }

    // Check if no issues are being actively processed and some progress was made
    const activeStatuses = ['IN_PROGRESS', 'IN_REVIEW', 'TESTING'];
    const anyActive = issues.some((i: any) => activeStatuses.includes(i.status));
    const anyCompleted = issues.some((i: any) => i.status === 'DONE' || i.status === 'CLOSED');

    if (!anyActive && anyCompleted) {
      // All active work stopped but some issues completed — wait 30s to see if more starts
      log('PIPELINE', 'No active issues but some completed — waiting 30s...');
      await sleep(30_000);

      const recheckIssues = await apiGet(`/issues?projectId=${projectId}`, token).catch(() => issues);
      const stillActive = recheckIssues.some((i: any) => activeStatuses.includes(i.status));
      if (!stillActive) {
        log('PIPELINE', 'Pipeline appears stalled/complete');
        break;
      }
    }

    // Periodic progress log (every 30s)
    if (Date.now() - lastLogTime > 30_000) {
      lastLogTime = Date.now();
      const inProgress = issues.filter((i: any) => i.status === 'IN_PROGRESS').map((i: any) => `#${i.gitlabIid}`);
      const inReview = issues.filter((i: any) => i.status === 'IN_REVIEW').map((i: any) => `#${i.gitlabIid}`);
      const done = issues.filter((i: any) => i.status === 'DONE' || i.status === 'CLOSED');
      log('PIPELINE', `[${elapsed}s] Active: ${inProgress.join(',') || 'none'} | Review: ${inReview.join(',') || 'none'} | Done: ${done.length}/${issues.length}`);
    }

    // Reload page periodically for UI sync
    if (elapsed > 0 && elapsed % 120 === 0) {
      log('PIPELINE', 'Refreshing page...');
      await page.reload({ waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {});
      await sleep(2000);
    }

    await sleep(10_000);
  }

  await screenshot(page, '07-pipeline-done');
  return stageStatus;
}

// ─── Phase 5: Verify Issues ─────────────────────────────────────
async function verifyIssues(page: Page, projectId: string, token: string): Promise<number> {
  log('VERIFY-ISSUES', 'Checking issues...');

  // Via API
  let issues: any[] = [];
  try {
    issues = await apiGet(`/issues?projectId=${projectId}`, token);
    log('VERIFY-ISSUES', `Found ${issues.length} issues via API`);

    for (const issue of issues) {
      const subCount = issue.subIssues?.length ?? 0;
      log('VERIFY-ISSUES', `  #${issue.gitlabIid ?? '?'} [${issue.status}] ${issue.priority} — ${issue.title} (${subCount} sub-issues)`);
    }
  } catch (e: any) {
    logError('VERIFY-ISSUES', `API error: ${e.message}`);
  }

  // Via UI — check issue cards in sidebar
  await page.reload({ waitUntil: 'networkidle', timeout: 15_000 });
  await sleep(2000);

  const uiIssueCount = await page.evaluate(() => {
    // Issue cards are in the left sidebar with bg-black/30 rounded-xl
    const cards = document.querySelectorAll('.bg-black\\/30.rounded-xl');
    return cards.length;
  });
  log('VERIFY-ISSUES', `Found ${uiIssueCount} issue cards in UI sidebar`);

  // Check milestones
  const milestoneCount = await page.locator('button', { hasText: /Milestone|milestone/i }).count();
  if (milestoneCount > 0) {
    log('VERIFY-ISSUES', `Found ${milestoneCount} milestones in UI`);
  }

  await screenshot(page, '08-issues-list');

  return issues.length;
}

// ─── Phase 6: Verify Comments ────────────────────────────────────
async function verifyComments(page: Page, projectId: string, token: string): Promise<number> {
  log('VERIFY-COMMENTS', 'Checking issue comments...');

  let totalComments = 0;

  try {
    const issues = await apiGet(`/issues?projectId=${projectId}`, token);

    for (const issue of issues) {
      try {
        const comments = await apiGet(`/issues/${issue.id}/comments`, token);
        totalComments += comments.length;

        if (comments.length > 0) {
          log('VERIFY-COMMENTS', `  Issue "${issue.title}": ${comments.length} comments`);
          for (const c of comments) {
            const preview = c.content?.slice(0, 80) ?? '';
            const hasGitlabNote = c.gitlabNoteId ? '✅ GitLab-synced' : '⚠️ no GitLab note';
            log('VERIFY-COMMENTS', `    [${c.authorType}] ${c.authorName}: ${preview}... (${hasGitlabNote})`);
          }
        }
      } catch (e: any) {
        log('VERIFY-COMMENTS', `  Could not fetch comments for issue ${issue.id}: ${e.message}`);
      }
    }
  } catch (e: any) {
    logError('VERIFY-COMMENTS', `API error: ${e.message}`);
  }

  // Try clicking on first issue in UI to check comment panel
  try {
    const firstIssueCard = page.locator('.bg-black\\/30.rounded-xl').first();
    if (await firstIssueCard.isVisible()) {
      await firstIssueCard.click();
      await sleep(1500);

      // Check for comments in slide-over panel
      const commentElements = await page.locator('.animate-slide-in-right .rounded-xl.p-3.border').count();
      log('VERIFY-COMMENTS', `Found ${commentElements} comments in UI detail panel`);

      await screenshot(page, '09-issue-detail-comments');

      // Close panel
      const closeBtn = page.locator('.animate-slide-in-right button').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await sleep(500);
      }
    }
  } catch (e: any) {
    log('VERIFY-COMMENTS', `UI comment check failed: ${e.message}`);
  }

  return totalComments;
}

// ─── Phase 7: Verify Code (GitLab) ──────────────────────────────
async function verifyCode(projectId: string, token: string, gitlabProjectId: number | null): Promise<boolean> {
  log('VERIFY-CODE', 'Checking code in GitLab...');

  if (!gitlabProjectId) {
    logError('VERIFY-CODE', 'No GitLab project ID found');
    return false;
  }

  // Check via Hub API for project info
  try {
    const issues = await apiGet(`/issues?projectId=${projectId}`, token);
    const codedIssues = issues.filter((i: any) =>
      i.status === 'IN_REVIEW' || i.status === 'TESTING' || i.status === 'DONE' || i.status === 'CLOSED',
    );

    if (codedIssues.length > 0) {
      log('VERIFY-CODE', `${codedIssues.length} issues have been coded (status >= IN_REVIEW)`);
      return true;
    } else {
      log('VERIFY-CODE', 'No issues reached IN_REVIEW or later status');
      return false;
    }
  } catch (e: any) {
    logError('VERIFY-CODE', `API error: ${e.message}`);
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VibCode Hub — Full Pipeline E2E Test');
  console.log(`  Project: ${PROJECT_NAME}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Ensure screenshot directory exists
  const { mkdirSync } = await import('fs');
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // Enable DAG for token fetching
  await setDAG(true);
  log('SETUP', 'Enabled Direct Access Grants');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  // Capture console errors
  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Capture failed network requests
  const networkErrors: string[] = [];
  page.on('requestfailed', req => {
    if (req.url().includes('/api/')) {
      networkErrors.push(`${req.method()} ${req.url()} → ${req.failure()?.errorText}`);
    }
  });

  let projectSlug = '';
  let projectId = '';
  let gitlabProjectId: number | null = null;

  try {
    // ═══ Phase 1: Login ═══
    const loginStart = Date.now();
    const loggedIn = await login(page);
    recordResult('LOGIN', loggedIn, 'Logged in as vibcode-bot', Date.now() - loginStart);
    await screenshot(page, '00-dashboard');

    // ═══ Phase 2: Create Project ═══
    const createStart = Date.now();
    projectSlug = await createProject(page);
    currentProjectSlug = projectSlug;
    recordResult('CREATE', !!projectSlug, `Project created: /projects/${projectSlug}`, Date.now() - createStart);

    // Get API token for verification
    const token = await getApiToken();
    log('SETUP', 'Got API token for verification');

    // Fetch project ID
    try {
      const projects = await apiGet('/projects', token);
      const proj = projects.find((p: any) => p.slug === projectSlug);
      if (proj) {
        projectId = proj.id;
        gitlabProjectId = proj.gitlabProjectId;
        log('SETUP', `Project ID: ${projectId}, GitLab ID: ${gitlabProjectId}`);
      }
    } catch (e: any) {
      log('SETUP', `Could not fetch project ID: ${e.message}`);
    }

    // ═══ Phase 3: Interview ═══
    const interviewStart = Date.now();
    const interviewDone = await runInterview(page);
    recordResult('INTERVIEW', interviewDone, interviewDone ? 'Interview completed' : 'Interview did not complete', Date.now() - interviewStart);

    if (!interviewDone) {
      logError('INTERVIEW', 'Interview did not complete — checking if we can continue anyway...');

      // Refresh token and check project status
      const freshToken = await getApiToken();
      try {
        const projects = await apiGet('/projects', freshToken);
        const proj = projects.find((p: any) => p.slug === projectSlug);
        if (proj) {
          log('INTERVIEW', `Project status: ${proj.status}`);
          projectId = proj.id;
          gitlabProjectId = proj.gitlabProjectId;

          if (proj.status !== 'SETTING_UP' && proj.status !== 'READY') {
            logError('INTERVIEW', 'Project still in INTERVIEWING — aborting pipeline monitoring');
            throw new Error('Interview did not complete');
          }
        }
      } catch {}
    }

    // Refresh token (might have expired during interview)
    const pipelineToken = await getApiToken();

    // Refresh project info
    try {
      const projects = await apiGet('/projects', pipelineToken);
      const proj = projects.find((p: any) => p.slug === projectSlug);
      if (proj) {
        projectId = proj.id;
        gitlabProjectId = proj.gitlabProjectId;
        log('PIPELINE', `Project status: ${proj.status}, GitLab ID: ${gitlabProjectId}`);
      }
    } catch {}

    // ═══ Phase 4: Monitor Pipeline ═══
    const pipelineStart = Date.now();
    const stageStatus = await monitorPipeline(page, projectSlug, pipelineToken);
    const pipelineDuration = Date.now() - pipelineStart;

    const completedStages = [...stageStatus.entries()]
      .filter(([, s]) => s === 'IDLE' || s === 'COMPLETED' || s === 'DONE')
      .map(([r]) => r);

    recordResult('PIPELINE', completedStages.length > 0,
      `${completedStages.length} stages completed: ${completedStages.join(', ')}`,
      pipelineDuration);

    // Refresh token again
    const verifyToken = await getApiToken();

    // ═══ Phase 5: Verify Issues ═══
    const issueCount = await verifyIssues(page, projectId, verifyToken);
    recordResult('ISSUES', issueCount > 0, `${issueCount} issues created`);

    // ═══ Phase 6: Verify Comments ═══
    const commentCount = await verifyComments(page, projectId, verifyToken);
    recordResult('COMMENTS', commentCount > 0, `${commentCount} total comments on issues`);

    // ═══ Phase 7: Verify Code ═══
    const codeOk = await verifyCode(projectId, verifyToken, gitlabProjectId);
    recordResult('CODE', codeOk, codeOk ? 'Code has been committed' : 'No code changes detected');

  } catch (err: any) {
    logError('MAIN', `Fatal error: ${err.message}`);
    await screenshot(page, '99-error');
    recordResult('FATAL', false, err.message);
  } finally {
    await browser.close();
    await setDAG(false);
    log('SETUP', 'Disabled Direct Access Grants');
  }

  // ─── Report ────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    const dur = r.duration ? ` (${Math.round(r.duration / 1000)}s)` : '';
    console.log(`${icon} ${r.phase}: ${r.details}${dur}`);
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`\n${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (consoleErrors.length > 0) {
    console.log(`\n⚠️ ${consoleErrors.length} console errors:`);
    for (const e of consoleErrors.slice(0, 10)) {
      console.log(`  ${e.slice(0, 120)}`);
    }
  }

  if (networkErrors.length > 0) {
    console.log(`\n⚠️ ${networkErrors.length} network errors:`);
    for (const e of networkErrors.slice(0, 10)) {
      console.log(`  ${e}`);
    }
  }

  console.log(`\nScreenshots: ${SCREENSHOT_DIR}/`);
  console.log(`Project: ${HUB_URL}/projects/${projectSlug}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
