import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type ToolConfiguration,
  type ToolInputSchema,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { config } from './config.js';
import { tools, executeTool, type ToolContext } from './tools.js';

const client = new BedrockRuntimeClient({ region: config.awsRegion });

const SYSTEM_PROMPT = `You are Cortex, a personal dev assistant running on the user's machine.
You have access to their shell, filesystem, and can delegate complex tasks to background agent sessions.

## When to handle directly (shell, file_read, file_write)
- Quick info: git status, disk usage, process lists, reading a file, running a command
- Single-file edits or small targeted changes
- Running tests/builds and reporting results
- Any task completable in 1-3 tool calls

## When to delegate (spawn_agent)
- Multi-file changes, refactoring, feature implementation
- Tasks that would take more than 3 tool calls
- Complex or ambiguous multi-step work

After calling spawn_agent, report the taskId and status to the user and stop.
The agent runs in the background — your job is done once you've spawned it.

## Rules
- If a tool call fails, report the failure. Never fabricate output.
- If you don't know something, say so.
- Be concise and direct.`;

function buildToolConfig(): ToolConfiguration {
  return {
    tools: tools.map((t) => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.input_schema } as ToolInputSchema,
      },
    })),
  };
}

const systemPrompt: SystemContentBlock[] = [{ text: SYSTEM_PROMPT }];

export type SimpleMessage = { role: string; content: string };

function toBedrockMessages(msgs: SimpleMessage[]): Message[] {
  return msgs.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: [{ text: m.content }],
  }));
}

export async function agentLoop(
  history: SimpleMessage[],
  ctx: ToolContext,
  onStatus?: (text: string) => Promise<void>,
): Promise<string> {
  const toolConfig = buildToolConfig();
  const messages: Message[] = toBedrockMessages(history);

  for (let i = 0; i < config.maxIterations; i++) {
    const command = new ConverseCommand({
      modelId: config.model,
      system: systemPrompt,
      messages,
      toolConfig,
      inferenceConfig: { maxTokens: 16384 },
    });

    const res = await client.send(command);
    const output = res.output;

    if (!output?.message) {
      return '(no response from model)';
    }

    messages.push(output.message);

    if (res.stopReason === 'end_turn') {
      return extractText(output.message.content ?? []);
    }

    const toolUses = (output.message.content ?? []).filter(
      (b): b is ContentBlock.ToolUseMember => 'toolUse' in b,
    );

    if (toolUses.length === 0) {
      return extractText(output.message.content ?? []);
    }

    if (onStatus) {
      for (const block of toolUses) {
        const tu = block.toolUse;
        if (tu?.name) {
          await onStatus(`🔧 ${tu.name}: ${JSON.stringify(tu.input).slice(0, 100)}...`);
        }
      }
    }

    const toolResults: ContentBlock[] = toolUses.map((block) => {
      const tu = block.toolUse!;
      const result = executeTool(
        tu.name!,
        (tu.input ?? {}) as Record<string, string>,
        ctx,
      );
      return {
        toolResult: {
          toolUseId: tu.toolUseId!,
          content: [{ text: result }],
        },
      };
    });

    messages.push({ role: 'user', content: toolResults });
  }

  return '⚠️ Hit max iterations. Stopping.';
}

function extractText(content: ContentBlock[]): string {
  for (const block of content) {
    if ('text' in block && block.text) return block.text;
  }
  return '(no response)';
}
