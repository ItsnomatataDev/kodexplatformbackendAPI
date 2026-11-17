import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationRunMessages, executeAutomationWithKodex } from '../src/ai/automation-run.js';
import { inferenceTurnsFromHistory } from '../src/ai/conversation.js';

const flow = { name: 'Daily digest', description: 'Summarise the day', instructions: null };

test('automation run prompt uses instructions, then description, and includes the payload', () => {
  const messages = automationRunMessages(flow, { tasks: 3 });
  assert.equal(messages[0]?.role, 'system');
  assert.match(messages[1]?.content ?? '', /Summarise the day/);
  assert.match(messages[1]?.content ?? '', /"tasks": 3/);

  const withInstructions = automationRunMessages({ ...flow, instructions: 'List blockers' }, {});
  assert.match(withInstructions[1]?.content ?? '', /List blockers/);
  assert.doesNotMatch(withInstructions[1]?.content ?? '', /Summarise the day/);
});

test('automation run returns the KODEX reply and rejects an empty one', async () => {
  const reply = (content: string) => async () => ({ choices: [{ message: { content } }] });
  assert.equal(await executeAutomationWithKodex(reply(' Done. '), flow, {}), 'Done.');
  await assert.rejects(executeAutomationWithKodex(reply('  '), flow, {}), /empty result/);
});

test('only the latest user turn with documents carries document text to KODEX', () => {
  const doc = (text: string) => ({ documents: [{ name: 'report.pdf', text }] });
  const turns = inferenceTurnsFromHistory(
    [
      { id: '1', role: 'user', content: 'Old file', metadata: doc('OLD TEXT'), created_at: '2026-01-01' },
      { id: '2', role: 'assistant', content: 'Read it', created_at: '2026-01-02' },
      { id: '3', role: 'user', content: 'New file', metadata: doc('NEW TEXT'), created_at: '2026-01-03' },
      { id: '4', role: 'assistant', content: 'Read that too', created_at: '2026-01-04' },
      { id: '5', role: 'user', content: 'What is in it?', created_at: '2026-01-05' },
    ],
    'system',
  );
  const all = turns.map((turn) => turn.content).join('\n');
  assert.match(all, /NEW TEXT/);
  assert.doesNotMatch(all, /OLD TEXT/);
  assert.equal(turns.at(-1)?.content, 'What is in it?');
});
