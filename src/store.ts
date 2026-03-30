import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { log } from './logger.js';

const CONVO_DIR = join(homedir(), '.cortex', 'conversations');
const MAX_DIR_SIZE_BYTES = 500 * 1024 * 1024;

const conversations = new Map<string, Array<{ role: string; content: string }>>();

function ensureDir(): void {
  if (!existsSync(CONVO_DIR)) mkdirSync(CONVO_DIR, { recursive: true });
}

function filePath(threadTs: string): string {
  return join(CONVO_DIR, `${threadTs.replace('.', '_')}.json`);
}

export function getOrCreate(threadTs: string): Array<{ role: string; content: string }> {
  if (conversations.has(threadTs)) return conversations.get(threadTs)!;

  ensureDir();
  const fp = filePath(threadTs);
  let messages: Array<{ role: string; content: string }> = [];
  if (existsSync(fp)) {
    try {
      messages = JSON.parse(readFileSync(fp, 'utf-8'));
    } catch {
      log.warn(`Corrupted conversation file: ${fp}, starting fresh`);
    }
  }
  conversations.set(threadTs, messages);
  return messages;
}

export function save(threadTs: string): void {
  const messages = conversations.get(threadTs);
  if (!messages) return;
  ensureDir();
  writeFileSync(filePath(threadTs), JSON.stringify(messages, null, 2));
}

export function saveAll(): void {
  for (const threadTs of conversations.keys()) save(threadTs);
}

export function cleanupIfNeeded(): void {
  ensureDir();
  const files = readdirSync(CONVO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const fullPath = join(CONVO_DIR, f);
      return { name: f, path: fullPath, stat: statSync(fullPath) };
    })
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

  const totalBytes = files.reduce((sum, f) => sum + f.stat.size, 0);
  if (totalBytes <= MAX_DIR_SIZE_BYTES) return;

  let freed = 0;
  const target = totalBytes - MAX_DIR_SIZE_BYTES;
  for (const f of files) {
    if (freed >= target) break;
    freed += f.stat.size;
    unlinkSync(f.path);
    log.info(`Cleaned up old conversation: ${f.name}`);
  }
}
