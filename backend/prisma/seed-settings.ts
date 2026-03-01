/**
 * Seed script: Migrates current .env values into the SystemSettings DB table.
 *
 * Run: npx ts-node prisma/seed-settings.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createCipheriv, randomBytes, createHash } from 'crypto';

function encrypt(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://vibcodehub:REDACTED_DB_PASSWORD@127.0.0.1:5432/vibcodehub?schema=public';
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const encryptionKey = process.env.KEYCLOAK_CLIENT_SECRET ?? '';

  if (!encryptionKey) {
    console.error('KEYCLOAK_CLIENT_SECRET is required for encryption.');
    process.exit(1);
  }

  const settings: Array<{
    category: string;
    key: string;
    value: string;
    encrypted: boolean;
    description: string;
  }> = [
    // ─── GitLab ──────────────────────────────────────────────
    {
      category: 'gitlab',
      key: 'gitlab.url',
      value: process.env.GITLAB_URL ?? 'https://git.example.com',
      encrypted: false,
      description: 'GitLab server URL',
    },
    {
      category: 'gitlab',
      key: 'gitlab.api_token',
      value: process.env.GITLAB_API_TOKEN ?? '',
      encrypted: true,
      description: 'GitLab API token (bot user)',
    },
    {
      category: 'gitlab',
      key: 'gitlab.webhook_secret',
      value: process.env.GITLAB_WEBHOOK_SECRET ?? '',
      encrypted: true,
      description: 'GitLab webhook verification secret',
    },

    // ─── LLM Providers ──────────────────────────────────────
    {
      category: 'llm',
      key: 'llm.ollama.url',
      value: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
      encrypted: false,
      description: 'Ollama API URL',
    },
    {
      category: 'llm',
      key: 'llm.anthropic.api_key',
      value: process.env.ANTHROPIC_API_KEY ?? '',
      encrypted: true,
      description: 'Anthropic API Key',
    },
    {
      category: 'llm',
      key: 'llm.openai.api_key',
      value: process.env.OPENAI_API_KEY ?? '',
      encrypted: true,
      description: 'OpenAI API Key',
    },
    {
      category: 'llm',
      key: 'llm.google.api_key',
      value: process.env.GOOGLE_AI_API_KEY ?? '',
      encrypted: true,
      description: 'Google AI API Key',
    },

    // ─── CORS ────────────────────────────────────────────────
    {
      category: 'cors',
      key: 'cors.origins',
      value: JSON.stringify([
        'https://hub.example.com',
        'http://localhost:4200',
      ]),
      encrypted: false,
      description: 'Allowed CORS origins (JSON array)',
    },

    // ─── App ─────────────────────────────────────────────────
    {
      category: 'app',
      key: 'app.name',
      value: '"VibCode Hub"',
      encrypted: false,
      description: 'Application display name',
    },

    // ─── Agent Defaults ──────────────────────────────────────
    {
      category: 'agents',
      key: 'agents.defaults.TICKET_CREATOR',
      value: JSON.stringify({ provider: 'OLLAMA', model: 'llama3.1' }),
      encrypted: false,
      description: 'Default LLM for Ticket Creator agent',
    },
    {
      category: 'agents',
      key: 'agents.defaults.CODER',
      value: JSON.stringify({ provider: 'OLLAMA', model: 'llama3.1' }),
      encrypted: false,
      description: 'Default LLM for Coder agent',
    },
    {
      category: 'agents',
      key: 'agents.defaults.CODE_REVIEWER',
      value: JSON.stringify({ provider: 'OLLAMA', model: 'llama3.1' }),
      encrypted: false,
      description: 'Default LLM for Code Reviewer agent',
    },
    {
      category: 'agents',
      key: 'agents.defaults.UI_TESTER',
      value: JSON.stringify({ provider: 'OLLAMA', model: 'llama3.1' }),
      encrypted: false,
      description: 'Default LLM for UI Tester agent',
    },
    {
      category: 'agents',
      key: 'agents.defaults.PEN_TESTER',
      value: JSON.stringify({ provider: 'OLLAMA', model: 'llama3.1' }),
      encrypted: false,
      description: 'Default LLM for Pen Tester agent',
    },
    {
      category: 'agents',
      key: 'agents.defaults.DOCUMENTER',
      value: JSON.stringify({ provider: 'OLLAMA', model: 'llama3.1' }),
      encrypted: false,
      description: 'Default LLM for Documenter agent',
    },
  ];

  for (const s of settings) {
    const value = s.encrypted && s.value
      ? encrypt(s.value, encryptionKey)
      : s.value;

    await prisma.systemSetting.upsert({
      where: { key: s.key },
      create: {
        category: s.category,
        key: s.key,
        value,
        encrypted: s.encrypted,
        description: s.description,
      },
      update: {
        value,
        category: s.category,
        encrypted: s.encrypted,
        description: s.description,
      },
    });

    console.log(`  ✓ ${s.key}${s.encrypted ? ' (encrypted)' : ''}`);
  }

  console.log(`\nSeeded ${settings.length} system settings.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
