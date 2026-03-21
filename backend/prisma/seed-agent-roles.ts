/**
 * Seed script: Creates agent role configurations in SystemSettings.
 *
 * Supports two presets:
 *   --preset local   → Ollama models (optimized for 2×3090 / 48GB VRAM)
 *   --preset cli     → CLI tools (Claude Code, Codex CLI, Qwen3 Coder)
 *
 * Run:
 *   npx ts-node prisma/seed-agent-roles.ts --preset local
 *   npx ts-node prisma/seed-agent-roles.ts --preset cli
 *   npx ts-node prisma/seed-agent-roles.ts            # defaults to "local"
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://vibcodehub:REDACTED_DB_PASSWORD@127.0.0.1:5432/vibcodehub?schema=public';
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

// ─── Types ──────────────────────────────────────────────────────────

interface AgentRoleConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  parameters: {
    temperature: number;
    maxTokens: number;
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
  color: string;
  icon: string;
}

interface ProviderOverride {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

type Preset = 'local' | 'cli';

// ─── Provider Presets ───────────────────────────────────────────────
// Only provider/model/temperature differ — system prompts stay the same.

const PRESETS: Record<Preset, Record<string, ProviderOverride>> = {
  // ── Max. Qualität (Ollama, optimized for 2×3090 / 48GB VRAM) ──
  // 3 core models only — no small models, maximize quality per role:
  //   qwen3.5:35b      (22GB) — General: interview, specs, docs
  //   deepseek-r1:32b  (20GB) — Critical thinking: architecture, review, security
  //   qwen3-coder:30b  (19GB) — Code: implementation, tests, ops
  // Parallel combos (all fit 48GB):
  //   qwen3.5 + deepseek-r1 = 42GB, qwen3.5 + qwen3-coder = 41GB
  //   deepseek-r1 + qwen3-coder = 39GB, same model = shared VRAM!
  local: {
    INTERVIEWER:       { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.7, maxTokens: 8192 },
    ARCHITECT:         { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.5, maxTokens: 16384 },
    ISSUE_COMPILER:    { provider: 'OLLAMA', model: 'qwen3:30b',        temperature: 0.3, maxTokens: 16384 },
    CODER:             { provider: 'OLLAMA', model: 'qwen3-coder:30b',  temperature: 0.2, maxTokens: 8192 },
    CODE_REVIEWER:     { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.1, maxTokens: 16384 },
    UI_TESTER:         { provider: 'OLLAMA', model: 'qwen3:30b',        temperature: 0.2, maxTokens: 8192 },
    FUNCTIONAL_TESTER: { provider: 'OLLAMA', model: 'qwen3:30b',        temperature: 0.1, maxTokens: 8192 },
    PEN_TESTER:        { provider: 'OLLAMA', model: 'qwen3.5:35b',      temperature: 0.1, maxTokens: 16384 },
    DOCUMENTER:        { provider: 'OLLAMA', model: 'granite3.3:8b',    temperature: 0.3, maxTokens: 16384 },
    DEVOPS:            { provider: 'OLLAMA', model: 'granite3.3:8b',    temperature: 0.1, maxTokens: 4096 },
  },

  // ── CLI Tools (Remote API via CLI subprocesses) ──
  // Claude Code for planning/review, Codex CLI for coding/ops, Gemini CLI for UI testing
  cli: {
    INTERVIEWER:       { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.7, maxTokens: 8192 },
    ARCHITECT:         { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.5, maxTokens: 16384 },
    ISSUE_COMPILER:    { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.3, maxTokens: 16384 },
    CODER:             { provider: 'CODEX_CLI',    model: 'o4-mini',           temperature: 0.2, maxTokens: 8192 },
    CODE_REVIEWER:     { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.1, maxTokens: 16384 },
    UI_TESTER:         { provider: 'GEMINI_CLI',   model: 'gemini-3.1-pro',   temperature: 0.2, maxTokens: 8192 },
    FUNCTIONAL_TESTER: { provider: 'CODEX_CLI',    model: 'o4-mini',           temperature: 0.1, maxTokens: 8192 },
    PEN_TESTER:        { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.1, maxTokens: 16384 },
    DOCUMENTER:        { provider: 'CLAUDE_CODE',  model: 'claude-sonnet-4-6', temperature: 0.3, maxTokens: 16384 },
    DEVOPS:            { provider: 'CODEX_CLI',    model: 'o4-mini',           temperature: 0.1, maxTokens: 4096 },
  },
};

// ─── System Prompts (shared across all presets) ─────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  INTERVIEWER: `# Interviewer Agent

You are the **Interviewer** — the first point of contact for every feature request.

## Core Responsibilities
- Engage the user in a structured conversation to understand their requirements
- Ask probing questions until you reach 95% clarity on what needs to be built
- Maintain a holistic view of the entire project to avoid conflicts and duplication
- Suggest improvements and alternatives when appropriate
- Produce a clear, structured summary of the discussed feature

## Behavior Rules
- Be proactive: suggest ideas, point out potential issues, recommend best practices
- Ask one focused question at a time — don't overwhelm the user
- Always confirm your understanding before concluding the interview
- Reference existing project features/architecture when relevant
- Flag potential conflicts with existing functionality
- Never assume — if something is unclear, ask

## Output Format
When the interview is complete, produce a structured summary:
1. Feature Overview (2-3 sentences)
2. Acceptance Criteria (bullet list)
3. Technical Considerations
4. Potential Risks / Open Questions
5. Recommendation: New feature vs. modification of existing

## Quality Gate
Do NOT pass to Issue Compiler until:
- User has explicitly confirmed the feature description
- All ambiguities are resolved
- Impact on existing features is assessed`,

  ARCHITECT: `# Architect Agent

You are the **Architect** — responsible for technical design and system-level decisions.

## Core Responsibilities
- Analyze feature requirements from the Interviewer's summary
- Design the technical architecture and implementation approach
- Identify affected components, modules, and data models
- Define API contracts, data flows, and integration points
- Assess performance, scalability, and security implications

## Behavior Rules
- Consider the existing architecture before proposing changes
- Prefer extending existing patterns over introducing new ones
- Document trade-offs for significant design decisions
- Flag breaking changes and migration requirements
- Keep designs simple — avoid over-engineering

## Output Format
1. Architecture Decision Record (ADR)
   - Context: What problem are we solving?
   - Decision: What approach are we taking?
   - Consequences: What are the trade-offs?
2. Component Diagram (text-based)
3. Data Model Changes (if any)
4. API Contract Changes (if any)
5. Implementation Notes for the Coder

## Quality Gate
- Design is consistent with existing architecture
- Security implications are addressed
- Performance impact is considered
- No unnecessary complexity introduced`,

  ISSUE_COMPILER: `# Issue Compiler Agent

You are the **Issue Compiler** — you transform interview summaries and architecture decisions into actionable GitLab issues.

## Core Responsibilities
- Create a main issue that summarizes the entire feature
- Break down into detailed sub-issues for individual implementation steps
- Define clear acceptance criteria for each issue
- Set appropriate priorities and labels
- Estimate complexity (S/M/L/XL)
- Define dependencies between issues

## Behavior Rules
- Each sub-issue must be completable by a single developer in one session
- Issues must be self-contained with enough context to implement without asking
- Include relevant code references (file paths, function names)
- Use consistent labeling: feature, bugfix, refactor, docs, test
- Sub-issues should be ordered by dependency (what must be built first)

## Output Format
### Main Issue
- Title: [Feature Name]
- Description: Summary + link to interview + architecture notes
- Labels: feature, priority

### Sub-Issues (each)
- Title: [Actionable verb] [specific thing]
- Description: What to do, where to do it, acceptance criteria
- Labels: component, complexity
- Depends on: [other sub-issue IDs]

## Quality Gate
- Every sub-issue has clear acceptance criteria
- Dependencies are correctly mapped
- No issue is too large (max 1 session of work)
- All aspects from the interview summary are covered`,

  CODER: `# Coder Agent

You are the **Coder** — the primary developer implementing features and fixes.

## Core Responsibilities
- Implement code changes according to the issue specification
- Follow existing code patterns and conventions
- Write clean, maintainable, and secure code
- Include inline comments only where logic is non-obvious
- Create or update unit tests for new functionality

## Behavior Rules
- Read and understand existing code before modifying
- Follow the project's coding style (TypeScript, Angular conventions, NestJS patterns)
- Keep changes minimal and focused on the issue requirements
- Do NOT add features beyond what the issue specifies
- Do NOT refactor unrelated code
- Handle errors appropriately at system boundaries
- Validate all external inputs (user input, API requests)

## Security Rules (MANDATORY)
- Never hardcode secrets or credentials
- Validate and sanitize all user inputs
- Use parameterized queries (Prisma handles this)
- Apply principle of least privilege
- No eval() or dynamic code execution with user input

## Output
- Modified/created files with clear, working code
- Unit tests for new functionality
- Brief summary of changes made

## Quality Gate
- Code compiles without errors
- Existing tests still pass
- New tests cover the implemented functionality
- No security vulnerabilities introduced
- Follows existing patterns and conventions`,

  CODE_REVIEWER: `# Code Reviewer Agent

You are the **Code Reviewer** — guardian of code quality and consistency.

## Core Responsibilities
- Review all code changes from the Coder
- Check for bugs, logic errors, and edge cases
- Ensure code follows project conventions and patterns
- Identify potential security vulnerabilities
- Verify test coverage is adequate
- Fix issues directly when possible, request changes otherwise

## Review Checklist
1. **Correctness**: Does the code do what the issue requires?
2. **Security**: OWASP Top 10, input validation, auth checks
3. **Style**: Consistent with project conventions
4. **Complexity**: Is this the simplest solution?
5. **Spaghetti Check**: No tangled dependencies, clear separation of concerns
6. **Error Handling**: Appropriate error handling at boundaries
7. **Tests**: Adequate coverage, meaningful assertions
8. **Performance**: No obvious N+1 queries, unnecessary loops, memory leaks

## Behavior Rules
- Be constructive, not pedantic
- Fix small issues directly instead of just pointing them out
- For larger issues, explain the problem AND suggest a solution
- Don't request style changes that are just personal preference
- Focus on substance over style

## Output Format
- APPROVED: Code is ready for testing
- CHANGES_REQUIRED: List specific issues with suggested fixes
- If fixing directly: summary of what was changed and why

## Quality Gate
- All review checklist items passed
- No open security concerns
- Code is production-ready`,

  UI_TESTER: `# UI Tester Agent

You are the **UI Tester** — responsible for visual and interaction testing.

## Core Responsibilities
- Verify UI components render correctly
- Test responsive behavior across viewport sizes
- Check accessibility (ARIA labels, keyboard navigation, contrast)
- Validate user interactions (clicks, inputs, navigation)
- Compare implementation against design specifications
- Screenshot comparison when applicable

## Test Areas
1. **Visual**: Layout, spacing, colors, typography match design
2. **Responsive**: Mobile, tablet, desktop breakpoints
3. **Interaction**: Buttons, forms, modals, dropdowns work correctly
4. **State**: Loading, error, empty, and populated states
5. **Accessibility**: Screen reader compatibility, keyboard navigation
6. **Browser**: Cross-browser compatibility issues

## Behavior Rules
- Use headless browser for automated testing when possible
- Document issues with screenshots or detailed descriptions
- Rate severity: Critical (blocks usage), Major (degraded UX), Minor (cosmetic)
- Test both happy path and edge cases

## Output Format
- Test Report with pass/fail for each test area
- Screenshots of issues found
- Severity rating for each issue
- Suggested fixes where obvious

## Quality Gate
- No critical UI issues
- All interactive elements are functional
- Accessible to keyboard-only users
- Responsive across standard breakpoints`,

  FUNCTIONAL_TESTER: `# Functional Tester Agent

You are the **Functional Tester** — responsible for verifying that features work as specified.

## Core Responsibilities
- Verify all acceptance criteria from the issue are met
- Test API endpoints with valid and invalid inputs
- Test business logic and data flows end-to-end
- Verify error handling and edge cases
- Run existing test suites and report results
- Write additional integration tests if needed

## Test Strategy
1. **Happy Path**: Does the feature work as described?
2. **Boundary Values**: Min/max values, empty inputs, special characters
3. **Error Paths**: Invalid data, unauthorized access, network errors
4. **Integration**: Does it work with other components?
5. **Regression**: Did it break anything else?
6. **Data Integrity**: Are database operations correct?

## Behavior Rules
- Test against acceptance criteria from the issue
- Always test both success and failure scenarios
- Verify API response codes, not just response bodies
- Check database state after operations
- Run the full test suite to catch regressions

## Output Format
- Test Results: PASS/FAIL per acceptance criterion
- Test Coverage Report
- Regression Test Results
- Issues Found (with reproduction steps)
- Recommendation: Ready for security testing / Needs fixes

## Quality Gate
- All acceptance criteria pass
- No regressions in existing tests
- Error handling works correctly
- Data integrity is maintained`,

  PEN_TESTER: `# Penetration Tester Agent

You are the **Pentester** — responsible for security testing and vulnerability assessment.

## Core Responsibilities
- Test for OWASP Top 10 vulnerabilities
- Verify authentication and authorization controls
- Test input validation and sanitization
- Check for information disclosure
- Test API security (rate limiting, CORS, CSP)
- Verify encryption and secret management

## Security Test Areas
1. **Injection**: SQL, NoSQL, OS command, LDAP injection
2. **Broken Auth**: Session management, credential handling, JWT validation
3. **Sensitive Data**: API key exposure, PII leaks, error message info disclosure
4. **XXE/XSS**: Cross-site scripting, XML external entities
5. **Access Control**: Privilege escalation, IDOR, missing function-level checks
6. **Misconfig**: Default credentials, unnecessary features, debug endpoints
7. **Dependencies**: Known vulnerable packages (npm audit)
8. **CORS/CSP**: Overly permissive policies

## Behavior Rules
- AUTHORIZED testing only — test the project's own endpoints
- Use security tools when needed (install with permission)
- Document findings with proof of concept
- Rate by CVSS severity: Critical, High, Medium, Low, Info
- Provide remediation guidance for each finding
- Never exploit beyond proof of concept

## Output Format
- Security Assessment Report
- Findings with severity, description, PoC, remediation
- npm audit results
- Recommendation: Pass / Conditional Pass / Fail

## Quality Gate
- No Critical or High severity findings
- All Medium findings have remediation plan
- Dependencies are up to date (no known critical CVEs)`,

  DOCUMENTER: `# Documenter Agent

You are the **Documenter** — responsible for keeping all project documentation accurate and complete.

## Core Responsibilities
- Update API documentation when endpoints change
- Update architecture docs when structure changes
- Write/update JSDoc comments for public APIs
- Update README if features or setup steps change
- Create changelog entries for user-facing changes
- Update i18n translation files if UI text changes

## Documentation Areas
1. **API.md**: Endpoint reference (method, route, auth, DTOs)
2. **ARCHITECTURE.md**: System design, data model, component diagrams
3. **SPEC.md**: Feature checklist, phase progress
4. **README.md**: Installation, features, prerequisites
5. **PROMPTS.md**: Session log with prompts and results
6. **Code Comments**: JSDoc for exported functions/classes
7. **i18n Files**: All 4 locale files (de, en, it, fr)

## Behavior Rules
- Documentation must match the actual code, not the plan
- Keep docs concise — enough to understand, not more
- Use consistent formatting across all docs
- Don't document internal implementation details
- Update, don't append — keep docs clean and current
- Verify links and references are valid

## Output Format
- List of updated documentation files
- Summary of changes per file
- Any gaps identified that need manual input

## Quality Gate
- All changed endpoints reflected in API.md
- Data model changes reflected in ARCHITECTURE.md
- No stale documentation
- i18n files are in sync across all locales`,

  DEVOPS: `# DevOps Agent

You are the **DevOps** agent — responsible for deployment, CI/CD, and infrastructure.

## Core Responsibilities
- Build and deploy application changes
- Manage systemd services and nginx configuration
- Run database migrations in production
- Monitor deployment health
- Create and manage git commits and branches
- Handle the final handoff to human review

## Deployment Checklist
1. **Build**: Backend (npx nest build) + Frontend (npx ng build)
2. **Migrate**: Database migrations (prisma migrate deploy)
3. **Deploy**: Restart services, update static files
4. **Verify**: Health checks, smoke tests
5. **Commit**: Clean git commit with conventional message
6. **Notify**: Report deployment status

## Behavior Rules
- NEVER deploy without successful builds
- NEVER run destructive database operations without confirmation
- Always create a git commit before deploying
- Verify health endpoints after deployment
- Roll back on deployment failure
- Keep deployment logs for debugging

## Security Rules
- Never expose internal ports to the internet
- Verify file permissions after deployment (nginx needs read access)
- Check that .env files are not in the build output
- Verify CORS settings are correct after deployment

## Output Format
- Deployment Report: steps taken, status per step
- Build Output Summary (errors/warnings only)
- Health Check Results
- Git Commit SHA + message

## Quality Gate
- All builds succeed
- All health checks pass
- No error logs in the first 30 seconds
- Previous functionality still works`,
};

// ─── Role Metadata (shared across all presets) ──────────────────────

interface RoleMeta {
  permissions: AgentRoleConfig['permissions'];
  pipelinePosition: number;
  description: string;
  color: string;
  icon: string;
}

const ROLE_META: Record<string, RoleMeta> = {
  INTERVIEWER: {
    permissions: { fileRead: true, fileWrite: false, terminal: false, installPackages: false, http: false, gitOperations: false },
    pipelinePosition: 1,
    description: 'Conducts feature interviews, asks questions until 95% clarity',
    color: 'sky',
    icon: 'message-circle',
  },
  ARCHITECT: {
    permissions: { fileRead: true, fileWrite: false, terminal: false, installPackages: false, http: false, gitOperations: false },
    pipelinePosition: 2,
    description: 'Designs technical architecture and system-level decisions',
    color: 'violet',
    icon: 'pen-tool',
  },
  ISSUE_COMPILER: {
    permissions: { fileRead: true, fileWrite: false, terminal: false, installPackages: false, http: true, gitOperations: false },
    pipelinePosition: 3,
    description: 'Compiles interview results into structured GitLab issues',
    color: 'amber',
    icon: 'list-checks',
  },
  CODER: {
    permissions: { fileRead: true, fileWrite: true, terminal: true, installPackages: true, http: false, gitOperations: true },
    pipelinePosition: 4,
    description: 'Implements code changes according to issue specifications',
    color: 'indigo',
    icon: 'code',
  },
  CODE_REVIEWER: {
    permissions: { fileRead: true, fileWrite: true, terminal: true, installPackages: false, http: false, gitOperations: true },
    pipelinePosition: 5,
    description: 'Reviews code for quality, security, and consistency',
    color: 'emerald',
    icon: 'search-check',
  },
  UI_TESTER: {
    permissions: { fileRead: true, fileWrite: false, terminal: true, installPackages: true, http: true, gitOperations: false },
    pipelinePosition: 6,
    description: 'Tests UI components, responsiveness, and accessibility',
    color: 'pink',
    icon: 'monitor-check',
  },
  FUNCTIONAL_TESTER: {
    permissions: { fileRead: true, fileWrite: true, terminal: true, installPackages: true, http: true, gitOperations: false },
    pipelinePosition: 7,
    description: 'Verifies functional requirements and runs integration tests',
    color: 'teal',
    icon: 'test-tubes',
  },
  PEN_TESTER: {
    permissions: { fileRead: true, fileWrite: false, terminal: true, installPackages: true, http: true, gitOperations: false },
    pipelinePosition: 8,
    description: 'Security testing and vulnerability assessment',
    color: 'red',
    icon: 'shield-alert',
  },
  DOCUMENTER: {
    permissions: { fileRead: true, fileWrite: true, terminal: false, installPackages: false, http: false, gitOperations: true },
    pipelinePosition: 9,
    description: 'Maintains project documentation and changelog',
    color: 'cyan',
    icon: 'file-text',
  },
  DEVOPS: {
    permissions: { fileRead: true, fileWrite: true, terminal: true, installPackages: true, http: true, gitOperations: true },
    pipelinePosition: 10,
    description: 'Handles deployment, CI/CD, and infrastructure management',
    color: 'orange',
    icon: 'rocket',
  },
};

// ─── Build final config by merging prompt + meta + preset ───────────

function buildRoleConfigs(preset: Preset): Record<string, AgentRoleConfig> {
  const overrides = PRESETS[preset];
  const result: Record<string, AgentRoleConfig> = {};

  for (const [role, meta] of Object.entries(ROLE_META)) {
    const override = overrides[role];
    if (!override) {
      console.warn(`  ⚠ No preset override for ${role}, skipping`);
      continue;
    }

    result[role] = {
      provider: override.provider,
      model: override.model,
      systemPrompt: SYSTEM_PROMPTS[role] ?? '',
      parameters: {
        temperature: override.temperature ?? 0.3,
        maxTokens: override.maxTokens ?? 4096,
      },
      ...meta,
    };
  }

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  // Parse --preset argument
  const args = process.argv.slice(2);
  const presetIdx = args.indexOf('--preset');
  const presetName = (presetIdx >= 0 ? args[presetIdx + 1] : 'local') as Preset;

  if (!PRESETS[presetName]) {
    console.error(`Unknown preset "${presetName}". Available: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\nSeeding agent role configurations (preset: ${presetName})...\n`);

  // Remove old agent defaults (legacy keys)
  const oldKeys = [
    'agents.defaults.TICKET_CREATOR',
    'agents.defaults.CODER',
    'agents.defaults.CODE_REVIEWER',
    'agents.defaults.UI_TESTER',
    'agents.defaults.PEN_TESTER',
    'agents.defaults.DOCUMENTER',
  ];

  for (const key of oldKeys) {
    await prisma.systemSetting.deleteMany({ where: { key } });
  }

  // Build and seed role configs
  const roleConfigs = buildRoleConfigs(presetName);

  for (const [role, config] of Object.entries(roleConfigs)) {
    const key = `agents.roles.${role}`;
    const value = JSON.stringify(config);

    await prisma.systemSetting.upsert({
      where: { key },
      create: {
        category: 'agents',
        key,
        value,
        encrypted: false,
        description: config.description,
      },
      update: {
        value,
        category: 'agents',
        description: config.description,
      },
    });

    console.log(`  ✓ ${role.padEnd(20)} ${config.provider}/${config.model} (temp=${config.parameters.temperature})`);
  }

  // Seed pipeline settings
  const pipelineConfig = {
    key: 'agents.pipeline',
    value: JSON.stringify({
      enabled: false,
      autoStart: false,
      requireApproval: true,
      maxConcurrentAgents: 2,
      timeoutMinutes: 30,
    }),
    category: 'agents',
    description: 'Global pipeline configuration',
  };

  await prisma.systemSetting.upsert({
    where: { key: pipelineConfig.key },
    create: {
      ...pipelineConfig,
      encrypted: false,
    },
    update: {
      value: pipelineConfig.value,
      description: pipelineConfig.description,
    },
  });
  console.log('  ✓ agents.pipeline (global config)');

  console.log(`\nSeeded ${Object.keys(roleConfigs).length} agent role configs (preset: ${presetName}) + pipeline settings.\n`);

  // Print VRAM estimate for local preset
  if (presetName === 'local') {
    console.log('── VRAM Strategy (2×3090 = 48GB) ──');
    console.log('  qwen3.5:35b        ~22GB  (Interviewer, Issue Compiler, Documenter)');
    console.log('  deepseek-r1:32b    ~20GB  (Architect, Code Reviewer, Pentester)');
    console.log('  qwen3-coder:30b    ~19GB  (Coder, UI Tester, Func. Tester, DevOps)');
    console.log('');
    console.log('  Parallel combos (all fit 48GB):');
    console.log('    qwen3.5 + deepseek-r1  = 42GB ✓');
    console.log('    qwen3.5 + qwen3-coder  = 41GB ✓');
    console.log('    deepseek-r1 + qwen3-coder = 39GB ✓');
    console.log('    Same model parallel    = shared VRAM! ✓');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
