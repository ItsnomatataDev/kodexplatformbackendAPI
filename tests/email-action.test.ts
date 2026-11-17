import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveEmailAction } from '../src/email/email-action.js';

const origin = 'https://codex.itsnomatata.com';
const internalReviewHtml = `
  <p>Ada submitted "March schedule" for internal review.</p>
  <a href="https://codex.itsnomatata.com/internal-preview/abc%20123?x=1&amp;y=2" class="button">Open review link</a>
  <p><a href="https://codex.itsnomatata.com">https://codex.itsnomatata.com</a></p>`;

test('recovers the workspace button link and label from client email html', () => {
  assert.deepEqual(resolveEmailAction({ html: internalReviewHtml }, origin), {
    actionUrl: 'https://codex.itsnomatata.com/internal-preview/abc%20123?x=1&y=2',
    actionLabel: 'Open review link',
  });
});

test('explicit action url wins and relative paths resolve against the app origin', () => {
  assert.deepEqual(
    resolveEmailAction({ actionUrl: '/it/support/42', actionLabel: 'Open ticket', html: internalReviewHtml }, origin),
    { actionUrl: 'https://codex.itsnomatata.com/it/support/42', actionLabel: 'Open ticket' },
  );
});

test('links outside the workspace origin are never used as the button', () => {
  assert.equal(
    resolveEmailAction({ html: '<a href="https://evil.example/login" class="button">Sign in</a>' }, origin),
    null,
  );
  assert.equal(resolveEmailAction({ actionUrl: 'https://codex.itsnomatata.com.evil.example/x' }, origin), null);
  assert.equal(resolveEmailAction({ actionUrl: 'javascript:alert(1)' }, origin), null);
  assert.equal(resolveEmailAction({ html: '<a href="https://codex.itsnomatata.com/" class="button">Home</a>' }, origin), null);
});
