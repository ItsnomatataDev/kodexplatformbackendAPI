ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS client_message_id uuid NULL;

COMMENT ON COLUMN chat.messages.client_message_id IS
  'Optional client-generated UUID. Unique per (conversation_id, sender_id) when set.';

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_message_idempotency_uidx
  ON chat.messages (conversation_id, sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
