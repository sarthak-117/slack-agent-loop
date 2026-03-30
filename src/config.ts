import 'dotenv/config';

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  slackBotToken: required('SLACK_BOT_TOKEN'),
  slackUserId: required('SLACK_USER_ID'),
  agentCommand: process.env.AGENT_COMMAND ?? 'claude',
  agentArgs: process.env.AGENT_ARGS ?? '',
  agentCwd: process.env.AGENT_CWD ?? process.cwd(),
  model: process.env.CORTEX_MODEL ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  maxIterations: Number(process.env.CORTEX_MAX_ITERATIONS ?? 20),
  pollIntervalMs: Number(process.env.CORTEX_POLL_INTERVAL_MS ?? 3000),
  trigger: process.env.CORTEX_TRIGGER ?? '!cortex',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
};
