import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawnAgentTask } from './tasks.js';
import { config } from './config.js';

// ── Tool input schemas (JSON Schema) ───────────────────────────────

const shellSchema = {
  type: 'object' as const,
  properties: {
    command: { type: 'string' as const, description: 'Shell command to execute' },
  },
  required: ['command'],
};

const fileReadSchema = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' as const, description: 'Absolute path to read' },
  },
  required: ['path'],
};

const fileWriteSchema = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' as const, description: 'Absolute path to write' },
    content: { type: 'string' as const, description: 'File content' },
  },
  required: ['path', 'content'],
};

const spawnAgentSchema = {
  type: 'object' as const,
  properties: {
    prompt: { type: 'string' as const, description: 'Task description for the agent' },
    agent: {
      type: 'string' as const,
      description: 'Agent profile name to spawn (passed as --profile to the agent command)',
    },
    workDir: {
      type: 'string' as const,
      description: 'Working directory for the agent session',
    },
  },
  required: ['prompt', 'agent'],
};

// ── Tool definitions ────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const tools: ToolDef[] = [
  {
    name: 'shell',
    description: 'Execute a shell command and return stdout/stderr',
    input_schema: shellSchema,
  },
  {
    name: 'file_read',
    description: 'Read a file and return its contents',
    input_schema: fileReadSchema,
  },
  {
    name: 'file_write',
    description: 'Write content to a file (creates parent dirs, overwrites if exists)',
    input_schema: fileWriteSchema,
  },
  {
    name: 'spawn_agent',
    description: 'Spawn an async background agent for complex tasks. Returns a taskId for tracking.',
    input_schema: spawnAgentSchema,
  },
];

// ── Shell safety ────────────────────────────────────────────────────

const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*\//,
  /\brm\s+(-[a-zA-Z]*\s+)*~/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /\b>\s*\/dev\/sd/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bchown\s+-R\s+.*\//,
  /\bsudo\s+rm\b/,
  /\bsudo\s+mkfs\b/,
  /\bsudo\s+dd\b/,
  /\b:(){ :\|:& };:/,
  /\bcurl\b.*\|\s*\bsh\b/,
  /\bwget\b.*\|\s*\bsh\b/,
  /\bnpm\s+publish\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+.*-f\b/,
];

function validateShellCommand(cmd: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return `🚫 Blocked: command matches destructive pattern (${pattern.source}). Refusing to execute.`;
    }
  }
  return null;
}

// ── Tool context ────────────────────────────────────────────────────

export interface ToolContext {
  channel: string;
  threadTs: string;
}

// ── Tool execution ──────────────────────────────────────────────────

export function executeTool(
  name: string,
  input: Record<string, string>,
  ctx: ToolContext,
): string {
  try {
    switch (name) {
      case 'shell': {
        const blocked = validateShellCommand(input.command);
        if (blocked) return blocked;
        return execSync(input.command, {
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
      }

      case 'file_read':
        return readFileSync(input.path, 'utf-8');

      case 'file_write':
        mkdirSync(dirname(input.path), { recursive: true });
        writeFileSync(input.path, input.content);
        return 'ok';

      case 'spawn_agent': {
        const parsed = input as unknown as {
          prompt: string;
          agent: string;
          workDir?: string;
        };
        const cwd = parsed.workDir ?? config.agentCwd;
        const args = [
          ...parseArgs(config.agentArgs),
          '--profile', parsed.agent,
          '--prompt', parsed.prompt,
        ];
        const meta = spawnAgentTask(
          config.agentCommand,
          args,
          cwd,
          ctx.threadTs,
          ctx.channel,
        );
        return JSON.stringify({
          taskId: meta.taskId,
          pid: meta.pid,
          agent: parsed.agent,
          logFile: meta.logFile,
        });
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e: unknown) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function parseArgs(argsStr: string): string[] {
  return argsStr.trim() ? argsStr.trim().split(/\s+/) : [];
}
