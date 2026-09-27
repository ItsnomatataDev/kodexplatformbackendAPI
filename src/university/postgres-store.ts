import { db } from '../db/pool.js';
import { NotFoundError } from '../http/errors.js';

export class PostgresUniversityStore {
  async listModules() {
    const result = await db.query(
      `SELECT * FROM university.modules WHERE is_active = TRUE ORDER BY sort_order ASC`,
    );
    return result.rows;
  }

  async listTopics(moduleId?: string) {
    if (moduleId) {
      const result = await db.query(
        `SELECT * FROM university.topics WHERE module_id = $1 ORDER BY sort_order ASC`,
        [moduleId],
      );
      return result.rows;
    }
    const result = await db.query(`SELECT * FROM university.topics ORDER BY sort_order ASC`);
    return result.rows;
  }

  async listProgress(organizationId: string, userId: string) {
    const result = await db.query(
      `SELECT * FROM university.topic_progress WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    return result.rows.map((row) => ({
      ...row,
      completed_at: (row.completed_at as Date).toISOString(),
    }));
  }

  async completeTopic(organizationId: string, userId: string, topicId: string, note?: string | null) {
    const topic = await db.query(`SELECT * FROM university.topics WHERE id = $1 LIMIT 1`, [topicId]);
    if (!topic.rows[0]) throw new NotFoundError('TOPIC_NOT_FOUND', 'Topic not found.');
    const result = await db.query(
      `INSERT INTO university.topic_progress (
         organization_id, user_id, topic_id, module_id, completed_at, self_attested, attestation_note
       ) VALUES ($1,$2,$3,$4,NOW(),TRUE,$5)
       ON CONFLICT (user_id, topic_id) DO UPDATE
       SET attestation_note = COALESCE(EXCLUDED.attestation_note, university.topic_progress.attestation_note),
           completed_at = university.topic_progress.completed_at
       RETURNING *`,
      [organizationId, userId, topicId, topic.rows[0].module_id, note ?? null],
    );
    return {
      topic_id: result.rows[0].topic_id,
      module_id: result.rows[0].module_id,
      completed_at: (result.rows[0].completed_at as Date).toISOString(),
    };
  }

  async listOrgProgress(organizationId: string) {
    const result = await db.query(
      `SELECT tp.user_id,
              p.full_name,
              u.email,
              count(*)::int AS completed_topics,
              max(tp.completed_at) AS last_completed_at
       FROM university.topic_progress tp
       LEFT JOIN identity.user_profiles p ON p.user_id = tp.user_id
       LEFT JOIN identity.users u ON u.id = tp.user_id
       WHERE tp.organization_id = $1
       GROUP BY tp.user_id, p.full_name, u.email
       ORDER BY completed_topics DESC, p.full_name ASC NULLS LAST, tp.user_id ASC
       LIMIT 200`,
      [organizationId],
    );
    const totalTopics = await db.query(`SELECT count(*)::int AS total FROM university.topics`);
    const total = totalTopics.rows[0]?.total ?? 0;
    return result.rows.map((row) => ({
      user_id: row.user_id,
      full_name: row.full_name ?? 'Unknown',
      email: row.email ?? null,
      office_name: null,
      primary_role: null,
      completed_topics: row.completed_topics,
      total_topics: total,
      progress_pct: total ? Math.round((row.completed_topics / total) * 100) : 0,
      last_completed_at: row.last_completed_at ? (row.last_completed_at as Date).toISOString() : null,
      module_breakdown: [],
    }));
  }
}
