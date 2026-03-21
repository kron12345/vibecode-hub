# VibCode Hub -- Usage Guide

> This guide explains how to use VibCode Hub from a user's perspective.
> It assumes the system is already installed and running.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Your First Project](#creating-your-first-project)
3. [Understanding the Pipeline](#understanding-the-pipeline)
4. [Working with Dev Sessions](#working-with-dev-sessions)
5. [The Chat Interface](#the-chat-interface)
6. [Managing Issues](#managing-issues)
7. [Settings](#settings)
8. [Live Feed](#live-feed)
9. [Tips and Best Practices](#tips-and-best-practices)
10. [Troubleshooting](#troubleshooting)

---

## Getting Started

### First Login

VibCode Hub uses Keycloak Single Sign-On (SSO) for authentication. When you open the
application in your browser, you will be redirected to the Keycloak login page.

1. Navigate to `https://hub.example.com` (or your configured domain).
2. You will be redirected to the SSO login screen.
3. Enter your username and password.
4. After successful login, you are redirected back to the VibCode Hub dashboard.

Your user role determines what you can access:

| Role             | Access Level                                              |
|------------------|-----------------------------------------------------------|
| **admin**        | Full access: all settings, system configuration, agents   |
| **project-manager** | Create/manage projects, configure project-level overrides |
| **developer**    | Work with existing projects, view issues and chats        |
| **viewer**       | Read-only access to projects and dashboards               |

### Dashboard Overview

The dashboard is the first thing you see after login. It is divided into several areas:

- **Sidebar** (left) -- Navigation links to all pages: Dashboard, Projects, Agents,
  Live Feed, and Settings. You can collapse the sidebar by clicking the toggle button
  at the top.

- **Hardware Monitor** (top) -- Real-time GPU, CPU, and RAM usage of the server. This
  updates every 3 seconds and shows sparkline charts for recent history.

- **Agent Pipeline** -- A summary row showing the current status of all 10 AI agent
  roles across your projects. Each role lights up when it is actively working.

- **Project Grid** -- Cards for each of your projects. Each card shows the project
  name, description, status, and a progress indicator. Click a card to open
  the project detail page. Click "Details" to jump directly into it.

- **New Project Button** -- A card with a "+" icon that opens the project creation
  dialog.

- **Recent Activity** -- A timeline of the latest agent actions, chat messages,
  and issue updates across all projects.

---

## Creating Your First Project

### Step 1: Click "New Project"

On the dashboard, click the "New Project" card. A dialog appears with a single
field: the project name. Enter a descriptive name (for example, "Recipe Manager"
or "Portfolio Website") and click "Start Interview".

Behind the scenes, this creates the project in the database and in GitLab, then
immediately starts the AI Interviewer agent.

### Step 2: The Interview Phase

After clicking "Start Interview", you are taken to the project page where the
Interviewer agent begins asking you questions in the chat. This is an interactive
conversation where the AI gathers the information it needs to set up your project.

The Interviewer will ask about:

- **Tech Stack** -- What framework do you want? (Angular, React, Vue, Vaadin, etc.)
  What programming language? What backend framework? What database?
- **Features** -- What should the application do? The Interviewer will ask you to
  describe the main features and will classify them by priority (must-have,
  should-have, nice-to-have).
- **Deployment** -- Is this a web project? What port should the dev server use?
  What are the build and start commands?
- **Setup Instructions** -- Any special initialization commands needed?
  (e.g., `npx create-next-app`, `npm init`, `mvn archetype:generate`)

During the interview, a **Requirements Card** appears at the top of the chat showing
what the Interviewer has gathered so far. You can see the framework, language, backend,
database, and feature list filling in as the conversation progresses. When all the
required information is gathered, the card shows a green "Ready" badge.

**Tips for the interview:**

- Be specific. "I want a todo app with Angular and NestJS backend using PostgreSQL"
  gives the agent much more to work with than "I want a website".
- You can correct the agent at any time. If it misunderstands something, just say so.
- The agent may suggest technologies or approaches. You can accept or override them.
- Suggestion chips may appear below the chat -- click them for quick responses.

### Step 3: What Happens After the Interview

Once the Interviewer has enough information, two things happen automatically:

1. **DevOps Agent** takes over. It clones the GitLab repository, runs the
   initialization commands (e.g., `npx create-angular-app`), generates configuration
   files (`.gitlab-ci.yml`, `.gitignore`, `.mcp.json`), creates initial documentation
   (`README.md`, `CHANGELOG.md`, `ENVIRONMENT.md`, `PROJECT_KNOWLEDGE.md`),
   sets up the GitLab Wiki, and pushes everything to the repository.

2. **Project status changes to READY.** The project is now fully set up and the
   Infrastructure Chat enters "YOLO mode" (more on that below).

The DevOps setup is fully automatic. You will see progress messages in the chat as
each step completes. This typically takes 1-3 minutes depending on the project size
and initialization commands.

---

## Understanding the Pipeline

VibCode Hub uses a pipeline of 10 specialized AI agents. Each agent has a specific
role and is color-coded throughout the interface.

### The 10 Agent Roles

| #  | Agent              | Color   | What It Does                                                |
|----|--------------------|---------|-------------------------------------------------------------|
| 1  | **Interviewer**    | Sky     | Gathers requirements through an interactive chat conversation. Asks about tech stack, features, deployment, and setup preferences. |
| 2  | **DevOps**         | Orange  | Sets up the project repository, generates CI/CD configuration, creates initial documentation, and manages infrastructure commands. |
| 3  | **Architect**      | Violet  | Designs the technical architecture. In Phase A, it creates an overall design. In Phase B, it "grounds" each issue by analyzing existing code and specifying which files to create or modify. |
| 4  | **Issue Compiler** | Amber   | Takes the feature list from the interview and converts it into structured GitLab issues with sub-tasks, priorities, labels, and milestones. |
| 5  | **Coder**          | Indigo  | Implements the actual code. Reads and writes files using MCP tools, creates commits, and pushes to the repository. Works on one issue at a time. |
| 6  | **Code Reviewer**  | Emerald | Reviews merge requests for code quality, security issues, and adherence to best practices. Approves good code or requests changes with specific fix instructions. |
| 7  | **Functional Tester** | Teal | Verifies that the code meets the acceptance criteria defined in the issue. Can run builds and tests in the workspace. |
| 8  | **UI Tester**      | Pink    | Checks user interface quality: layout, responsiveness, accessibility (WCAG 2.1 AA), and visual correctness. Can take screenshots via Playwright for visual analysis. |
| 9  | **Pen Tester**     | Red     | Performs security analysis: OWASP Top 10 checks, dependency audits (npm audit, Trivy, Semgrep), and identifies vulnerabilities. |
| 10 | **Documenter**     | Cyan    | Generates and updates documentation: README, API docs, changelogs, and project knowledge base. Syncs everything to the GitLab Wiki. |

### Pipeline Flow

The pipeline works differently depending on the context:

**Infrastructure Chat (project setup):**

```
Interview --> DevOps Setup --> STOP (project is READY)
                                |
                                v
                    YOLO Mode: user sends commands,
                    DevOps executes them via MCP tools
```

**Dev Session (feature development -- simplified session pipeline):**

```
Feature Interview --> Architect (Design)
                        |
                        v
                   Issue Compiler (creates issues)
                        |
                        v
                   Architect (Grounding -- annotates each issue)
                        |
                        v
                   Coder (implements each issue sequentially)
                        |
                        v
                      DONE (session can be archived/merged)
```

**Full Pipeline (for issues outside dev sessions):**

```
Coder --> Code Reviewer
              |
         APPROVED?
        /         \
      yes          no --> Coder (fix based on review feedback)
       |
       v
  Functional Tester
       |
     PASS?
    /      \
  yes       no --> Coder (fix based on test feedback)
   |
   v
  UI Tester
   |
 PASS?
  /     \
yes      no --> Coder (fix based on UI feedback)
 |
 v
Pen Tester
 |
PASS?
 /     \
yes     no --> Coder (fix based on security feedback)
 |
 v
Documenter --> Issue marked DONE
```

### What PASS and FAIL Mean

At each testing stage, the agent produces a verdict:

- **PASS / APPROVED** -- The code meets the criteria. The pipeline moves forward to
  the next agent.
- **FAIL / CHANGES REQUESTED** -- The agent found problems. It writes specific
  findings with fix instructions, and the Coder agent is automatically triggered
  to fix the issues. This creates a "fix loop".

### Fix Loops

When a test fails, the Coder receives the specific findings and fix instructions
from the testing agent. It then modifies the code and pushes a new version. The
testing agent runs again on the updated code. This loop continues until:

- The test passes, OR
- The maximum number of fix attempts is reached (configurable, default: 5).

If the maximum is reached, the issue is marked as **NEEDS_REVIEW** -- meaning it
requires manual human intervention. You will see this as a red status label on the
issue.

### Loop Resolver

If the pipeline detects that an issue is stuck in a fix loop (same findings keep
appearing), the Loop Resolver kicks in automatically. It analyzes the root cause
and can take corrective actions such as clarifying the issue description or
declassifying false-positive findings. This appears as a "RESOLVE_LOOP" task in
the pipeline.

---

## Working with Dev Sessions

Dev Sessions are how you develop new features for a project that has already been
set up.

### Infrastructure vs Dev Sessions

VibCode Hub uses two types of chat sessions:

| Type               | Purpose                                      | Git Branch         |
|--------------------|----------------------------------------------|--------------------|
| **Infrastructure** | Project setup, configuration, infra commands | Main/work branch   |
| **Dev Session**    | Feature development (own isolated workspace) | Dedicated session branch |

- There is exactly **one Infrastructure session** per project. It is created during
  the initial interview and stays available permanently.
- You can create **multiple Dev Sessions**, each for a different feature or set of
  features. Each one gets its own Git branch and isolated workspace (via git worktrees).

### Creating a Dev Session

1. Open your project page.
2. In the chat panel, you will see the Session Navigator with three sections:
   **Infrastructure**, **Dev Sessions**, and **Archive**.
3. Click the **"+"** button next to "Dev Sessions".
4. Enter a session name (e.g., "User Authentication") and optionally customize the
   branch name.
5. Click "Create".

The system will:
- Create a new Git branch from your work branch.
- Set up an isolated workspace (git worktree) for this session.
- Start a **Feature Interview** -- the Interviewer asks about the specific features
  you want to build in this session.

After the Feature Interview, the pipeline runs automatically:
Architect designs the architecture, Issue Compiler creates issues, Architect grounds
each issue, and the Coder implements them one by one.

### Archiving Sessions (Merging Back)

When all issues in a Dev Session are complete, you can archive the session:

1. Open the Dev Session in the chat panel.
2. Click the **archive icon** in the session bar (top right of the chat).
3. Confirm the archive action.

Archiving a session:
- Merges the session branch back into the work branch.
- Removes the isolated worktree.
- Moves the session to the Archive section.

If there are merge conflicts, the session status changes to **CONFLICT**. You can
resolve conflicts manually in Git and then click "Resolve" in the UI to retry the
merge.

### Continuing an Archived Session

If you need to add more features to an archived session, you can continue it. Click
on an archived session and use the "Continue" option. This creates a new session
that picks up where the old one left off.

---

## The Chat Interface

The chat is the primary way you interact with VibCode Hub. It is styled as a
terminal with a monospace font and a command prompt (`>`).

### Message Types

Messages in the chat are color-coded:

| Color         | Sender     | Description                              |
|---------------|------------|------------------------------------------|
| White         | **You**    | Your messages, preceded by a `>` prompt  |
| Indigo/Blue   | Assistant  | Direct AI responses                      |
| Green         | Agent      | Agent status updates and results         |
| Gray (italic) | System     | System notifications and status changes  |

### Infrastructure Chat (YOLO Mode)

After the initial project setup is complete, the Infrastructure Chat enters
"YOLO mode". This means you can ask the DevOps agent to perform infrastructure
tasks directly:

- "Install tailwind and configure it"
- "Add a PostgreSQL database connection"
- "Update all npm dependencies"
- "Fix the build error in the CI pipeline"
- "Add a docker-compose.yml for local development"

The DevOps agent has access to the project filesystem, shell commands, and Git.
It will execute the requested changes and update the project's `ENVIRONMENT.md`
accordingly.

### Dev Session Chat

In a Dev Session, the chat follows a structured flow:

1. **Feature Interview** -- The Interviewer asks about the features you want.
   Answer its questions until it has enough information.
2. **Automatic Pipeline** -- After the interview, agents take over automatically.
   You can watch the progress in the chat and the pipeline visualization above.
3. **Results** -- Each agent posts status updates in the chat. Issues are created
   and tracked in the issue board on the left.

You do not need to interact during the automatic pipeline phase -- the agents
work autonomously. However, you can always send messages, and they will be
processed at the appropriate point.

### Voice Chat

If Speech-to-Text (STT) and Text-to-Speech (TTS) services are configured, you
can use voice chat:

1. Click the **microphone icon** in the chat input bar to enter voice mode.
2. A full-screen overlay appears with a large microphone indicator.
3. **Speak** -- your voice is transcribed in real-time.
4. The transcript is sent as a text message through the normal chat flow.
5. The agent's response is automatically spoken back to you via TTS.
6. Click the **X** or the stop button to exit voice mode.

Voice mode requires the STT and TTS services to be running (configured in
Settings under the Voice section).

### File Uploads

You can attach files to your chat messages by clicking the **paperclip icon**
next to the input field. Supported file types:

- Documents: `.pdf`, `.txt`, `.md`
- Images: `.png`, `.jpg`, `.jpeg`, `.webp`

This is useful for sharing mockups, specifications, or reference documents
with the AI agents.

---

## Managing Issues

### The Issue Board

On the project page, the left panel shows the **Issue Board**. Issues are grouped
by milestones (created automatically by the Issue Compiler agent).

Each issue card shows:
- **Priority** -- Color-coded label (CRITICAL = red, HIGH = orange, MEDIUM = blue,
  LOW = gray).
- **Title** -- Short description of what needs to be done.
- **Status** -- Current pipeline stage shown as text and progress dots.
- **Sub-tasks** -- A count of completed sub-tasks (e.g., "3/5 tasks done").

Click on a milestone header to expand or collapse its issues.

### Issue Statuses

Issues move through the following statuses as the pipeline processes them:

| Status          | Meaning                                                       |
|-----------------|---------------------------------------------------------------|
| **OPEN**        | Issue is created but no agent has started working on it yet.  |
| **IN_PROGRESS** | The Coder agent is actively working on this issue.            |
| **IN_REVIEW**   | Code is written and the Code Reviewer is checking it.         |
| **TESTING**     | Code passed review and is being tested (Functional, UI, Pen). |
| **DONE**        | All pipeline stages passed. Documentation is complete.        |
| **NEEDS_REVIEW**| Max fix attempts reached. Manual intervention is needed.      |
| **CLOSED**      | Issue is closed (manually or after completion).               |

These statuses are also synced as colored labels to GitLab, so you can see
them in both places.

### Issue Detail Panel

Click on any issue card to open the **Issue Detail Panel** -- a slide-over panel
on the right side that shows:

- **Description** -- The full issue description (in Markdown).
- **Metadata** -- Priority, status, assigned agent, Git branch, merge request link.
- **Sub-tasks** -- List of sub-tasks with their completion status.
- **Comments** -- A timeline of comments from all agents that worked on this issue.
  This includes architect grounding notes, code reviewer findings, test results,
  and documentation summaries.

You can also **add your own comments** to an issue. User comments on issues that
are DONE, IN_REVIEW, or TESTING will automatically trigger the Coder agent to
address your feedback.

### GitLab Integration

Every issue in VibCode Hub is mirrored to GitLab. You can:

- View issues in GitLab with the same titles, descriptions, and labels.
- See merge requests created by the Coder agent.
- View CI/CD pipeline results.
- Access the project wiki with auto-generated documentation.

The GitLab link is shown in the project header. Click "GitLab" to open the
repository directly.

---

## Settings

Access settings from the sidebar (gear icon at the bottom) or navigate to `/settings`.

### User Settings

Available to all users. Contains:

- **Language** -- Choose your preferred language: English, German, Italian, or French.
  The entire interface is translated.
- **Theme** -- Switch between **Dark** mode (deep slate with glass morphism and
  neon accents) and **Light** mode (frosted glass with a mesh background). The
  preview updates immediately when you select a theme.
- **Sidebar Collapsed** -- Toggle whether the sidebar starts collapsed (icon-only)
  or expanded (with labels).

### System Settings (Admin Only)

Visible only to users with the admin role. Contains grouped configuration cards:

- **GitLab** -- GitLab server URL, API token, and webhook secret. The API token and
  webhook secret are stored encrypted (AES-256-GCM) and displayed as masked values.
- **LLM Providers** -- API keys for cloud AI providers:
  - Ollama URL (for local models)
  - Anthropic API key (Claude)
  - OpenAI API key (GPT)
  - Google AI API key (Gemini)
- **CORS Origins** -- Allowed origins for cross-origin requests.
- **Voice** -- STT and TTS service configuration:
  - Enable/disable voice features
  - STT server URL and model
  - TTS server URL, voice preset, and speed
  - Health check button to verify services are running

### Agent Roles (Admin Only)

This is where you configure how each of the 10 agent roles behaves. For each role
you can set:

- **Provider** -- Which AI engine to use. Options include:
  - *Ollama* (local GPU inference)
  - *Claude Code CLI*, *Codex CLI*, *Gemini CLI*, *Qwen3 Coder CLI* (command-line tools)
  - *Anthropic API*, *OpenAI API*, *Google AI API* (cloud APIs)
- **Model** -- Which specific model to use (e.g., `qwen3.5:32b`, `claude-sonnet-4-6`,
  `gpt-4o`, `gemini-3.1-pro-preview`). The available models are auto-discovered
  from each provider.
- **Temperature** -- Controls creativity. Lower values (0.1-0.3) produce more
  focused output, higher values (0.7-1.0) produce more varied output.
- **Max Tokens** -- Maximum length of the AI response.
- **Permissions** -- Toggle what the agent is allowed to do:
  - File Read / File Write
  - Terminal access
  - Package installation
  - HTTP requests
  - Git operations
- **Dual Testing** -- For testing agents, you can configure a second provider/model
  that runs in parallel. Results can be merged, compared via consensus, or enriched.

**Presets** -- At the top of the Agent Roles tab, you can apply presets:
- **Local** -- Configures all agents to use Ollama with local models.
- **CLI** -- Configures agents to use cloud CLI tools (Claude Code, Codex, Gemini).

### Pipeline Configuration (Admin Only)

Also found in the Agent Roles tab, the pipeline configuration controls global
pipeline behavior:

| Setting                    | Description                                            | Default |
|----------------------------|--------------------------------------------------------|---------|
| Pipeline Enabled           | Master switch to enable/disable the agent pipeline     | true    |
| Auto Start                 | Automatically start pipeline when issues are created   | true    |
| Require Approval           | Require human approval at each pipeline step           | false   |
| Max Concurrent Agents      | How many agents can work in parallel                   | 1       |
| Max Fix Attempts           | How many times the Coder retries before NEEDS_REVIEW   | 5       |
| Max Parallel Ollama Models | How many Ollama models can be loaded in VRAM at once   | 1       |
| MCP Max Iterations         | Maximum tool-call loops per agent task                 | 30      |
| CLI Timeout (minutes)      | Timeout for CLI-based providers                        | 90      |
| Stuck Timeout (minutes)    | Inactivity timeout before a task is considered stuck   | 30      |
| Loop Resolver Enabled      | Enable the automatic fix-loop resolver                 | true    |
| Loop Resolver Threshold    | After how many fix attempts the resolver kicks in      | 3       |

### MCP Servers (Admin Only)

MCP (Model Context Protocol) servers give agents access to tools like file systems,
shell commands, Git, databases, and more. The MCP section in Agent Roles shows:

- **Built-in Servers** -- Pre-configured servers that cannot be deleted: filesystem,
  git, gitlab, shell, playwright, eslint, security-audit, postgres, docker,
  sequential-thinking, angular-cli, prisma, vaadin, spring-docs, memory, searxng.
- **Custom Servers** -- You can register additional MCP servers.
- **Role Assignments** -- For each MCP server, you can configure which agent roles
  have access to it.
- **Project Overrides** -- On individual project settings pages, you can enable
  or disable specific MCP servers per agent role, overriding the global configuration.

---

## Live Feed

Access the Live Feed from the sidebar (Activity icon) or navigate to `/live-feed`.

The Live Feed provides real-time monitoring of everything happening in VibCode Hub.

### Hardware Monitor

At the top, a horizontal hardware monitor shows:

- **GPU Stats** -- For each GPU: temperature, utilization percentage, memory usage,
  power draw, and clock speeds. Sparkline charts show recent trends.
- **CPU Stats** -- Temperature and load averages (1, 5, and 15 minute).
- **RAM Stats** -- Total, used, and available memory with usage percentage.

All values update every 3 seconds via WebSocket.

### Activity Stream

Below the hardware monitor, a chronological timeline shows all system activity:

- Agent task starts and completions
- Chat messages
- Issue status changes
- Agent comments and findings
- LLM calls (provider, model, duration)

### Filters

You can filter the activity stream by:

- **Project** -- Show activity for a specific project only.
- **Agent Role** -- Show activity from a specific agent (e.g., only Coder events).
- **Log Level** -- Filter by severity: DEBUG, INFO, WARN, ERROR.

### Agents Overview

Navigate to `/agents` from the sidebar to see an overview of all 10 agent roles:

- **Summary Stats** -- Total roles, currently working agents, total completed tasks.
- **Pipeline Flow** -- A visual pipeline diagram showing all agent roles in order.
- **Role Cards** -- For each role: current status, provider/model configuration,
  number of completed tasks, and active projects.

---

## Tips and Best Practices

### Start With a Clear Description

The more specific you are during the interview, the better the results. Tell the
Interviewer exactly what framework, language, and features you want. Vague
descriptions lead to vague implementations.

### Use Infrastructure Chat Before Dev Sessions

Before creating Dev Sessions to build features, use the Infrastructure Chat to
set up your project properly:

- Install additional dependencies
- Configure environment variables
- Set up database connections
- Fix any build issues from the initial setup

The DevOps agent in YOLO mode can handle all of these tasks.

### Monitor the Pipeline

Keep an eye on the pipeline visualization at the top of the project page. Each
agent card lights up and elevates when it is actively working. A pulsing connection
line indicates the pipeline is running.

### Understanding the Failure Banner

If a pipeline task fails (e.g., a CLI tool times out or an LLM provider errors),
you will see a **red failure banner** at the top of the pipeline view. It shows:

- Which task failed
- The failure reason
- When it failed
- A **"Resume Pipeline"** button

To recover: fix the underlying problem (e.g., restart a service, check API keys)
and click "Resume Pipeline". The pipeline will restart from the failed task.

### NEEDS_REVIEW Means Manual Intervention

When an issue reaches the status NEEDS_REVIEW, it means the Coder agent has
exhausted its maximum fix attempts. The testing agents keep finding issues that
the Coder cannot resolve automatically.

What to do:
1. Open the issue detail panel and read the agent comments.
2. Look at the latest test findings to understand what is failing.
3. You can fix the code manually in GitLab or your local editor.
4. Post a comment on the issue to re-trigger the Coder with your guidance.

### Work Branch Strategy

Each project can have a **work branch** (e.g., `develop`). When set:

- Feature branches are created from the work branch.
- Merge requests target the work branch.
- Dev session branches are created from the work branch.
- You decide manually when to merge the work branch into `main`.

This is configured in the project settings tab.

### Preview URLs

If your project is a web application, it automatically gets a preview subdomain
after setup. For example, a project with the slug `recipe-app` would be available
at `https://recipe-app.hub.example.com`. The preview link appears in the project
header as a green "Open Preview" button.

### GitLab Wiki

Every project gets an automatically maintained GitLab Wiki that serves as the
project's knowledge base. The wiki contains:

- **Home** -- Project overview with quick links
- **PROJECT_KNOWLEDGE** -- Accumulated technical knowledge (patterns, conventions)
- **ENVIRONMENT** -- Tech stack, dependencies, ports, and tools
- **Architecture/Overview** -- System architecture documentation
- **Features/** -- Per-feature documentation pages
- **UI-Screenshots/** -- Visual documentation with annotated screenshots

The wiki is updated automatically by the DevOps and Documenter agents. You can
also read and edit it directly in GitLab.

---

## Troubleshooting

### Pipeline is Stuck

If the pipeline seems to be stuck (an agent card has been lit up for a very long
time with no new chat messages):

1. Check the Live Feed for recent activity on your project.
2. The system has an automatic stuck-task detector that runs every 5 minutes. If a
   task shows no activity for the configured timeout (default: 30 minutes), it is
   automatically cleaned up and the issue is reset to OPEN.
3. If automatic cleanup does not trigger, check if the LLM provider is responsive
   (Ollama running, API keys valid, CLI tools installed).

### Agent Keeps Failing on the Same Issue

If an agent repeatedly fails on the same issue:

1. Read the agent comments on the issue to understand the pattern.
2. The Loop Resolver should activate automatically after 3 fix attempts (configurable).
3. If the issue reaches NEEDS_REVIEW, provide manual guidance via a comment.
4. Consider simplifying the issue description or breaking it into smaller issues.

### No Models Showing in Agent Roles

If the model dropdown is empty when configuring an agent role:

1. Go to Settings and verify the provider is properly configured:
   - **Ollama**: Check that the Ollama URL is correct and the service is running.
   - **Cloud APIs**: Check that the API key is entered and valid.
   - **CLI Tools**: Verify the CLI tools are installed on the server.
2. The model list is auto-discovered. Click outside and back into the dropdown, or
   refresh the page.

### Chat is Not Responding

If you send a message but get no response:

1. Check the pipeline failure banner -- there may be a failed task blocking progress.
2. Verify the correct session is selected (Infrastructure vs Dev Session).
3. Check that the project status is READY (for Infrastructure YOLO mode) or that
   you are in an ACTIVE Dev Session.
4. Look at the Live Feed for any error-level log entries.

### Voice Chat Not Working

If the microphone button does not appear or voice chat fails:

1. Verify voice is enabled in Settings (System tab, Voice section).
2. Click the health check button to test STT and TTS service connectivity.
3. Ensure your browser has microphone permission for the VibCode Hub domain.
4. Check that the STT service (port 8300) and TTS service (port 8301) are running.

### Session Merge Conflicts

If archiving a Dev Session results in a CONFLICT status:

1. The session branch has changes that conflict with the work branch.
2. Resolve the conflicts manually using Git (in the workspace or via GitLab).
3. Return to VibCode Hub and click "Resolve" on the session to retry the merge.

---

## Glossary

| Term                | Definition                                                     |
|---------------------|----------------------------------------------------------------|
| **Agent**           | An AI-powered worker with a specific role in the pipeline      |
| **Dev Session**     | An isolated workspace for developing a set of features         |
| **Fix Loop**        | The cycle of test failure and code fix between testing agents and the Coder |
| **Infrastructure Chat** | The permanent chat session for project setup and admin commands |
| **Issue**           | A unit of work (feature, bug fix, task) tracked in GitLab      |
| **MCP**             | Model Context Protocol -- gives AI agents access to tools      |
| **Milestone**       | A group of related issues, often representing a feature area   |
| **NEEDS_REVIEW**    | Status indicating the pipeline could not resolve an issue automatically |
| **Pipeline**        | The sequence of agent steps that process each issue            |
| **Sub-task**        | A smaller work item nested under a parent issue                |
| **Work Branch**     | The target branch for feature merges (e.g., `develop`)         |
| **Worktree**        | An isolated Git working copy used by Dev Sessions              |
| **YOLO Mode**       | Infrastructure Chat mode where DevOps executes commands directly |
