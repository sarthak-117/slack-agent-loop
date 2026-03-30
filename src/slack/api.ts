import axios from 'axios';
import { config } from '../config.js';

const client = axios.create({
  baseURL: 'https://slack.com/api',
  headers: {
    Authorization: `Bearer ${config.slackBotToken}`,
    'Content-Type': 'application/json',
  },
});

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

function check(data: { ok: boolean; error?: string }): void {
  if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);
}

export async function postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
  const { data } = await client.post('/chat.postMessage', {
    channel,
    text,
    ...(threadTs && { thread_ts: threadTs }),
  });
  check(data);
  return data.ts as string;
}

export async function updateMessage(channel: string, ts: string, text: string): Promise<void> {
  const { data } = await client.post('/chat.update', { channel, ts, text });
  check(data);
}

export async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  const { data } = await client.post('/reactions.add', { channel, timestamp: ts, name });
  check(data);
}

export async function getHistory(
  channel: string,
  oldest?: string,
): Promise<SlackMessage[]> {
  const { data } = await client.get('/conversations.history', {
    params: { channel, ...(oldest && { oldest }) },
  });
  check(data);
  return data.messages as SlackMessage[];
}

export async function getReplies(
  channel: string,
  ts: string,
  oldest?: string,
): Promise<SlackMessage[]> {
  const { data } = await client.get('/conversations.replies', {
    params: { channel, ts, ...(oldest && { oldest }) },
  });
  check(data);
  return data.messages as SlackMessage[];
}

export async function openConversation(userId: string): Promise<string> {
  const { data } = await client.post('/conversations.open', { users: userId });
  check(data);
  return data.channel.id as string;
}
