import { keysetPredicate, listLimit, pageOf } from '../db/list-bounds.js';
import { db } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../http/errors.js';

type AssetRow = Record<string, unknown>;

function profileLite(prefix: string, row: AssetRow) {
  const id = row[`${prefix}_id`] as string | null | undefined;
  if (!id) return null;
  return {
    id,
    full_name: (row[`${prefix}_full_name`] as string | null) ?? null,
    email: (row[`${prefix}_email`] as string | null) ?? null,
  };
}

function mapAsset(row: AssetRow) {
  return {
    id: row.id,
    organization_id: row.organization_id,
    purchase_batch_id: row.purchase_batch_id ?? null,
    category_id: row.category_id ?? null,
    current_location_id: row.current_location_id ?? null,
    asset_name: row.asset_name,
    asset_tag: row.asset_tag ?? null,
    serial_number: row.serial_number,
    brand: row.brand ?? null,
    model: row.model ?? null,
    description: row.description ?? null,
    status: row.status,
    condition: row.condition,
    purchase_price: row.purchase_price === null || row.purchase_price === undefined
      ? null
      : Number(row.purchase_price),
    currency: row.currency ?? 'USD',
    purchase_date: row.purchase_date ? String(row.purchase_date).slice(0, 10) : null,
    warranty_expiry_date: row.warranty_expiry_date
      ? String(row.warranty_expiry_date).slice(0, 10)
      : null,
    expected_life_months: row.expected_life_months ?? null,
    invoice_number: row.invoice_number ?? null,
    reference_number: row.reference_number ?? null,
    insured: Boolean(row.insured),
    insurance_provider: row.insurance_provider ?? null,
    insurance_policy_number: row.insurance_policy_number ?? null,
    insurance_expiry_date: row.insurance_expiry_date
      ? String(row.insurance_expiry_date).slice(0, 10)
      : null,
    sub_location: row.sub_location ?? null,
    barcode_value: row.barcode_value ?? null,
    qr_code_value: row.qr_code_value ?? null,
    asset_image_url: row.asset_image_url ?? null,
    site_image_url: row.site_image_url ?? null,
    asset_image_width: row.asset_image_width ?? null,
    asset_image_height: row.asset_image_height ?? null,
    site_image_width: row.site_image_width ?? null,
    site_image_height: row.site_image_height ?? null,
    notes: row.notes ?? null,
    assigned_to: row.assigned_to ?? null,
    assigned_project_id: row.assigned_project_id ?? null,
    created_by: row.created_by ?? null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
    category: row.category_id
      ? { id: row.category_id, name: row.category_name ?? null }
      : null,
    location: row.current_location_id
      ? {
          id: row.current_location_id,
          name: row.location_name ?? null,
          code: row.location_code ?? null,
          image_url: row.location_image_url ?? null,
        }
      : null,
    purchase_batch: row.purchase_batch_id
      ? {
          id: row.purchase_batch_id,
          reference_number: row.batch_reference_number ?? null,
          invoice_number: row.batch_invoice_number ?? null,
          purchase_date: row.batch_purchase_date
            ? String(row.batch_purchase_date).slice(0, 10)
            : null,
          vendor_id: row.batch_vendor_id ?? null,
        }
      : null,
    assigned_profile: profileLite('assigned', row),
    created_profile: profileLite('created', row),
  };
}

const ASSET_SELECT = `
  a.*,
  c.name AS category_name,
  l.name AS location_name,
  l.code AS location_code,
  l.image_url AS location_image_url,
  b.reference_number AS batch_reference_number,
  b.invoice_number AS batch_invoice_number,
  b.purchase_date AS batch_purchase_date,
  b.vendor_id AS batch_vendor_id,
  ap.full_name AS assigned_full_name,
  au.email AS assigned_email,
  a.assigned_to AS assigned_id,
  cp.full_name AS created_full_name,
  cu.email AS created_email,
  a.created_by AS created_id
`;

const ASSET_JOINS = `
  FROM stock.assets a
  LEFT JOIN stock.categories c ON c.id = a.category_id
  LEFT JOIN stock.locations l ON l.id = a.current_location_id
  LEFT JOIN stock.purchase_batches b ON b.id = a.purchase_batch_id
  LEFT JOIN identity.user_profiles ap ON ap.user_id = a.assigned_to
  LEFT JOIN identity.users au ON au.id = a.assigned_to
  LEFT JOIN identity.user_profiles cp ON cp.user_id = a.created_by
  LEFT JOIN identity.users cu ON cu.id = a.created_by
`;

function generateAssetTag() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(1000 + Math.random() * 9000);
  return `INM-AST-${datePart}-${random}`;
}

export class PostgresStockStore {
  async listCategories(organizationId: string) {
    const limit = listLimit();
    const result = await db.query(
      `SELECT id, organization_id, name, created_at, updated_at
       FROM stock.categories
       WHERE organization_id = $1
       ORDER BY name ASC, id ASC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows;
  }

  async listLocations(organizationId: string) {
    const limit = listLimit();
    const result = await db.query(
      `SELECT id, organization_id, name, code, image_url, created_at, updated_at
       FROM stock.locations
       WHERE organization_id = $1
       ORDER BY name ASC, id ASC
       LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows;
  }

  async listAssets(
    organizationId: string,
    search?: string | null,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const term = search?.trim();
    const params: unknown[] = [organizationId];
    let where = 'a.organization_id = $1';
    if (term) {
      params.push(`%${term}%`);
      where += ` AND (
        a.asset_name ILIKE $${params.length} OR a.asset_tag ILIKE $${params.length} OR a.serial_number ILIKE $${params.length}
        OR a.brand ILIKE $${params.length} OR a.model ILIKE $${params.length} OR a.invoice_number ILIKE $${params.length}
        OR a.reference_number ILIKE $${params.length} OR a.sub_location ILIKE $${params.length}
      )`;
    }
    where += keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'a.created_at',
      'a.id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT ${ASSET_SELECT} ${ASSET_JOINS}
       WHERE ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const pageResult = pageOf(result.rows.map(mapAsset), limit);
    return { assets: pageResult.rows, hasMore: pageResult.hasMore };
  }

  async getAsset(organizationId: string, assetId: string) {
    const result = await db.query(
      `SELECT ${ASSET_SELECT} ${ASSET_JOINS}
       WHERE a.organization_id = $1 AND a.id = $2
       LIMIT 1`,
      [organizationId, assetId],
    );
    const asset = result.rows[0] ? mapAsset(result.rows[0]) : null;
    if (!asset) return null;

    const [assignments, maintenance, audits] = await Promise.all([
      db.query(
        `SELECT aa.*,
                atp.full_name AS assigned_to_full_name, atu.email AS assigned_to_email,
                abp.full_name AS assigned_by_full_name, abu.email AS assigned_by_email,
                rbp.full_name AS returned_by_full_name, rbu.email AS returned_by_email
         FROM stock.asset_assignments aa
         LEFT JOIN identity.user_profiles atp ON atp.user_id = aa.assigned_to
         LEFT JOIN identity.users atu ON atu.id = aa.assigned_to
         LEFT JOIN identity.user_profiles abp ON abp.user_id = aa.assigned_by
         LEFT JOIN identity.users abu ON abu.id = aa.assigned_by
         LEFT JOIN identity.user_profiles rbp ON rbp.user_id = aa.returned_by
         LEFT JOIN identity.users rbu ON rbu.id = aa.returned_by
         WHERE aa.asset_id = $1
         ORDER BY aa.assigned_at DESC
         LIMIT 100`,
        [assetId],
      ),
      db.query(
        `SELECT m.*, p.full_name AS created_full_name, u.email AS created_email
         FROM stock.asset_maintenance m
         LEFT JOIN identity.user_profiles p ON p.user_id = m.created_by
         LEFT JOIN identity.users u ON u.id = m.created_by
         WHERE m.asset_id = $1
         ORDER BY m.created_at DESC
         LIMIT 100`,
        [assetId],
      ),
      db.query(
        `SELECT a.*, p.full_name AS checked_full_name, u.email AS checked_email
         FROM stock.asset_audits a
         LEFT JOIN identity.user_profiles p ON p.user_id = a.checked_by
         LEFT JOIN identity.users u ON u.id = a.checked_by
         WHERE a.asset_id = $1
         ORDER BY a.checked_at DESC
         LIMIT 100`,
        [assetId],
      ),
    ]);

    return {
      ...asset,
      assignment_history: assignments.rows.map((row) => ({
        ...row,
        assigned_at: (row.assigned_at as Date)?.toISOString?.() ?? row.assigned_at,
        due_back_at: row.due_back_at
          ? (row.due_back_at as Date).toISOString?.() ?? row.due_back_at
          : null,
        returned_at: row.returned_at
          ? (row.returned_at as Date).toISOString?.() ?? row.returned_at
          : null,
        created_at: (row.created_at as Date)?.toISOString?.() ?? row.created_at,
        assigned_to_profile: row.assigned_to
          ? {
              id: row.assigned_to,
              full_name: row.assigned_to_full_name ?? null,
              email: row.assigned_to_email ?? null,
            }
          : null,
        assigned_by_profile: row.assigned_by
          ? {
              id: row.assigned_by,
              full_name: row.assigned_by_full_name ?? null,
              email: row.assigned_by_email ?? null,
            }
          : null,
        returned_by_profile: row.returned_by
          ? {
              id: row.returned_by,
              full_name: row.returned_by_full_name ?? null,
              email: row.returned_by_email ?? null,
            }
          : null,
      })),
      maintenance_history: maintenance.rows.map((row) => ({
        ...row,
        created_at: (row.created_at as Date)?.toISOString?.() ?? row.created_at,
        created_profile: row.created_by
          ? {
              id: row.created_by,
              full_name: row.created_full_name ?? null,
              email: row.created_email ?? null,
            }
          : null,
      })),
      audit_history: audits.rows.map((row) => ({
        ...row,
        checked_at: (row.checked_at as Date)?.toISOString?.() ?? row.checked_at,
        checked_by_profile: row.checked_by
          ? {
              id: row.checked_by,
              full_name: row.checked_full_name ?? null,
              email: row.checked_email ?? null,
            }
          : null,
      })),
    };
  }

  async getStats(organizationId: string) {
    const result = await db.query<{ status: string; count: number; insured: number }>(
      `SELECT status,
              count(*)::int AS count,
              count(*) FILTER (WHERE insured)::int AS insured
       FROM stock.assets
       WHERE organization_id = $1
       GROUP BY status`,
      [organizationId],
    );
    const countOf = (status: string) =>
      result.rows.find((row) => row.status === status)?.count ?? 0;
    const total = result.rows.reduce((sum, row) => sum + Number(row.count), 0);
    const insured = result.rows.reduce((sum, row) => sum + Number(row.insured), 0);
    return {
      total,
      in_stock: countOf('in_stock'),
      assigned: countOf('assigned'),
      in_repair: countOf('in_repair'),
      retired: countOf('retired'),
      lost: countOf('lost'),
      disposed: countOf('disposed'),
      insured,
      uninsured: total - insured,
    };
  }

  async createAsset(input: Record<string, unknown> & { organizationId: string; createdBy?: string | null }) {
    const assetTag =
      (typeof input.asset_tag === 'string' && input.asset_tag.trim()) ||
      generateAssetTag();
    const result = await db.query(
      `INSERT INTO stock.assets (
         organization_id, purchase_batch_id, category_id, current_location_id,
         asset_name, asset_tag, serial_number, brand, model, description,
         status, condition, purchase_price, currency, purchase_date,
         warranty_expiry_date, expected_life_months, invoice_number, reference_number,
         insured, insurance_provider, insurance_policy_number, insurance_expiry_date,
         sub_location, barcode_value, qr_code_value, asset_image_url, site_image_url,
         asset_image_width, asset_image_height, site_image_width, site_image_height,
         notes, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         'in_stock','new',$11,COALESCE($12,'USD'),$13,
         $14,$15,$16,$17,
         COALESCE($18,FALSE),$19,$20,$21,
         $22,COALESCE($23,$6),COALESCE($24,$6),$25,$26,
         $27,$28,$29,$30,
         $31,$32
       )
       RETURNING id`,
      [
        input.organizationId,
        input.purchase_batch_id ?? null,
        input.category_id ?? null,
        input.current_location_id ?? null,
        input.asset_name,
        assetTag,
        input.serial_number,
        input.brand ?? null,
        input.model ?? null,
        input.description ?? null,
        input.purchase_price ?? null,
        input.currency ?? 'USD',
        input.purchase_date ?? null,
        input.warranty_expiry_date ?? null,
        input.expected_life_months ?? null,
        input.invoice_number ?? null,
        input.reference_number ?? null,
        input.insured ?? false,
        input.insurance_provider ?? null,
        input.insurance_policy_number ?? null,
        input.insurance_expiry_date ?? null,
        input.sub_location ?? null,
        input.barcode_value ?? null,
        input.qr_code_value ?? null,
        input.asset_image_url ?? null,
        input.site_image_url ?? null,
        input.asset_image_width ?? null,
        input.asset_image_height ?? null,
        input.site_image_width ?? null,
        input.site_image_height ?? null,
        input.notes ?? null,
        input.createdBy ?? null,
      ],
    );
    const created = await this.getAsset(input.organizationId, result.rows[0].id as string);
    if (!created) throw new NotFoundError('ASSET_NOT_FOUND', 'Asset not found after create.');
    return created;
  }

  async updateAsset(
    organizationId: string,
    assetId: string,
    input: Record<string, unknown>,
  ) {
    const fields: string[] = [];
    const values: unknown[] = [];
    const allowed = [
      'asset_name', 'purchase_batch_id', 'category_id', 'current_location_id',
      'asset_tag', 'serial_number', 'brand', 'model', 'description', 'status',
      'condition', 'purchase_price', 'currency', 'purchase_date', 'warranty_expiry_date',
      'expected_life_months', 'invoice_number', 'reference_number', 'insured',
      'insurance_provider', 'insurance_policy_number', 'insurance_expiry_date',
      'sub_location', 'barcode_value', 'qr_code_value', 'asset_image_url',
      'site_image_url', 'asset_image_width', 'asset_image_height', 'site_image_width',
      'site_image_height', 'notes', 'assigned_to', 'assigned_project_id',
    ];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        values.push(input[key]);
        fields.push(`${key} = $${values.length}`);
      }
    }
    if (fields.length === 0) {
      throw new ValidationError('No asset fields to update.');
    }
    values.push(organizationId, assetId);
    fields.push('updated_at = NOW()');
    const result = await db.query(
      `UPDATE stock.assets SET ${fields.join(', ')}
       WHERE organization_id = $${values.length - 1} AND id = $${values.length}
       RETURNING id`,
      values,
    );
    if (!result.rows[0]) throw new NotFoundError('ASSET_NOT_FOUND', 'Asset not found.');
    return this.getAsset(organizationId, assetId);
  }

  async assignAsset(params: {
    organizationId: string;
    assetId: string;
    assignedTo?: string | null;
    assignedProjectId?: string | null;
    assignedLocationId?: string | null;
    assignedBy?: string | null;
    dueBackAt?: string | null;
    notes?: string | null;
  }) {
    if (!params.assignedTo && !params.assignedProjectId) {
      throw new ValidationError('Assign the asset to a user or project.');
    }
    const assignment = await db.query(
      `INSERT INTO stock.asset_assignments (
         organization_id, asset_id, assigned_to, assigned_project_id,
         assigned_location_id, assigned_by, due_back_at, notes, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
       RETURNING *`,
      [
        params.organizationId,
        params.assetId,
        params.assignedTo ?? null,
        params.assignedProjectId ?? null,
        params.assignedLocationId ?? null,
        params.assignedBy ?? null,
        params.dueBackAt ?? null,
        params.notes ?? null,
      ],
    );
    await db.query(
      `UPDATE stock.assets
       SET status = 'assigned',
           assigned_to = $3,
           assigned_project_id = $4,
           current_location_id = COALESCE($5, current_location_id),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2`,
      [
        params.organizationId,
        params.assetId,
        params.assignedTo ?? null,
        params.assignedProjectId ?? null,
        params.assignedLocationId ?? null,
      ],
    );
    return {
      assignment: assignment.rows[0],
      asset: await this.getAsset(params.organizationId, params.assetId),
    };
  }

  async returnAsset(params: {
    organizationId: string;
    assignmentId: string;
    assetId: string;
    returnedBy?: string | null;
    locationId?: string | null;
  }) {
    const assignment = await db.query(
      `UPDATE stock.asset_assignments
       SET status = 'returned', returned_at = NOW(), returned_by = $3
       WHERE id = $1 AND asset_id = $2
       RETURNING *`,
      [params.assignmentId, params.assetId, params.returnedBy ?? null],
    );
    if (!assignment.rows[0]) {
      throw new NotFoundError('ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
    }
    await db.query(
      `UPDATE stock.assets
       SET status = 'in_stock',
           assigned_to = NULL,
           assigned_project_id = NULL,
           current_location_id = COALESCE($3, current_location_id),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2`,
      [params.organizationId, params.assetId, params.locationId ?? null],
    );
    return {
      assignment: assignment.rows[0],
      asset: await this.getAsset(params.organizationId, params.assetId),
    };
  }

  async deleteAsset(organizationId: string, assetId: string) {
    const result = await db.query(
      `DELETE FROM stock.assets WHERE organization_id = $1 AND id = $2 RETURNING id`,
      [organizationId, assetId],
    );
    if (!result.rows[0]) throw new NotFoundError('ASSET_NOT_FOUND', 'Asset not found.');
  }

  async listPurchaseBatches(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'created_at',
      'id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT id, organization_id, reference_number, invoice_number, purchase_date,
              vendor_id, created_at, updated_at
       FROM stock.purchase_batches
       WHERE organization_id = $1
         ${cursor}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
    const mapped = result.rows.map((row) => ({
      ...row,
      purchase_date: row.purchase_date
        ? String(row.purchase_date).slice(0, 10)
        : null,
      created_at: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
      updated_at: row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
      label:
        row.reference_number ||
        row.invoice_number ||
        `Batch ${row.purchase_date ?? String(row.id).slice(0, 8)}`,
    }));
    const pageResult = pageOf(mapped, limit);
    return { batches: pageResult.rows, hasMore: pageResult.hasMore };
  }

  async createPurchaseBatch(
    organizationId: string,
    input: {
      reference_number?: string | null;
      invoice_number?: string | null;
      purchase_date?: string | null;
      vendor_id?: string | null;
    },
  ) {
    const reference =
      input.reference_number?.trim() ||
      input.invoice_number?.trim() ||
      null;
    if (!reference) {
      throw new ValidationError('Purchase batch reference is required.');
    }
    const result = await db.query(
      `INSERT INTO stock.purchase_batches (
         organization_id, reference_number, invoice_number, purchase_date, vendor_id
       ) VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5)
       RETURNING *`,
      [
        organizationId,
        reference,
        input.invoice_number?.trim() || reference,
        input.purchase_date ?? null,
        input.vendor_id ?? null,
      ],
    );
    const row = result.rows[0];
    return {
      ...row,
      purchase_date: row.purchase_date
        ? String(row.purchase_date).slice(0, 10)
        : null,
      label:
        row.reference_number ||
        row.invoice_number ||
        `Batch ${row.purchase_date ?? String(row.id).slice(0, 8)}`,
    };
  }

  async getAnalyticsCostMetrics(organizationId: string) {
    const result = await db.query<{
      category_name: string;
      status: string;
      currency: string;
      asset_count: number;
      total_cost: string;
      monthly_depreciation: string;
    }>(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category_name,
              COALESCE(a.status, 'unknown') AS status,
              COALESCE(a.currency, 'USD') AS currency,
              count(*)::int AS asset_count,
              COALESCE(sum(a.purchase_price), 0)::text AS total_cost,
              COALESCE(sum(
                CASE
                  WHEN a.expected_life_months > 0
                    THEN a.purchase_price / a.expected_life_months
                  ELSE 0
                END
              ), 0)::text AS monthly_depreciation
       FROM stock.assets a
       LEFT JOIN stock.categories c ON c.id = a.category_id
       WHERE a.organization_id = $1 AND a.purchase_price IS NOT NULL
       GROUP BY 1, 2, 3`,
      [organizationId],
    );
    const groups = result.rows;
    const totalCost = groups.reduce((sum, row) => sum + Number(row.total_cost), 0);
    const totalAssets = groups.reduce((sum, row) => sum + Number(row.asset_count), 0);
    const averageCost = totalAssets > 0 ? totalCost / totalAssets : 0;

    const categoryMap = new Map<string, { cost: number; count: number }>();
    for (const row of groups) {
      const current = categoryMap.get(row.category_name) || { cost: 0, count: 0 };
      current.cost += Number(row.total_cost);
      current.count += Number(row.asset_count);
      categoryMap.set(row.category_name, current);
    }
    const costByCategory = Array.from(categoryMap.entries())
      .map(([name, data]) => ({
        categoryName: name,
        totalCost: data.cost,
        assetCount: data.count,
        percentage: totalCost > 0 ? (data.cost / totalCost) * 100 : 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);

    const statusMap = new Map<string, { cost: number; count: number }>();
    for (const row of groups) {
      const current = statusMap.get(row.status) || { cost: 0, count: 0 };
      current.cost += Number(row.total_cost);
      current.count += Number(row.asset_count);
      statusMap.set(row.status, current);
    }
    const costByStatus = Array.from(statusMap.entries())
      .map(([status, data]) => ({
        status,
        totalCost: data.cost,
        assetCount: data.count,
        percentage: totalCost > 0 ? (data.cost / totalCost) * 100 : 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);

    const monthlyDepreciation = groups.reduce(
      (sum, row) => sum + Number(row.monthly_depreciation),
      0,
    );

    const currencyCounts = groups.reduce(
      (acc, row) => {
        acc[row.currency] = (acc[row.currency] || 0) + Number(row.asset_count);
        return acc;
      },
      {} as Record<string, number>,
    );
    const primaryCurrency =
      Object.entries(currencyCounts).sort(
        ([, a], [, b]) => Number(b) - Number(a),
      )[0]?.[0] || 'USD';

    return {
      totalCost,
      totalAssets,
      averageCost,
      costByCategory,
      costByStatus,
      monthlyDepreciation,
      currency: primaryCurrency,
    };
  }

  async listAssetsForAnalytics(
    organizationId: string,
    page: { limit?: number; before?: string; beforeId?: string } = {},
  ) {
    const limit = listLimit(page.limit);
    const params: unknown[] = [organizationId];
    const cursor = keysetPredicate(
      params,
      { at: page.before, id: page.beforeId },
      'a.created_at',
      'a.id',
    );
    params.push(limit + 1);
    const result = await db.query(
      `SELECT a.*, c.name AS category_name, l.name AS location_name
       FROM stock.assets a
       LEFT JOIN stock.categories c ON c.id = a.category_id
       LEFT JOIN stock.locations l ON l.id = a.current_location_id
       WHERE a.organization_id = $1
         ${cursor}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const mapped = result.rows.map((row) => ({
      ...row,
      purchase_price:
        row.purchase_price === null || row.purchase_price === undefined
          ? null
          : Number(row.purchase_price),
      purchase_date: row.purchase_date
        ? String(row.purchase_date).slice(0, 10)
        : null,
      warranty_expiry_date: row.warranty_expiry_date
        ? String(row.warranty_expiry_date).slice(0, 10)
        : null,
      category_name: row.category_name ?? null,
      location_name: row.location_name ?? null,
    }));
    const pageResult = pageOf(mapped, limit);
    return { assets: pageResult.rows, hasMore: pageResult.hasMore };
  }
}
