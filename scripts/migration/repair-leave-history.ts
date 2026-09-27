import "dotenv/config";
import { db } from "../../src/db/pool";



const ORG_ID = "ae975c01-c044-4c5d-b5b5-4b6a06b55957";

const OFFICES = {
  IT_NO_MATATA: "787930f0-2974-4e98-9ae7-a442d0657add",
  THREE_LITTLE_BIRDS: "df203192-8a77-4109-8672-f8ea9562155f",
} as const;

const MISSING_REQUESTS = [
  {
    id: "1b2afe7a-b82b-4338-bfad-dfbfbe87da0f",
    organization_id: ORG_ID,
    user_id: "e2de9e72-b6d1-4c34-ace2-1151bc353409",
    leave_type_id: null,
    start_date: "2026-08-28",
    end_date: "2026-08-28",
    requested_days: 1,
    reason: "",
    status: "pending",
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    metadata: {},
    created_at: "2026-08-26T13:31:15.855125+00:00",
    updated_at: "2026-08-26T13:31:15.855125+00:00",
    request_department: "IT's No Matata",
    request_role: "media_team",
    balance_deducted_at: null,
    office: "IT's No Matata",
    admin_notes: null,
    edited_by: null,
    edited_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    office_id: OFFICES.IT_NO_MATATA,
  },
  {
    id: "d09877de-afe2-46ce-a517-0ded56c459b7",
    organization_id: ORG_ID,
    user_id: "e2de9e72-b6d1-4c34-ace2-1151bc353409",
    leave_type_id: null,
    start_date: "2026-09-11",
    end_date: "2026-09-11",
    requested_days: 1,
    reason: "Religious",
    status: "pending",
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    metadata: {},
    created_at: "2026-08-26T13:27:06.31414+00:00",
    updated_at: "2026-08-26T13:27:06.31414+00:00",
    request_department: "IT's No Matata",
    request_role: "media_team",
    balance_deducted_at: null,
    office: "IT's No Matata",
    admin_notes: null,
    edited_by: null,
    edited_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    office_id: OFFICES.IT_NO_MATATA,
  },
] as const;

async function main() {
 const client = await db.connect();

  try {
    await client.query("BEGIN");

    console.log("========================================");
    console.log("KODE LEAVE HISTORY REPAIR");
    console.log("========================================");
    console.log("");
    console.log("Supabase: READ ONLY");
    console.log("Balances: UNTOUCHED");
    console.log("Approvals: UNTOUCHED");
    console.log("");

 
    const orgResult = await client.query(
      `
      SELECT id, name, slug
      FROM organizations.organizations
      WHERE id = $1
      `,
      [ORG_ID],
    );

    if (orgResult.rowCount !== 1) {
      throw new Error(`Organization ${ORG_ID} was not found.`);
    }

    console.log(
      `Organization verified: ${orgResult.rows[0].name} (${orgResult.rows[0].slug})`,
    );

   
    const officeResult = await client.query(
      `
      SELECT id, name, slug
      FROM organizations.offices
      WHERE id = ANY($1::uuid[])
      ORDER BY name
      `,
      [[OFFICES.IT_NO_MATATA, OFFICES.THREE_LITTLE_BIRDS]],
    );

    if (officeResult.rowCount !== 2) {
      throw new Error(
        `Expected 2 offices but found ${officeResult.rowCount}.`,
      );
    }

    for (const office of officeResult.rows) {
      console.log(`Office verified: ${office.name} (${office.slug})`);
    }

   
    const userIds = [
      ...new Set(MISSING_REQUESTS.map((request) => request.user_id)),
    ];

    const userResult = await client.query(
      `
      SELECT id, email
      FROM identity.users
      WHERE id = ANY($1::uuid[])
      `,
      [userIds],
    );

    if (userResult.rowCount !== userIds.length) {
      throw new Error(
        `Expected ${userIds.length} users but found ${userResult.rowCount}.`,
      );
    }

    for (const user of userResult.rows) {
      console.log(`User verified: ${user.email}`);
    }

  
    for (const request of MISSING_REQUESTS) {
      const result = await client.query(
        `
        INSERT INTO leave.requests (
          id,
          organization_id,
          user_id,
          leave_type_id,
          office_id,
          start_date,
          end_date,
          requested_days,
          reason,
          status,
          approved_by,
          approved_at,
          rejection_reason,
          request_department,
          request_role,
          office,
          balance_deducted_at,
          admin_notes,
          edited_by,
          edited_at,
          cancelled_at,
          cancelled_by,
          cancellation_reason,
          metadata,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17,
          $18,
          $19,
          $20,
          $21,
          $22,
          $23,
          $24::jsonb,
          $25,
          $26
        )
        ON CONFLICT (id) DO NOTHING
        `,
        [
          request.id,
          request.organization_id,
          request.user_id,
          request.leave_type_id,
          request.office_id,
          request.start_date,
          request.end_date,
          request.requested_days,
          request.reason,
          request.status,
          request.approved_by,
          request.approved_at,
          request.rejection_reason,
          request.request_department,
          request.request_role,
          request.office,
          request.balance_deducted_at,
          request.admin_notes,
          request.edited_by,
          request.edited_at,
          request.cancelled_at,
          request.cancelled_by,
          request.cancellation_reason,
          JSON.stringify(request.metadata),
          request.created_at,
          request.updated_at,
        ],
      );

      if (result.rowCount === 1) {
        console.log(`INSERTED: ${request.id}`);
      } else {
        console.log(`ALREADY EXISTS: ${request.id}`);
      }
    }


  const backfillResult = await client.query(`
  UPDATE leave.requests
  SET
    office_id = CASE
      WHEN lower(trim(office)) IN (
        'it''s no matata',
        'itsnomatata',
        'it''s nomatata'
      )
        THEN '${OFFICES.IT_NO_MATATA}'::uuid

      WHEN lower(trim(office)) = 'three little birds'
        THEN '${OFFICES.THREE_LITTLE_BIRDS}'::uuid

      ELSE office_id
    END,
    updated_at = NOW()
  WHERE organization_id = '${ORG_ID}'::uuid
    AND office_id IS NULL
    AND (
      lower(trim(office)) IN (
        'it''s no matata',
        'itsnomatata',
        'it''s nomatata'
      )
      OR lower(trim(office)) = 'three little birds'
    )
`);

    console.log(`OFFICE IDs BACKFILLED: ${backfillResult.rowCount}`);


    const unresolvedResult = await client.query(`
      SELECT
        id,
        office,
        request_department,
        status
      FROM leave.requests
      WHERE office_id IS NULL
        AND (
          office IS NOT NULL
          OR request_department IS NOT NULL
        )
      ORDER BY created_at
    `);

    if (unresolvedResult.rowCount !== 0) {
      console.log("");
      console.log("WARNING: Requests still have NULL office_id:");
      console.table(unresolvedResult.rows);
    } else {
      console.log("All Leave requests now have an office_id.");
    }

  
    const restoredResult = await client.query(
      `
      SELECT
        id,
        user_id,
        start_date,
        end_date,
        requested_days,
        status,
        office,
        office_id,
        balance_deducted_at,
        created_at
      FROM leave.requests
      WHERE id = ANY($1::uuid[])
      ORDER BY start_date
      `,
      [[...MISSING_REQUESTS.map((request) => request.id)]],
    );

    console.log("");
    console.log("RESTORED REQUEST VERIFICATION:");
    console.table(restoredResult.rows);


    const balanceResult = await client.query(
      `
      SELECT
        id,
        email,
        leave_days_total,
        leave_days_remaining
      FROM identity.user_profiles p
      JOIN identity.users u ON u.id = p.user_id
      WHERE p.user_id = $1
      `,
      [MISSING_REQUESTS[0].user_id],
    );

    console.log("");
    console.log("USER BALANCE LEFT UNTOUCHED:");
    console.table(balanceResult.rows);

  
    await client.query("COMMIT");

    console.log("");
    console.log("========================================");
    console.log("LEAVE REPAIR COMPLETED");
    console.log("========================================");
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("");
    console.error("========================================");
    console.error("LEAVE REPAIR FAILED");
    console.error("ALL DATABASE CHANGES ROLLED BACK");
    console.error("========================================");
    console.error(error);

  process.exitCode = 1;
  } finally {
    client.release();
  }
}

main();
