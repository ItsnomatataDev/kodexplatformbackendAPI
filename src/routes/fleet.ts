import { Hono } from 'hono';
import { getAuth } from '../auth/middleware.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../http/errors.js';
import { readJson, requireUuidValue } from '../work/http.js';
import { isAdminManagerIt, requireProductOrg } from '../products/staff.js';
import type { PostgresFleetStore } from '../fleet/postgres-store.js';

export type FleetRouteDependencies = { store: PostgresFleetStore };

function authorize(auth: ReturnType<typeof getAuth>) {
  return requireProductOrg(auth);
}

function requireManage(auth: ReturnType<typeof getAuth>) {
  if (!isAdminManagerIt(auth)) {
    throw new ForbiddenError('FLEET_MANAGE_REQUIRED', 'Fleet manage access required.');
  }
}

export function createFleetRoutes(dependencies: FleetRouteDependencies) {
  const routes = new Hono();

  routes.get('/vehicles', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    return c.json({ vehicles: await dependencies.store.listVehicles(organizationId) });
  });

  routes.post('/vehicles', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    requireManage(auth);
    const body = await readJson(c);
    const vehicle = await dependencies.store.createVehicle({
      organizationId,
      vehicleName: (body.vehicleName ?? body.vehicle_name ?? null) as string | null,
      registrationNumber: (body.registrationNumber ?? body.registration_number ?? null) as string | null,
      officeId: (body.officeId ?? body.office_id ?? null) as string | null,
      currentOdometerKm:
        body.currentOdometerKm != null || body.current_odometer_km != null
          ? Number(body.currentOdometerKm ?? body.current_odometer_km)
          : null,
    });
    return c.json({ vehicle }, 201);
  });

  routes.patch('/vehicles/:vehicleId', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    requireManage(auth);
    const vehicleId = requireUuidValue(c.req.param('vehicleId'), 'vehicleId');
    const body = await readJson(c);
    const vehicle = await dependencies.store.updateVehicle(organizationId, vehicleId, body);
    return c.json({ vehicle });
  });

  routes.post('/vehicles/:vehicleId/maintenance-mode', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    requireManage(auth);
    const vehicleId = requireUuidValue(c.req.param('vehicleId'), 'vehicleId');
    const body = await readJson(c);
    const vehicle = await dependencies.store.setMaintenanceMode({
      organizationId,
      vehicleId,
      underMaintenance: Boolean(body.underMaintenance ?? body.under_maintenance),
      note: (body.note ?? null) as string | null,
      userId: auth.actor.userId,
    });
    return c.json({ vehicle });
  });

  routes.get('/dashboard', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const startDate = c.req.query('startDate');
    const endDate = c.req.query('endDate');
    let start = startDate;
    let end = endDate;
    if (!start || !end) {
      const latest = await dependencies.store.latestSummaryDate(organizationId);
      const day = latest ?? new Date().toISOString().slice(0, 10);
      start = day;
      end = day;
    }
    const [vehicles, summaries, fuel, schedules, maintenance, imports] = await Promise.all([
      dependencies.store.listVehicles(organizationId),
      dependencies.store.listDailySummaries(organizationId, start, end),
      dependencies.store.listFuel(organizationId),
      dependencies.store.listSchedules(organizationId),
      dependencies.store.listMaintenance(organizationId),
      dependencies.store.listImportBatches(organizationId),
    ]);
    return c.json({
      startDate: start,
      endDate: end,
      vehicles,
      dailySummaries: summaries.summaries,
      dailySummariesHasMore: summaries.hasMore,
      fuelPurchases: fuel,
      serviceSchedules: schedules,
      maintenanceRecords: maintenance,
      importBatches: imports.batches,
      importRows: imports.rows,
    });
  });

  routes.post('/fuel', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    requireManage(auth);
    const body = await readJson(c);
    const vehicleId = String(body.vehicleId ?? body.vehicle_id ?? '');
    if (!vehicleId) throw new ValidationError('vehicleId is required.');
    const row = await dependencies.store.createFuel({
      organizationId,
      vehicleId,
      purchaseDate: body.purchaseDate ?? body.purchase_date,
      litres: Number(body.litres),
      totalCost: Number(body.totalCost ?? body.total_cost),
      currency: body.currency ?? 'USD',
      unitPrice: body.unitPrice ?? body.unit_price ?? null,
      odometerKm: body.odometerKm ?? body.odometer_km ?? null,
      stationName: body.stationName ?? body.station_name ?? null,
      paymentMethod: body.paymentMethod ?? body.payment_method ?? null,
      receiptNumber: body.receiptNumber ?? body.receipt_number ?? null,
      receiptUrl: body.receiptUrl ?? body.receipt_url ?? null,
      recordedBy: auth.actor.userId,
      notes: body.notes ?? null,
    });
    return c.json({ fuelPurchase: row }, 201);
  });

  routes.post('/maintenance', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    requireManage(auth);
    const body = await readJson(c);
    const vehicleId = String(body.vehicleId ?? body.vehicle_id ?? '');
    if (!vehicleId) throw new ValidationError('vehicleId is required.');
    const row = await dependencies.store.createMaintenance({
      organizationId,
      vehicleId,
      serviceDate: body.serviceDate ?? body.service_date,
      odometerKm: body.odometerKm ?? body.odometer_km ?? null,
      serviceType: body.serviceType ?? body.service_type ?? 'service',
      notes: body.notes ?? body.description ?? null,
      provider: body.provider ?? null,
      cost: body.cost ?? null,
      currency: body.currency ?? 'USD',
      receiptUrl: body.receiptUrl ?? body.receipt_url ?? null,
      nextServiceDate: body.nextServiceDate ?? body.next_service_date ?? null,
      nextServiceOdometerKm: body.nextServiceOdometerKm ?? body.next_service_odometer_km ?? null,
      createdBy: auth.actor.userId,
    });
    return c.json({ maintenanceRecord: row }, 201);
  });

  routes.get('/vehicles/:vehicleId/odometer-readings', async (c) => {
    const auth = getAuth(c);
    const organizationId = authorize(auth);
    const vehicleId = requireUuidValue(c.req.param('vehicleId'), 'vehicleId');
    const vehicle = await dependencies.store.getVehicle(organizationId, vehicleId);
    if (!vehicle) throw new NotFoundError('VEHICLE_NOT_FOUND', 'Vehicle not found.');
    return c.json({
      readings: await dependencies.store.listOdometerReadings(organizationId, vehicleId),
    });
  });

  return routes;
}
