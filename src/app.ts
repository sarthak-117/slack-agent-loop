import { readFileSync } from 'fs';
import { config } from './config.js';
import { getHistory, getReplies, postMessage, updateMessage, addReaction, openConversation } from './slack/api.js';
import { getOrCreate, save, saveAll, cleanupIfNeeded } from './store.js';
import { agentLoop } from './agent.js';
import { getNewlyCompletedTasks } from './tasks.js';
import { startSession, sendPrompt, endSession, isAcpSession, isAcpBusy, listSessions } from './acp.js';
import { log } from './logger.js';

// ── Output sanitization ─────────────────────────────────────────────

function sanitizeOutput(raw: string): string[] {
  return raw
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b./g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter(l => {
      const t = l.trim();
      if (!t) return false;
      if (/^[\s─━═│┃┌┐└┘├┤┬┴┼▸]+$/.test(t)) return false;
      if (/^▸\s*Credits:/i.test(t)) return false;
      if (/^▸\s*Time:/i.test(t)) return false;
      return true;
    });
}

// ── Constants ───────────────────────────────────────────────────────

const CORTEX_TAG = '🧠 *Cortex:*\n';
const THREAD_TTL_MS = 30 * 60 * 1000;

const HELP_TEXT = `
🧠 Cortex — Slack-based AI agent for your self-DM

Usage: npm start

Environment (.env):
  SLACK_BOT_TOKEN          Slack bot token (required)
  SLACK_USER_ID            Your Slack member ID (required)
  AGENT_COMMAND            ACP agent command (default: claude)
  AGENT_ARGS               Extra args for agent command
  AGENT_CWD                Default working directory
  AWS_REGION               AWS region for Bedrock (default: us-east-1)
  CORTEX_MODEL             Bedrock model ID
  CORTEX_MAX_ITERATIONS    Max agent loop iterations (default: 20)
  CORTEX_POLL_INTERVAL_MS  Poll interval in ms (default: 3000)
  CORTEX_TRIGGER           Command prefix (default: !cortex)

Slack commands:
  !cortex <task>                          Ask Cortex to do something
  !cortex chat [cwd] [--host <host>]      Start an interactive ACP session
  !cortex sessions                        List active ACP sessions
  !cortex help                            Show this help

In any thread:
  close                       Stop monitoring this thread
  (threads auto-close after 30 min of inactivity)
`.trim();

// ── Thread state ────────────────────────────────────────────────────

let channelId: string;
let lastTopLevelTs = '';
const activeThreads = new Set<string>();
const threadLastSeen = new Map<string, string>();
const threadLastActivity = new Map<string, number>();
const cortexMessageTs = new Set<string>();
const processingThreads = new Set<string>();

function closeThread(threadTs: string): void {
  activeThreads.delete(threadTs);
  threadLastSeen.delete(threadTs);
  threadLastActivity.delete(threadTs);
}

function touchThread(threadTs: string): void {
  threadLastActivity.set(threadTs, Date.now());
}

function expireStaleThreads(): void {
  const now = Date.now();
  for (const threadTs of activeThreads) {
    const last = threadLastActivity.get(threadTs) ?? 0;
    if (now - last > THREAD_TTL_MS) {
      log.info(`Auto-closing stale thread: ${threadTs}`);
      closeThread(threadTs);
    }
  }
}

// ── Chat command parsing ────────────────────────────────────────────

function parseChatCommand(command: string): { cwd: string; host: string | undefined } {
  const args = command.slice(4).trim();
  if (!args) return { cwd: process.cwd(), host: undefined };

  const hostMatch = args.match(/--host\s+(\S+)/);
  const host = hostMatch?.[1];
  const rest = args.replace(/--host\s+\S+/, '').trim();
  const cwd = rest || process.cwd();

  return { cwd, host };
}

// ── Command handler ─────────────────────────────────────────────────

function handleCommand(command: string, threadTs: string, msgTs: string): void {
  if (processingThreads.has(threadTs)) {
    log.debug(`Thread ${threadTs} already processing, skipping`);
    return;
  }
  processingThreads.add(threadTs);

  (async () => {
    log.info(`[${threadTs}] Command: ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}`);
    await addReaction(channelId, msgTs, 'brain');

    const placeholderTs = await postMessage(channelId, '⏳ Thinking...', threadTs);
    cortexMessageTs.add(placeholderTs);

    const history = getOrCreate(threadTs);
    history.push({ role: 'user', content: command });

    try {
      const ctx = { channel: channelId, threadTs };
      const reply = await agentLoop(history, ctx, async (status) => {
        await updateMessage(channelId, placeholderTs, status);
      });

      log.info(`[${threadTs}] Reply: ${reply.slice(0, 200)}${reply.length > 200 ? '...' : ''}`);

      const tagged = CORTEX_TAG + reply;
      if (tagged.length > 39000) {
        await updateMessage(channelId, placeholderTs, tagged.slice(0, 39000) + '\n\n... (truncated)');
      } else {
        await updateMessage(channelId, placeholderTs, tagged);
      }

      save(threadTs);
      await addReaction(channelId, msgTs, 'white_check_mark');
    } catch (err) {
      const errMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[${threadTs}] ${errMsg}`);
      await updateMessage(channelId, placeholderTs, CORTEX_TAG + `❌ ${errMsg}`);
      save(threadTs);
    }

    activeThreads.add(threadTs);
    threadLastSeen.set(threadTs, msgTs);
    touchThread(threadTs);
    processingThreads.delete(threadTs);
  })().catch((err) => {
    log.error(`[${threadTs}] Unhandled: ${err}`);
    activeThreads.add(threadTs);
    touchThread(threadTs);
    processingThreads.delete(threadTs);
  });
}

// ── Poll loops ──────────────────────────────────────────────────────

async function pollTopLevel(): Promise<void> {
  const messages = await getHistory(channelId, lastTopLevelTs || undefined);
  if (messages.length === 0) return;

  const sorted = [...messages].reverse();
  lastTopLevelTs = sorted[sorted.length - 1].ts;

  for (const msg of sorted) {
    if (msg.subtype || msg.bot_id) continue;
    if (msg.user !== config.slackUserId) continue;
    if (cortexMessageTs.has(msg.ts)) continue;
    if (!msg.text?.startsWith(config.trigger)) continue;

    const command = msg.text.slice(config.trigger.length).trim();
    if (!command) continue;

    // Help
    if (command === 'help') {
      const helpMsg =
        `*Available commands:*\n\n` +
        `\`!cortex <task>\` — Ask me anything (I'll handle it or delegate)\n` +
        `\`!cortex chat [cwd] [--host <host>]\` — Start an interactive ACP session\n` +
        `\`!cortex sessions\` — List active ACP sessions\n` +
        `\`!cortex help\` — Show this help\n\n` +
        `*In any thread:*\n` +
        `\`close\` or \`!cortex close\` — Stop monitoring this thread\n` +
        `_(threads auto-close after 30 min of inactivity)_`;
      await postMessage(channelId, CORTEX_TAG + helpMsg, msg.ts);
      continue;
    }

    // Sessions
    if (command === 'sessions') {
      const active = listSessions();
      if (active.length === 0) {
        await postMessage(channelId, CORTEX_TAG + 'No active ACP sessions.', msg.ts);
      } else {
        const lines = active.map((s) =>
          `• \`${s.agent}\` pid=\`${s.pid}\` session=\`${s.sessionId}\`${s.host ? ` host=\`${s.host}\`` : ''} cwd=\`${s.cwd}\` ${s.busy ? '🔄 busy' : '💤 idle'} (${s.uptime}s)`
        );
        await postMessage(channelId, CORTEX_TAG + `*Active ACP sessions (${active.length}):*\n${lines.join('\n')}`, msg.ts);
      }
      continue;
    }

    // ACP chat — !cortex chat [cwd] [--host <host>]
    if (command === 'chat' || command.startsWith('chat ')) {
      const { cwd, host } = parseChatCommand(command);
      const result = await startSession(cwd, channelId, msg.ts, host);
      const msgTs2 = await postMessage(channelId, CORTEX_TAG + result, msg.ts);
      cortexMessageTs.add(msgTs2);
      if (isAcpSession(msg.ts)) {
        activeThreads.add(msg.ts);
        threadLastSeen.set(msg.ts, msg.ts);
        touchThread(msg.ts);
      }
      continue;
    }

    log.info(`New command detected: ${msg.ts}`);
    handleCommand(command, msg.ts, msg.ts);
  }
}

async function pollThreads(): Promise<void> {
  for (const threadTs of activeThreads) {
    if (processingThreads.has(threadTs)) continue;
    const oldest = threadLastSeen.get(threadTs);
    try {
      const replies = await getReplies(channelId, threadTs, oldest);

      const newReplies = replies.filter((r) =>
        r.ts !== oldest &&
        r.ts !== threadTs &&
        r.user === config.slackUserId &&
        !r.bot_id &&
        !r.subtype &&
        r.text &&
        !cortexMessageTs.has(r.ts),
      );

      for (const reply of newReplies) {
        log.info(`Thread reply in ${threadTs}: ${reply.ts}`);
        threadLastSeen.set(threadTs, reply.ts);
        touchThread(threadTs);

        // Close command
        if (reply.text === `${config.trigger} close` || reply.text === 'close') {
          if (isAcpSession(threadTs)) await endSession(threadTs);
          closeThread(threadTs);
          await postMessage(channelId, CORTEX_TAG + '👋 Thread closed.', threadTs);
          break;
        }

        // Block ACP session starts inside existing threads
        if (reply.text === `${config.trigger} chat` || reply.text!.startsWith(`${config.trigger} chat `)) {
          const warnTs = await postMessage(
            channelId,
            CORTEX_TAG + '⚠️ ACP sessions can only be started from a fresh top-level message. Try sending `!cortex chat` as a new message.',
            threadTs,
          );
          cortexMessageTs.add(warnTs);
          continue;
        }

        // Route ACP session messages
        if (isAcpSession(threadTs)) {
          if (isAcpBusy(threadTs)) {
            await addReaction(channelId, reply.ts, 'hourglass_flowing_sand');
            continue;
          }
          await addReaction(channelId, reply.ts, 'robot_face');
          let promptText = reply.text!;
          if (promptText.startsWith('$/')) promptText = promptText.slice(1);
          const result = await sendPrompt(threadTs, promptText, channelId);
          if (result.statusMsgTs) cortexMessageTs.add(result.statusMsgTs);
          log.info(`[ACP ${threadTs}] prompt done: ${result.stopReason}`);
          continue;
        }

        handleCommand(reply.text!, threadTs, reply.ts);
      }
    } catch {
      log.warn(`Removing stale thread: ${threadTs}`);
      activeThreads.delete(threadTs);
      threadLastSeen.delete(threadTs);
    }
  }
}

async function reportCompletedTasks(): Promise<void> {
  const completed = getNewlyCompletedTasks();
  for (const meta of completed) {
    const status = meta.exitCode === 0 ? '✅ completed' : `❌ failed (exit ${meta.exitCode})`;
    const elapsed = Math.round((Date.now() - meta.startedAt) / 1000);
    let tail = '';
    try {
      const raw = readFileSync(meta.logFile, 'utf-8');
      const lines = sanitizeOutput(raw);
      tail = lines.slice(-50).join('\n');
    } catch { tail = '(no output)'; }
    if (tail.length > 3000) tail = '...\n' + tail.slice(-3000);
    const msg = `${CORTEX_TAG}🏁 Agent task ${status} (${elapsed}s)\n\`\`\`\n${tail}\n\`\`\`\nFull log: \`${meta.logFile}\``;
    const msgTs = await postMessage(meta.channel, msg, meta.threadTs);
    cortexMessageTs.add(msgTs);
    log.info(`Reported task ${meta.taskId}: ${status}`);
  }
}

// ── Main poll loop ──────────────────────────────────────────────────

let consecutiveErrors = 0;

async function poll(): Promise<void> {
  try {
    await pollTopLevel();
    await pollThreads();
    await reportCompletedTasks();
    expireStaleThreads();
    consecutiveErrors = 0;
  } catch (err) {
    consecutiveErrors++;
    log.error(`Poll error: ${err instanceof Error ? err.message : err}`);
    if (consecutiveErrors > 2) {
      const delay = Math.min(config.pollIntervalMs * 2 ** consecutiveErrors, 120_000);
      log.warn(`Backing off: next poll in ${delay / 1000}s (${consecutiveErrors} consecutive errors)`);
    }
  }
}

// ── Init & main ─────────────────────────────────────────────────────

async function init(): Promise<void> {
  log.info('Cortex starting...');
  cleanupIfNeeded();
  lastTopLevelTs = String(Date.now() / 1000);
  log.info(`Ignoring all messages before ts=${lastTopLevelTs}`);
  channelId = await openConversation(config.slackUserId);
  log.info(`Monitoring self-DM channel: ${channelId}`);
  log.info(`Trigger: "${config.trigger}" | Poll: ${config.pollIntervalMs}ms | Model: ${config.model}`);
}

process.on('SIGINT', () => { log.info('Shutting down...'); saveAll(); process.exit(0); });
process.on('SIGTERM', () => { log.info('Shutting down...'); saveAll(); process.exit(0); });

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  await init();
  const schedulePoll = () => {
    const delay = consecutiveErrors > 0
      ? Math.min(config.pollIntervalMs * 2 ** consecutiveErrors, 120_000)
      : config.pollIntervalMs;
    setTimeout(async () => {
      await poll();
      schedulePoll();
    }, delay);
  };
  schedulePoll();
  log.info('Cortex is running. Waiting for commands...');
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
