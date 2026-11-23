import { extractAssistantReply, type InferenceChatMessage } from './conversation.js';
import type { llmChatCompletions } from '../kodex/llm-client.js';

const MAX_PAYLOAD_CHARS = 12_000;

export type AutomationFlowForRun = {
  name: string;
  description: string | null;
  instructions: string | null;
};

export function automationRunMessages(
  flow: AutomationFlowForRun,
  payload: Record<string, unknown>,
): InferenceChatMessage[] {
  const instructions =
    flow.instructions?.trim() || flow.description?.trim() || `Run the "${flow.name}" automation.`;
  const payloadText = JSON.stringify(payload ?? {}, null, 2).slice(0, MAX_PAYLOAD_CHARS);
  return [
    {
      role: 'system',
      content:
        'You are KODEX, the automation engine for this organization. Carry out the automation instructions using only the run input provided. Return the finished result as plain text. If the input is missing something the instructions need, say exactly what is missing instead of inventing it.',
    },
    {
      role: 'user',
      content: `Automation: ${flow.name}\n\nInstructions:\n${instructions}\n\nRun input (JSON):\n${payloadText}`,
    },
  ];
}

export async function executeAutomationWithKodex(
  complete: typeof llmChatCompletions,
  flow: AutomationFlowForRun,
  payload: Record<string, unknown>,
) {
  const data = await complete({ messages: automationRunMessages(flow, payload) });
  const output = extractAssistantReply(data);
  if (!output) {
    throw new Error('KODEX returned an empty result.');
  }
  return output;
}
