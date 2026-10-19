import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { db } from '../src/db/pool.js';
import { PostgresTicketStore } from '../src/tickets/postgres-store.js';

test('Postgres ticket assignment and note attribution survive missing profiles', {
  skip: process.env.RUN_TICKET_DB_TESTS !== 'true',
}, async () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const store = new PostgresTicketStore();
  try {
    await db.query('INSERT INTO organizations.organizations(id,name,slug) VALUES($1,$2,$3)', [organizationId, 'Ticket regression', organizationId]);
    await db.query("INSERT INTO identity.users(id,email,account_status) VALUES($1,'tech@example.test','active')", [userId]);
    const ticket = await store.create({ organizationId, userId, createdBy: userId, assignedTo: userId,
      category: 'hardware', subject: 'Profile missing', description: 'Assignment regression' });
    assert.equal(ticket.assignedName, 'tech@example.test');
    assert.ok(ticket.assignedAt instanceof Date);
    assert.ok(ticket.linkedCardId);
    const note = await store.createComment({ organizationId, ticketId: ticket.id, authorId: userId,
      body: 'Internal note', visibility: 'internal' });
    assert.equal(note?.authorName, 'tech@example.test');
    assert.equal((await store.listComments(organizationId, ticket.id))[0]?.authorName, 'tech@example.test');
    const unchanged = await store.update(organizationId, ticket.id, { assignedTo: userId }, userId);
    assert.equal(unchanged?.assignedAt?.toISOString(), ticket.assignedAt.toISOString());
    assert.equal(unchanged?.linkedCardId, ticket.linkedCardId);
    await db.query("INSERT INTO identity.user_profiles(user_id,full_name) VALUES($1,'  ')", [userId]);
    assert.equal((await store.getById(organizationId, ticket.id))?.assignedName, 'tech@example.test');
    assert.equal((await store.listComments(organizationId, ticket.id))[0]?.authorName, 'tech@example.test');
    await db.query("UPDATE identity.user_profiles SET full_name='Test Technician' WHERE user_id=$1", [userId]);
    assert.equal((await store.getById(organizationId, ticket.id))?.assignedName, 'Test Technician');
    assert.equal((await store.listComments(organizationId, ticket.id))[0]?.authorName, 'Test Technician');
    assert.equal((await store.getById(randomUUID(), ticket.id)), null);
    const cleared = await store.update(organizationId, ticket.id, { assignedTo: null }, userId);
    assert.equal(cleared?.assignedAt, null);
    assert.equal(cleared?.assignedName, null);
  } finally {
    await db.query('DELETE FROM organizations.organizations WHERE id=$1', [organizationId]);
    await db.query('DELETE FROM identity.users WHERE id=$1', [userId]);
    await db.end();
  }
});
