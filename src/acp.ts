/**
 * ACP (Agent Client Protocol) client module — agent-agnostic.
 *
 * Spawns any ACP-compatible agent configured via AGENT_COMMAND / AGENT_ARGS.
 * configured via config.agentCommand / config.agentArgs.
 */

import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from './logger.js';
import { postMessage, updateMessage } from './slack/api.js';
import { config } from './config.js';

// ── Types ───────────────────────────────────────────────────────────

interface ManagedTerminal {
  process: ChildProcess;
  output: string;
  exitCode: number | null;
  exited: boolean;
  exitPromise: Promise<void>;
}

interface AcpSession {
  threadTs: string;
  channel: string;
  agentName: string;
  connection: acp.ClientSideConnection;
  sessionId: string;
  childProcess: ChildProcess;
  pid: number | undefined;
  cwd: string;
  host: string | undefined;
  messageBuffer: string;
  toolStatus: string;
  statusMsgTs: string | null;
  busy: boolean;
  startedAt: number;
}

export interface PromptResult {
  stopReason: string;
  statusMsgTs: string | null;
}

// ── State ───────────────────────────────────────────────────────────

const sessions = new Map<string, AcpSession>();

const FLUSH_INTERVAL_MS = 2000;
const MAX_SLACK_CHARS = 39000;

// ── Terminal Manager ────────────────────────────────────────────────

class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private nextId = 1;

  create(command: string, args: string[], cwd?: string | null, env?: Array<{ name: string; value: string }>): string {
    const terminalId = `term-${this.nextId++}`;
    const envObj: Record<string, string> = { ...process.env } as Record<string, string>;
    if (env) {
      for (const e of env) envObj[e.name] = e.value;
    }

    const proc = spawn(command, args, {
      cwd: cwd ?? undefined,
      env: envObj,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const terminal: ManagedTerminal = {
      process: proc,
      output: '',
      exitCode: null,
      exited: false,
      exitPromise: new Promise<void>((resolve) => {
        proc.on('exit', (code) => {
          terminal.exitCode = code;
          terminal.exited = true;
          resolve();
        });
      }),
    };

    const append = (chunk: Buffer) => { terminal.output += chunk.toString(); };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);

    this.terminals.set(terminalId, terminal);
    return terminalId;
  }

  getOutput(terminalId: string): { output: string; truncated: boolean; exitStatus?: { exitCode: number } } {
    const t = this.get(terminalId);
    return {
      output: t.output,
      truncated: false,
      ...(t.exited ? { exitStatus: { exitCode: t.exitCode ?? 1 } } : {}),
    };
  }

  async waitForExit(terminalId: string): Promise<{ exitCode: number }> {
    const t = this.get(terminalId);
    await t.exitPromise;
    return { exitCode: t.exitCode ?? 1 };
  }

  kill(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (t && !t.exited) t.process.kill('SIGTERM');
  }

  release(terminalId: string): void {
    this.kill(terminalId);
    this.terminals.delete(terminalId);
  }

  releaseAll(): void {
    for (const id of this.terminals.keys()) this.release(id);
  }

  private get(terminalId: string): ManagedTerminal {
    const t = this.terminals.get(terminalId);
    if (!t) throw new Error(`Terminal not found: ${terminalId}`);
    return t;
  }
}

const terminalManager = new TerminalManager();

// ── Helpers ─────────────────────────────────────────────────────────

function parseArgs(argsStr: string): string[] {
  return argsStr.trim() ? argsStr.trim().split(/\s+/) : [];
}

// ── Exported Functions ──────────────────────────────────────────────

export async function startSession(
  cwd: string,
  channel: string,
  threadTs: string,
  host?: string,
  agentOverride?: string,
): Promise<string> {
  if (sessions.has(threadTs)) {
    return '⚠️ An ACP session is already active in this thread.';
  }

  try {
    const command = agentOverride ?? config.agentCommand;
    const args = parseArgs(config.agentArgs);

    const child = host
      ? spawn('ssh', [host, command, ...args], {
          stdio: ['pipe', 'pipe', 'inherit'],
        })
      : spawn(command, args, {
          cwd,
          stdio: ['pipe', 'pipe', 'inherit'],
        });

    if (!child.stdin || !child.stdout) {
      child.kill();
      return '❌ Failed to create ACP stdio pipes.';
    }

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const displayName = command;

    const session: AcpSession = {
      threadTs,
      channel,
      agentName: displayName,
      connection: null!,
      sessionId: '',
      childProcess: child,
      pid: child.pid,
      cwd,
      host,
      messageBuffer: '',
      toolStatus: '',
      statusMsgTs: null,
      busy: false,
      startedAt: Date.now(),
    };

    const connection = new acp.ClientSideConnection(
      (_agentInterface: acp.Agent) => createClientHandler(session),
      stream,
    );

    session.connection = connection;

    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'cortex-acp', version: '0.1.0' },
    });

    const acpSession = await connection.newSession({ cwd, mcpServers: [] });
    session.sessionId = acpSession.sessionId;

    sessions.set(threadTs, session);

    child.on('exit', (code) => {
      if (sessions.has(threadTs)) {
        sessions.delete(threadTs);
        terminalManager.releaseAll();
        log.info(`ACP session ${threadTs} exited (code ${code})`);
        postMessage(channel, `🔌 ACP session ended (agent exited with code ${code}).`, threadTs).catch(() => {});
      }
    });

    child.on('error', (err) => {
      if (sessions.has(threadTs)) {
        sessions.delete(threadTs);
        log.error(`ACP session ${threadTs} error: ${err.message}`);
        postMessage(channel, `❌ ACP session error: ${err.message}`, threadTs).catch(() => {});
      }
    });

    log.info(`ACP session started: ${displayName} pid=${child.pid} session=${session.sessionId} cwd=${cwd}${host ? ` host=${host}` : ''} (thread ${threadTs})`);
    return `🤖 ACP session started with \`${displayName}\`${host ? ` on \`${host}\`` : ''} in \`${cwd}\`\n📎 PID: \`${child.pid}\` | Session: \`${session.sessionId}\`\nSend messages in this thread to chat.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to start ACP session: ${msg}`);
    return `❌ Failed to start ACP session: ${msg}`;
  }
}

export async function sendPrompt(
  threadTs: string,
  text: string,
  channel: string,
): Promise<PromptResult> {
  const session = sessions.get(threadTs);
  if (!session) return { stopReason: '❌ No active ACP session in this thread.', statusMsgTs: null };
  if (session.busy) return { stopReason: '⏳ Session is busy processing a previous prompt.', statusMsgTs: null };

  session.busy = true;
  session.messageBuffer = '';

  try {
    session.statusMsgTs = await postMessage(channel, '⏳ Working...', threadTs);

    const flushInterval = setInterval(() => {
      flushToSlack(session).catch(() => {});
    }, FLUSH_INTERVAL_MS);

    const result = await session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text }],
    });

    clearInterval(flushInterval);
    await flushToSlack(session);

    session.busy = false;
    return { stopReason: result.stopReason ?? 'done', statusMsgTs: session.statusMsgTs };
  } catch (err) {
    session.busy = false;
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`ACP prompt error (${threadTs}): ${msg}`);
    return { stopReason: `❌ Prompt error: ${msg}`, statusMsgTs: session.statusMsgTs };
  }
}

export async function endSession(threadTs: string): Promise<void> {
  const session = sessions.get(threadTs);
  if (!session) return;

  try {
    if (!session.childProcess.killed) {
      session.childProcess.kill('SIGTERM');
    }
  } catch {
    // Process may already be dead
  }

  sessions.delete(threadTs);
  log.info(`ACP session ended: ${threadTs}`);
}

export function isAcpSession(threadTs: string): boolean {
  return sessions.has(threadTs);
}

export function isAcpBusy(threadTs: string): boolean {
  return sessions.get(threadTs)?.busy ?? false;
}

export function getActiveSessionCount(): number {
  return sessions.size;
}

export function listSessions(): Array<{ threadTs: string; agent: string; pid: number | undefined; sessionId: string; cwd: string; host: string | undefined; busy: boolean; uptime: number }> {
  return [...sessions.values()].map((s) => ({
    threadTs: s.threadTs,
    agent: s.agentName,
    pid: s.pid,
    sessionId: s.sessionId,
    cwd: s.cwd,
    host: s.host,
    busy: s.busy,
    uptime: Math.round((Date.now() - s.startedAt) / 1000),
  }));
}

// ── Cleanup on process exit ─────────────────────────────────────────

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

function cleanup(): void {
  for (const session of sessions.values()) {
    try {
      if (!session.childProcess.killed) session.childProcess.kill('SIGTERM');
    } catch { /* already dead */ }
  }
  sessions.clear();
  terminalManager.releaseAll();
}

// ── Private Helpers ─────────────────────────────────────────────────

async function flushToSlack(session: AcpSession): Promise<void> {
  if (!session.statusMsgTs || (!session.messageBuffer && !session.toolStatus)) return;

  const parts: string[] = [];
  if (session.toolStatus) parts.push(session.toolStatus);
  if (session.messageBuffer) parts.push(session.messageBuffer);

  let text = `🤖 ${parts.join('\n\n')}`;
  if (text.length > MAX_SLACK_CHARS) {
    text = text.slice(text.length - MAX_SLACK_CHARS);
  }

  try {
    await updateMessage(session.channel, session.statusMsgTs, text);
  } catch {
    // Slack update failed — non-fatal
  }
}

function createClientHandler(session: AcpSession): acp.Client {
  return {
    async sessionUpdate(params: acp.SessionNotification): Promise<void> {
      const update = params.update;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') {
            session.messageBuffer += update.content.text;
            session.toolStatus = '';
          }
          break;
        case 'tool_call':
          session.toolStatus = `🔧 ${update.title} (${update.status})`;
          log.info(`[ACP pid=${session.pid}] tool_call: ${update.title} (${update.status})`);
          break;
        case 'tool_call_update':
          session.toolStatus = `🔧 ${update.toolCallId}: ${update.status}`;
          log.info(`[ACP pid=${session.pid}] tool_update: ${update.toolCallId} → ${update.status}`);
          break;
        case 'plan':
          log.info(`[ACP pid=${session.pid}] plan: ${update.entries.length} entries`);
          session.toolStatus = `📋 Plan: ${update.entries.map((e) => {
            const icon = e.status === 'completed' ? '✅' : e.status === 'in_progress' ? '🔄' : '⬜';
            return `${icon} ${e.content}`;
          }).join(' | ')}`;
          break;
        default:
          break;
      }
    },

    async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
      const firstOption = params.options[0];
      if (firstOption) {
        return { outcome: { outcome: 'selected', optionId: firstOption.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    },

    async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
      const content = await readFile(params.path, 'utf-8');
      return { content };
    },

    async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
      await mkdir(dirname(params.path), { recursive: true });
      await writeFile(params.path, params.content, 'utf-8');
      return {};
    },

    async createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
      const terminalId = terminalManager.create(
        params.command,
        params.args ?? [],
        params.cwd,
        params.env,
      );
      return { terminalId };
    },

    async terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
      return terminalManager.getOutput(params.terminalId);
    },

    async waitForTerminalExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
      return terminalManager.waitForExit(params.terminalId);
    },

    async killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
      terminalManager.kill(params.terminalId);
      return {};
    },

    async releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
      terminalManager.release(params.terminalId);
      return {};
    },

    async extNotification(): Promise<void> {},
  };
}
