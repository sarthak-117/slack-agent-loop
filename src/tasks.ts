import { spawn } from 'child_process';
import { mkdirSync, existsSync, createWriteStream } from 'fs';
import { join } from 'path';
import { log } from './logger.js';

const TASK_DIR = '/tmp/cortex-agents';

export interface TaskMeta {
  taskId: string;
  threadTs: string;
  channel: string;
  logFile: string;
  startedAt: number;
  exitCode: number | null;
  pid: number;
}

const tasks = new Map<string, TaskMeta>();
const reported = new Set<string>();

function ensureDir(): void {
  if (!existsSync(TASK_DIR)) mkdirSync(TASK_DIR, { recursive: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function spawnAgentTask(
  command: string,
  args: string[],
  cwd: string,
  threadTs: string,
  channel: string,
): TaskMeta {
  ensureDir();
  const taskId = `task-${Date.now()}`;
  const logFile = join(TASK_DIR, `${taskId}.log`);

  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const logStream = createWriteStream(logFile);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const meta: TaskMeta = {
    taskId,
    threadTs,
    channel,
    logFile,
    startedAt: Date.now(),
    exitCode: null,
    pid: child.pid!,
  };

  tasks.set(taskId, meta);

  child.on('exit', (code) => {
    meta.exitCode = code ?? -1;
    logStream.close();
    log.info(`Task ${taskId} exited with code ${code}`);
  });

  child.unref();
  log.info(`Spawned ${taskId} (PID ${meta.pid})`);
  return meta;
}

export function getNewlyCompletedTasks(): TaskMeta[] {
  const completed: TaskMeta[] = [];

  for (const [id, meta] of tasks) {
    if (reported.has(id)) continue;

    if (meta.exitCode === null && !isAlive(meta.pid)) {
      meta.exitCode = -1;
    }

    if (meta.exitCode !== null) {
      reported.add(id);
      completed.push(meta);
    }
  }

  return completed;
}

export function getTaskStatus(taskId: string): TaskMeta | undefined {
  const meta = tasks.get(taskId);
  if (!meta) return undefined;

  if (meta.exitCode === null && !isAlive(meta.pid)) {
    meta.exitCode = -1;
  }

  return meta;
}
