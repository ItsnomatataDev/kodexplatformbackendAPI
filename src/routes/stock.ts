import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { env } from '../config/env.js';
import type { FileStorage } from '../files/storage.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../http/errors.js';
import {
  readJson,
  readOptionalString,
  readRequiredText,
  requireUuidValue,
} from '../work/http.js';
import { isAdminManagerIt, requireProductOrg } from '../products/staff.js';
import type { PostgresStockStore } from '../stock/postgres-store.js';
import { streamStoredMedia } from '../content/media-stream.js';
import { readListQuery } from '../http/list-query.js';

export type StockRouteDependencies = {
  store: PostgresStockStore;
  files: FileStorage;
};

function authorizeStock(auth: ReturnType<typeof getAuth>, _action?: string) {
  return requireProductOrg(auth);
}

function requireManage(auth: ReturnType<typeof getAuth>) {
  if (!isAdminManagerIt(auth)) {
    throw new ForbiddenError('STOCK_MANAGE_REQUIRED', 'Stock manage access required.');
  }
}

function stockImageObjectKey(params: {
  organizationId: string;
  assetId: string;
  type: 'asset' | 'site';
  filename: string;
}) {
  const safe = params.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return `stock/${params.organizationId}/${params.assetId}/${params.type}/${randomUUID()}-${safe}`;
}

function stockMediaProxyUrl(objectKey: string) {
  return `/api/stock/media?key=${encodeURIComponent(objectKey)}`;
}

function readPage(c: { req: { query: (name: string) => string | undefined } }) {
  return readListQuery(c);
}

export function createStockRoutes(dependencies: StockRouteDependencies) {
  const routes = new Hono();

  routes.get('/categories', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    return c.json({ categories: await dependencies.store.listCategories(organizationId) });
  });

  routes.get('/locations', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    return c.json({ locations: await dependencies.store.listLocations(organizationId) });
  });

  routes.get('/purchase-batches', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    const page = readPage(c);
    const batches = await dependencies.store.listPurchaseBatches(organizationId, page);
    return c.json({ batches: batches.batches, hasMore: batches.hasMore });
  });

  routes.post('/purchase-batches', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const body = await readJson(c);
    const reference = readRequiredText(
      body.reference_number ?? body.referenceNumber ?? body.label ?? body.name,
      'reference_number',
      200,
    );
    const batch = await dependencies.store.createPurchaseBatch(organizationId, {
      reference_number: reference,
      invoice_number:
        readOptionalString(body.invoice_number ?? body.invoiceNumber, 'invoice_number', 200) ??
        reference,
      purchase_date:
        readOptionalString(body.purchase_date ?? body.purchaseDate, 'purchase_date', 32) ?? null,
      vendor_id: (body.vendor_id ?? body.vendorId ?? null) as string | null,
    });
    return c.json({ batch }, 201);
  });

  routes.get('/analytics/cost', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    return c.json(await dependencies.store.getAnalyticsCostMetrics(organizationId));
  });

  routes.get('/analytics/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    const page = readPage(c);
    const assets = await dependencies.store.listAssetsForAnalytics(organizationId, page);
    return c.json({ assets: assets.assets, hasMore: assets.hasMore });
  });

  routes.get('/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    const search = c.req.query('q') ?? null;
    const page = readPage(c);
    const assets = await dependencies.store.listAssets(organizationId, search, page);
    return c.json({ assets: assets.assets, hasMore: assets.hasMore });
  });

  routes.get('/assets/stats', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    return c.json(await dependencies.store.getStats(organizationId));
  });

  routes.get('/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const asset = await dependencies.store.getAsset(organizationId, assetId);
    if (!asset) throw new NotFoundError('ASSET_NOT_FOUND', 'Asset not found.');
    return c.json({ asset });
  });

  routes.post('/assets', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const body = await readJson(c);
    const asset = await dependencies.store.createAsset({
      organizationId,
      createdBy: auth.actor.userId,
      asset_name: readRequiredText(body.asset_name ?? body.assetName, 'asset_name', 200),
      serial_number: readRequiredText(body.serial_number ?? body.serialNumber, 'serial_number', 200),
      ...body,
    });
    return c.json({ asset }, 201);
  });

  routes.patch('/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const body = await readJson(c);
    const asset = await dependencies.store.updateAsset(organizationId, assetId, body);
    return c.json({ asset });
  });

  routes.post('/assets/:assetId/images/:type/binary', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const typeRaw = c.req.param('type');
    if (typeRaw !== 'asset' && typeRaw !== 'site') {
      throw new ValidationError('type must be asset or site.');
    }
    const asset = await dependencies.store.getAsset(organizationId, assetId);
    if (!asset) throw new NotFoundError('ASSET_NOT_FOUND', 'Asset not found.');

    const sizeHeader = c.req.header('content-length');
    const sizeBytes = Number(sizeHeader);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new ValidationError('Content-Length is required.');
    }
    if (sizeBytes > 25 * 1024 * 1024) {
      throw new ValidationError('Image must be under 25 MiB.');
    }
    if (!c.req.raw.body) {
      throw new ValidationError('Request body is required.', { field: 'body' });
    }

    const filename =
      c.req.query('filename') ??
      c.req.header('x-kode-filename') ??
      `${typeRaw}.jpg`;
    const contentType =
      c.req.header('content-type') ?? 'application/octet-stream';
    const objectKey = stockImageObjectKey({
      organizationId,
      assetId,
      type: typeRaw,
      filename,
    });

    await dependencies.files.ensureBucket?.(env.minio.bucket);
    const put =
      dependencies.files.putObjectStream?.bind(dependencies.files) ??
      (async (input: {
        bucket: string;
        objectKey: string;
        body: ReadableStream<Uint8Array> | Buffer;
        contentType?: string | null;
        contentLength: number;
      }) => {
        const chunks: Uint8Array[] = [];
        if (Buffer.isBuffer(input.body)) {
          chunks.push(input.body);
        } else {
          const reader = input.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        }
        await dependencies.files.putObject({
          bucket: input.bucket,
          objectKey: input.objectKey,
          body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
          contentType: input.contentType,
        });
      });

    await put({
      bucket: env.minio.bucket,
      objectKey,
      body: c.req.raw.body,
      contentType,
      contentLength: sizeBytes,
    });

    const publicUrl = stockMediaProxyUrl(objectKey);
    const patch =
      typeRaw === 'asset'
        ? { asset_image_url: publicUrl }
        : { site_image_url: publicUrl };
    const updated = await dependencies.store.updateAsset(
      organizationId,
      assetId,
      patch,
    );
    return c.json(
      {
        public_url: publicUrl,
        file_path: objectKey,
        asset: updated,
      },
      201,
    );
  });

  routes.get('/media', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    const key = c.req.query('key');
    if (!key || !key.startsWith(`stock/${organizationId}/`)) {
      throw new NotFoundError('STOCK_MEDIA_NOT_FOUND', 'Media not found.');
    }
    return streamStoredMedia({
      files: dependencies.files,
      bucket: env.minio.bucket,
      objectKey: key,
      rangeHeader: c.req.header('range'),
    });
  });

  routes.post('/assets/:assetId/assign', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const body = await readJson(c);
    const result = await dependencies.store.assignAsset({
      organizationId,
      assetId,
      assignedTo: (body.assigned_to ?? body.assignedTo ?? null) as string | null,
      assignedProjectId: (body.assigned_project_id ?? body.assignedProjectId ?? null) as string | null,
      assignedLocationId: (body.assigned_location_id ?? body.assignedLocationId ?? null) as string | null,
      assignedBy: auth.actor.userId,
      dueBackAt: (body.due_back_at ?? body.dueBackAt ?? null) as string | null,
      notes: readOptionalString(body.notes, 'notes', 2000),
    });
    return c.json(result, 201);
  });

  routes.post('/assets/:assetId/return', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const body = await readJson(c);
    const result = await dependencies.store.returnAsset({
      organizationId,
      assetId,
      assignmentId: requireUuidValue(
        String(body.assignment_id ?? body.assignmentId ?? ''),
        'assignmentId',
      ),
      returnedBy: auth.actor.userId,
      locationId: (body.location_id ?? body.locationId ?? null) as string | null,
    });
    return c.json(result);
  });

  routes.post('/assets/:assetId/repair', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const asset = await dependencies.store.updateAsset(organizationId, assetId, {
      status: 'in_repair',
      assigned_to: null,
      assigned_project_id: null,
    });
    return c.json({ asset });
  });

  routes.post('/assets/:assetId/retire', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    const asset = await dependencies.store.updateAsset(organizationId, assetId, {
      status: 'retired',
      assigned_to: null,
      assigned_project_id: null,
    });
    return c.json({ asset });
  });

  routes.delete('/assets/:assetId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorizeStock(auth, 'stock.read');
    requireManage(auth);
    const assetId = requireUuidValue(c.req.param('assetId'), 'assetId');
    await dependencies.store.deleteAsset(organizationId, assetId);
    return c.json({ ok: true });
  });

  return routes;
}
