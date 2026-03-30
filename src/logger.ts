const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;
const current: Level = (process.env.LOG_LEVEL as Level) || 'info';

function fmt(level: string, msg: string): string {
  return `${new Date().toISOString().slice(11, 23)} ${level} ${msg}`;
}

export const log = {
  debug: (msg: string) => { if (LEVELS[current] <= 0) console.debug(fmt('🔍 [DEBUG]', msg)); },
  info: (msg: string) => { if (LEVELS[current] <= 1) console.log(fmt('📋 [INFO]', msg)); },
  warn: (msg: string) => { if (LEVELS[current] <= 2) console.warn(fmt('⚠️  [WARN]', msg)); },
  error: (msg: string) => { if (LEVELS[current] <= 3) console.error(fmt('❌ [ERROR]', msg)); },
};
