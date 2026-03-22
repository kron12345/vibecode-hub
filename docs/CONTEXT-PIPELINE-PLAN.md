# Context Pipeline — Implementation Plan

## Vision

Every decision, handoff, and finding in the pipeline is **visible in GitLab** — as issue comments, wiki pages, or MR discussions. No hidden DB fields, no black boxes. Any developer can open GitLab and understand exactly what happened, why, and what each agent knew when it made its decisions.

---

## Phase 1: Issue Context Snapshot (The Canonical Spec)

### Problem
The Architect designs the approach, the Issue Compiler creates issues, but the Coder only sees the issue title + description. The Architect's rationale, constraints, and file recommendations are buried in chat comments that get truncated.

### Solution
After Architect grounding, post a **structured context block** as a GitLab issue comment with a standardized format. All downstream agents parse this block instead of reconstructing from chat history.

### GitLab Visibility
Each grounded issue gets a pinned comment like:

```markdown
## Context Snapshot (by Architect)

**Goal:** Implement OAuth2 login with Keycloak PKCE flow
**Approach:** Use spring-boot-starter-oauth2-client with SecurityConfig extending VaadinWebSecurity
**Rationale:** Vaadin's built-in security integrates with Spring Security; custom filters would break Vaadin's CSRF handling

### Files to Touch
- `src/main/java/.../SecurityConfig.java` (create)
- `src/main/java/.../MainLayout.java` (modify — add @AnonymousAllowed)
- `src/main/resources/application.yml` (add OAuth2 config)

### Files to Avoid
- `src/main/java/.../Application.java` (no changes needed)

### Constraints
- MainLayout MUST have @AnonymousAllowed (Vaadin framework requirement)
- All @Route views need explicit security annotations
- Do NOT use permitAll() in SecurityConfig — use @PermitAll on views instead

### Acceptance Criteria
1. Unauthenticated users are redirected to Keycloak login
2. All 4 roles (admin, planer, disponent, viewer) can access @PermitAll views
3. @RolesAllowed views reject unauthorized roles with 403

### Out of Scope
- Custom login page (use Keycloak default)
- Remember-me functionality
```

### Implementation
- **Architect agent**: After grounding, generate structured JSON, then format as Markdown comment on the GitLab issue
- **Coder**: Parse the `## Context Snapshot` block from issue comments before coding
- **Reviewer**: Parse it to validate code against the approved approach
- **Storage**: GitLab issue comment (visible to everyone) + `AgentTask.output` (for API access)

### Files to Change
- `backend/prompts/architect-grounding.md` — output format with Context Snapshot
- `backend/src/agents/architect/architect.agent.ts` — post snapshot as GitLab comment
- `backend/src/agents/coder/coder-prompt.ts` — read snapshot from issue comments
- `backend/src/agents/code-reviewer/code-reviewer.agent.ts` — read snapshot for validation
- `backend/src/agents/agent-comment.utils.ts` — `extractContextSnapshot()` parser

---

## Phase 2: Failure Memory (Trial Log)

### Problem
Fix round 3 attempts the same approach that failed in round 1. The Coder doesn't remember what was already tried and rejected.

### Solution
Maintain a **Trial Log** as a GitLab issue comment that tracks every fix attempt, what was tried, and why it failed. Updated after each review/test round.

### GitLab Visibility
Each issue with fix rounds gets a continuously updated comment:

```markdown
## Trial Log

### Round 1 (Coder → Reviewer)
**Approach:** Used @RolesAllowed("ROLE_RAIL_ADMIN") on BusinessesView
**Result:** REJECTED by Code Reviewer
**Reason:** Issue spec says @PermitAll for shared views — BusinessesView is shared
**Lesson:** BusinessesView must use @PermitAll, not role-based restriction

### Round 2 (Coder → Reviewer)
**Approach:** Changed to @PermitAll on BusinessesView, but missed MainLayout
**Result:** REJECTED by Code Reviewer
**Reason:** Vaadin requires @AnonymousAllowed on layout classes too
**Lesson:** MainLayout needs @AnonymousAllowed for route resolution

### Round 3 (Coder → Functional Tester)
**Approach:** Added @AnonymousAllowed to MainLayout + @PermitAll on BusinessesView
**Result:** FAILED by Functional Tester
**Reason:** mvn test failed — Surefire plugin not cached (INCONCLUSIVE, infra issue)
**Lesson:** Test failure was infrastructure, not code — approach is correct
```

### Implementation
- **Pipeline Retry Service**: After each review/test rejection, append to the Trial Log comment
- **Coder**: Reads Trial Log before each fix attempt to avoid repeating failed approaches
- **Loop Resolver**: Uses Trial Log for root cause analysis instead of reconstructing from comments

### Files to Change
- `backend/src/agents/pipeline-retry.service.ts` — build and update Trial Log comment
- `backend/src/agents/coder/coder-prompt.ts` — inject Trial Log into fix prompts
- `backend/src/agents/loop-resolver/loop-resolver.service.ts` — read Trial Log
- `backend/src/agents/agent-comment.utils.ts` — `extractTrialLog()` + `appendTrialEntry()`

---

## Phase 3: Coder Execution Manifest

### Problem
Testers don't know what the Coder actually changed beyond raw diffs. They test wrong routes, wrong files, or miss important changes. The Documenter doesn't know which features were implemented.

### Solution
After each coding round, the Coder posts an **Execution Manifest** as a MR comment listing exactly what was done.

### GitLab Visibility
Each MR gets a comment from the Coder:

```markdown
## Execution Manifest

**Issue:** #21 — Apply @RolesAllowed annotations
**Round:** Initial implementation (not a fix)

### Changed Files (5)
| File | Action | What Changed |
|------|--------|-------------|
| SecurityConfig.java | MODIFIED | Added OAuth2 login config, access-denied handler |
| MainLayout.java | MODIFIED | Added @AnonymousAllowed annotation |
| AdminView.java | CREATED | New admin-only view with @RolesAllowed |
| AccessDeniedView.java | CREATED | Error view for 403 responses |
| SecurityConfigIntegrationTest.java | CREATED | 6 test methods for role matrix |

### Routes/Pages Affected
- `/admin` (new — admin only)
- `/access-denied` (new — error page)
- `/orders` (unchanged but now @PermitAll annotated)
- `/businesses` (unchanged but now @PermitAll annotated)

### Commands Run
- `mvn compile` — SUCCESS
- `mvn test` — SUCCESS (6/6 passed)

### Known Limitations
- Tests use mocked security context, no real Keycloak
- AccessDeniedView has no "back" link yet (separate issue)

### Recommended Test Focus
- Verify @RolesAllowed("ROLE_RAIL_ADMIN") on /admin blocks viewer role
- Verify @PermitAll views are accessible to all 4 roles
- Check AccessDeniedView renders correctly with 403 status
```

### Implementation
- **Coder agent**: Generate manifest from MCP tool call log (files read/written, commands run)
- **Post as MR comment**: Visible to Reviewer and all Testers
- **Testers**: Parse manifest to focus testing on changed routes/files
- **Documenter**: Use manifest for changelog generation

### Files to Change
- `backend/src/agents/coder/coder.agent.ts` — generate manifest from MCP results
- `backend/src/agents/coder/coder-prompt.ts` — instruct LLM to output manifest format
- `backend/src/agents/functional-tester/functional-tester.agent.ts` — read manifest
- `backend/src/agents/ui-tester/ui-tester-analysis.ts` — use manifest routes instead of diff heuristics
- `backend/src/agents/pen-tester/pen-tester.agent.ts` — focus on manifest attack surface

---

## Phase 4: Context Assembler Service

### Problem
Each agent manually concatenates issue text, comments, wiki, diffs, and history into its prompt. This leads to inconsistent context, truncation of important info, and prompt bloat with irrelevant details.

### Solution
A shared `ContextAssemblerService` that builds agent-specific prompts from all available context sources, ranked by relevance to the current task.

### GitLab Visibility
Not directly visible in GitLab (this is an internal optimization), BUT the quality improvement shows in:
- More relevant agent comments (agents cite the right context)
- Fewer "I don't have enough context" failures
- Pipeline activity log shows which context sections were included

### Implementation
- **ContextAssemblerService**: Takes `{ issueId, agentRole, stage }` and returns assembled context
- **Context sources** (priority ordered):
  1. Context Snapshot (from Phase 1)
  2. Trial Log (from Phase 2)
  3. Execution Manifest (from Phase 3)
  4. Unresolved Finding Threads
  5. Issue description + acceptance criteria
  6. ENVIRONMENT.md + PROJECT_KNOWLEDGE.md
  7. Recent chat messages (filtered by relevance)
  8. MR diff (for review/test stages)
- **Token budget**: Each section gets a budget based on agent role and stage
- **Relevance scoring**: File overlap, matching decision IDs, recency

### Files to Change
- `backend/src/agents/context-assembler.service.ts` — new service
- `backend/src/agents/agent-base.ts` — `assembleContext()` method
- All agent files — use assembler instead of manual concatenation
- `backend/src/agents/agents.module.ts` — register service

---

## Phase 5: Decision Ledger (Architect Decision Records)

### Problem
The Reviewer flags valid Architect decisions as bugs because there's no authoritative record of what was decided and why. The Coder makes different choices because the design rationale isn't visible in the code.

### Solution
The Architect produces **Architecture Decision Records (ADRs)** stored as a GitLab Wiki page per issue. Each decision has a stable ID that agents reference.

### GitLab Visibility
Wiki page per issue (e.g., `Decisions-Issue-21`):

```markdown
# Architecture Decisions — Issue #21

## D-21-01: Use @PermitAll for shared views
**Status:** APPROVED
**Context:** The app has views shared by all roles (Orders, Businesses) and admin-only views
**Decision:** Use `@PermitAll` for shared views, `@RolesAllowed` only for admin views
**Rationale:** Simpler than enumerating all 4 roles; Vaadin recommends @PermitAll for authenticated-but-not-role-restricted views
**Alternatives rejected:**
- `@RolesAllowed({"ADMIN","PLANER","DISPONENT","VIEWER"})` — verbose, error-prone when roles change
**Affects:** BusinessesView.java, OrdersView.java

## D-21-02: MainLayout requires @AnonymousAllowed
**Status:** APPROVED (framework constraint)
**Context:** Vaadin's AnnotatedViewAccessChecker checks the entire navigation chain including layouts
**Decision:** Add `@AnonymousAllowed` to MainLayout
**Rationale:** Without it, ALL routes fail regardless of their own annotations
**Alternatives rejected:** None — this is a Vaadin framework requirement
**Affects:** MainLayout.java
```

### Integration with Code Review
- **Coder**: References decision IDs in comments: `// @decision D-21-01: Using @PermitAll per Architect spec`
- **Reviewer**: When seeing an unusual pattern, checks the Decision Wiki before flagging
- **DecisionGuardService**: After review parsing, auto-suppresses findings that conflict with approved decisions (with a note: "Suppressed — conflicts with approved decision D-21-01")

### Files to Change
- `backend/prompts/architect-grounding.md` — output ADR format
- `backend/src/agents/architect/architect.agent.ts` — write decisions to GitLab Wiki
- `backend/src/agents/coder/coder-prompt.ts` — inject decision IDs
- `backend/src/agents/code-reviewer/code-reviewer.agent.ts` — read decisions before review
- `backend/src/agents/decision-guard.service.ts` — new service, post-review finding filter

---

## Rollout Order

```
Phase 1: Context Snapshot ──────── Week 1
    ↓
Phase 2: Trial Log ─────────────── Week 1-2
    ↓
Phase 3: Execution Manifest ───── Week 2
    ↓
Phase 4: Context Assembler ────── Week 3
    ↓
Phase 5: Decision Ledger ──────── Week 3-4
```

Each phase is independently valuable. Phase 1 alone cuts loops by ~30%.
Phases 1+2+3 together cut loops by ~60%.
All 5 phases together: estimated ~80% loop reduction.

## Design Principles

1. **GitLab is the source of truth** — everything visible as comments, wiki pages, or MR discussions
2. **Structured Markdown** — parseable by agents, readable by humans
3. **Stable IDs** — decisions, findings, and trial entries have IDs that survive across rounds
4. **Progressive enhancement** — each phase works independently, later phases build on earlier ones
5. **No hidden state** — if an agent suppressed a finding, it says so and cites the decision ID
