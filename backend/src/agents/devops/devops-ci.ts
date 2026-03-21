/**
 * CI/CD template generation — .gitlab-ci.yml and .gitignore
 *
 * Pure functions with no DI dependencies, called by DevopsAgent.
 */

/** Known MCP server definitions — maps name to command + args */
export const MCP_SERVER_REGISTRY: Record<
  string,
  { command: string; args: string[]; transport?: string; url?: string }
> = {
  'angular-mcp-server': { command: 'angular-mcp-server', args: [] },
  prisma: { command: 'npx', args: ['prisma', 'mcp'] },
  context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
  typescript: { command: 'npx', args: ['-y', 'typescript-mcp-server'] },
  eslint: { command: 'npx', args: ['-y', 'eslint-mcp-server'] },
  tailwindcss: { command: 'npx', args: ['-y', '@anthropic/tailwindcss-mcp'] },
  vaadin: {
    command: '',
    args: [],
    transport: 'http',
    url: 'https://mcp.vaadin.com/',
  },
  'spring-docs': {
    command: 'npx',
    args: ['-y', '@enokdev/springdocs-mcp@latest'],
  },
};

// ─── .gitlab-ci.yml templates ────────────────────────────────

/** Build a deterministic .gitlab-ci.yml based on the tech stack */
export function buildCiYml(rawFramework: string, rawLanguage: string): string {
  const framework = rawFramework.toLowerCase().replace(/\s+/g, '-');
  const language = rawLanguage
    .toLowerCase()
    .replace(/[\s\d.]+/g, '')
    .trim();

  // Angular / React / Vue / Node projects
  if (
    ['angular', 'react', 'vue', 'next', 'nuxt', 'svelte'].includes(framework) ||
    ['typescript', 'javascript'].includes(language)
  ) {
    return `stages:
  - install
  - lint
  - test
  - build

variables:
  NODE_ENV: "test"

install:
  stage: install
  tags: [docker, vibcode]
  image: node:22-alpine
  script:
    - npm ci --prefer-offline
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
    policy: pull-push

lint:
  stage: lint
  tags: [docker, vibcode]
  image: node:22-alpine
  needs: [install]
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
    policy: pull
  script:
    - npm run lint --if-present

test:
  stage: test
  tags: [docker, vibcode]
  image: node:22-alpine
  needs: [install]
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
    policy: pull
  script:
    - npm test --if-present
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: node:22-alpine
  needs: [install]
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
    policy: pull
  script:
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 week
`;
  }

  // Python projects
  if (
    ['python', 'django', 'flask', 'fastapi'].includes(framework) ||
    language === 'python'
  ) {
    return `stages:
  - install
  - lint
  - test
  - build

install:
  stage: install
  tags: [docker, vibcode]
  image: python:3.12-slim
  script:
    - pip install -r requirements.txt
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - .venv/

lint:
  stage: lint
  tags: [docker, vibcode]
  image: python:3.12-slim
  needs: [install]
  script:
    - pip install ruff
    - ruff check .
  allow_failure: true

test:
  stage: test
  tags: [docker, vibcode]
  image: python:3.12-slim
  needs: [install]
  script:
    - pip install pytest
    - pytest --tb=short
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: python:3.12-slim
  needs: [install]
  script:
    - echo "Build step — customize as needed"
`;
  }

  // Rust projects
  if (framework === 'rust' || language === 'rust') {
    return `stages:
  - lint
  - test
  - build

lint:
  stage: lint
  tags: [docker, vibcode]
  image: rust:latest
  script:
    - rustup component add clippy
    - cargo clippy -- -D warnings
  allow_failure: true

test:
  stage: test
  tags: [docker, vibcode]
  image: rust:latest
  script:
    - cargo test
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: rust:latest
  script:
    - cargo build --release
  artifacts:
    paths:
      - target/release/
    expire_in: 1 week
`;
  }

  // Go projects
  if (framework === 'go' || language === 'go') {
    return `stages:
  - lint
  - test
  - build

lint:
  stage: lint
  tags: [docker, vibcode]
  image: golang:1.22
  script:
    - go vet ./...
  allow_failure: true

test:
  stage: test
  tags: [docker, vibcode]
  image: golang:1.22
  script:
    - go test ./...
  allow_failure: true

build:
  stage: build
  tags: [docker, vibcode]
  image: golang:1.22
  script:
    - go build -o app ./...
  artifacts:
    paths:
      - app
    expire_in: 1 week
`;
  }

  // Java / Spring Boot / Vaadin / Maven projects
  if (
    ['java', 'spring', 'spring-boot', 'vaadin', 'quarkus'].includes(
      framework,
    ) ||
    language === 'java'
  ) {
    return `stages:
  - build
  - test
  - package

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=.m2/repository"

build:
  stage: build
  tags: [docker, vibcode]
  image: maven:3.9-eclipse-temurin-21-alpine
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - .m2/repository/
  script:
    - mvn clean compile -B
  artifacts:
    paths:
      - target/
    expire_in: 1 hour

test:
  stage: test
  tags: [docker, vibcode]
  image: maven:3.9-eclipse-temurin-21-alpine
  needs: [build]
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - .m2/repository/
  script:
    - mvn test -B
  allow_failure: true

package:
  stage: package
  tags: [docker, vibcode]
  image: maven:3.9-eclipse-temurin-21-alpine
  needs: [build]
  cache:
    key: \${CI_COMMIT_REF_SLUG}
    paths:
      - .m2/repository/
  script:
    - mvn clean package -DskipTests -B
  artifacts:
    paths:
      - target/*.jar
      - target/*.war
    expire_in: 1 week
`;
  }

  // Generic fallback
  return `stages:
  - build

build:
  stage: build
  tags: [docker, vibcode]
  script:
    - echo "Configure CI/CD pipeline for your project"
    - echo "Framework detection did not match a known template"
`;
}

// ─── .gitignore templates ────────────────────────────────────

/** Build a .gitignore appropriate for the tech stack */
export function buildGitignore(
  rawFramework: string,
  rawLanguage: string,
): string {
  const framework = rawFramework.toLowerCase().replace(/\s+/g, '-');
  const language = rawLanguage
    .toLowerCase()
    .replace(/[\s\d.]+/g, '')
    .trim();
  const isJava =
    language === 'java' ||
    ['java', 'spring', 'spring-boot', 'vaadin', 'quarkus'].some((k) =>
      framework.includes(k),
    );
  const isNode =
    !isJava ||
    ['typescript', 'javascript'].includes(language) ||
    [
      'angular',
      'react',
      'vue',
      'next',
      'nuxt',
      'svelte',
      'nest',
      'express',
    ].some((k) => framework.includes(k));

  const sections: string[] = [];

  if (isNode) {
    sections.push(
      '# Dependencies',
      'node_modules/',
      '**/node_modules/',
      '.pnp/',
      '.pnp.js',
      '',
    );
    sections.push(
      '# Build output',
      'dist/',
      'build/',
      '.next/',
      '.nuxt/',
      '.output/',
      '.angular/',
      '',
    );
    sections.push('# Logs', 'logs/', '*.log', 'npm-debug.log*', '');
  }

  if (isJava) {
    sections.push(
      '# Java/Maven',
      'target/',
      '*.class',
      '*.jar',
      '*.war',
      '*.ear',
      '',
    );
    sections.push(
      '# Maven',
      'pom.xml.tag',
      'pom.xml.releaseBackup',
      'pom.xml.versionsBackup',
      'pom.xml.next',
      'release.properties',
      '',
    );
    sections.push('# Gradle', '.gradle/', 'build/', '');
    sections.push(
      '# Vaadin',
      'node_modules/',
      'frontend/generated/',
      'vite.generated.ts',
      '',
    );
  }

  // Environment and secrets
  sections.push(
    '# Environment',
    '.env',
    '.env.local',
    '.env.*.local',
    'application-local.properties',
    'application-local.yml',
    '',
  );

  // IDE
  sections.push(
    '# IDE',
    '.idea/',
    '.vscode/',
    '*.swp',
    '*.swo',
    '.DS_Store',
    'Thumbs.db',
    '*.iml',
    '',
  );

  // Testing
  sections.push('# Testing', 'coverage/', '.nyc_output/', '');

  // Prisma (common for NestJS projects)
  if (
    framework === 'angular' ||
    framework === 'react' ||
    framework === 'vue' ||
    language === 'typescript' ||
    language === 'javascript'
  ) {
    sections.push('# Prisma', '*.db', '*.db-journal', '');
  }

  // Misc
  sections.push('# Misc', '.cache/', 'tmp/', '.tmp/', '');

  return sections.join('\n') + '\n';
}
