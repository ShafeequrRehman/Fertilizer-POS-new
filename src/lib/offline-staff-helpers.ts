import type { EmployeeSummary, RoleSummary } from '@/lib/shop-api';
import {
  getEmployeesCache,
  getPendingEmployeeCreates,
  getPendingEmployeeDeletes,
  getPendingEmployeeEdits,
  queueEmployeeDelete,
  queueEmployeeEdit,
  updateQueuedLocalEmployee,
  deleteQueuedLocalEmployee,
  type LocalEmployeeDeleteRecord,
  type LocalEmployeeEditRecord,
  type LocalEmployeeRecord,
} from '@/lib/local-hub-api';

// Shared by EmployeesPage.tsx - the offline "Manage Staff" counterpart to
// offline-order-helpers.ts. Same design as orders: a staff member being
// created/edited/removed either already has a real cloud _id (the change
// gets queued for the sync engine to replay for real) or is itself still
// only local/unsynced (its queued create record just gets mutated/deleted
// directly). See backend/localHub/localStaff.js for the full reasoning.

// Turns a locally-queued (not-yet-synced) staff-create record into the same
// EmployeeSummary shape the rest of the UI already knows how to render.
// `roleName`/`permissions` are denormalized into the payload at create time
// (see EmployeesPage.tsx) purely for display - there's no live role lookup
// available from the Local Hub queue itself.
export function localEmployeeToSummary(record: LocalEmployeeRecord): EmployeeSummary {
  const payload = (record.payload || {}) as Partial<EmployeeSummary> & { roleId?: string; roleName?: string };
  return {
    _id: `local-${record.id}`,
    name: payload.name || payload.username || '',
    username: payload.username || '',
    email: payload.email || '',
    phone: payload.phone || '',
    isActive: payload.isActive ?? true,
    employeeRoleId: payload.roleId
      ? { _id: payload.roleId, name: payload.roleName || '—', permissions: [] }
      : null,
    createdAt: record.queuedAt,
    designation: payload.designation || '',
    idCardNumber: payload.idCardNumber || '',
    address: payload.address || '',
    reference: payload.reference || '',
    comment: payload.comment || '',
    monthlySalary: payload.monthlySalary || 0,
  } as EmployeeSummary;
}

// Applies a staff-record edit (create-payload patch or update patch) against
// an EmployeeSummary for immediate display - mirrors
// offline-order-helpers.ts's applyPatchOptimistically. Purely cosmetic:
// the queued edit itself is replayed through the real backend once synced.
export function applyEmployeePatchOptimistically(
  employee: EmployeeSummary,
  patch: Record<string, unknown>,
  roles: RoleSummary[],
): EmployeeSummary {
  const next: EmployeeSummary = { ...employee };
  if (typeof patch.name === 'string') next.name = patch.name;
  if (typeof patch.username === 'string') next.username = patch.username;
  if (typeof patch.email === 'string') next.email = patch.email;
  if (typeof patch.phone === 'string') next.phone = patch.phone;
  if (typeof patch.isActive === 'boolean') next.isActive = patch.isActive;
  if (typeof patch.designation === 'string') next.designation = patch.designation;
  if (typeof patch.idCardNumber === 'string') next.idCardNumber = patch.idCardNumber;
  if (typeof patch.address === 'string') next.address = patch.address;
  if (typeof patch.reference === 'string') next.reference = patch.reference;
  if (typeof patch.comment === 'string') next.comment = patch.comment;
  if (typeof patch.monthlySalary === 'number') next.monthlySalary = patch.monthlySalary;
  if (typeof patch.roleId === 'string' && patch.roleId) {
    const role = roles.find((r) => r._id === patch.roleId);
    next.employeeRoleId = role ? { _id: role._id, name: role.name, permissions: role.permissions } : patch.roleId;
  }
  return next;
}

// Applies a staff-card edit against either an already-synced cloud employee
// (queues the edit for the sync engine to replay for real) or a
// still-only-local one (mutates its queued create payload directly) -
// returns the resulting EmployeeSummary for immediate display.
export async function saveEmployeeEditOffline(
  employee: EmployeeSummary,
  patch: Record<string, unknown>,
  roles: RoleSummary[],
): Promise<EmployeeSummary> {
  if (employee._id.startsWith('local-')) {
    const localId = employee._id.slice('local-'.length);
    const record = await updateQueuedLocalEmployee(localId, patch);
    return localEmployeeToSummary(record);
  }
  await queueEmployeeEdit(employee._id, patch);
  return applyEmployeePatchOptimistically(employee, patch, roles);
}

// Removes a staff member while offline - either drops its still-queued
// create entirely (case 1) or queues a delete for the sync engine to
// replay against the real document (case 2).
export async function deleteEmployeeOffline(employee: EmployeeSummary): Promise<void> {
  if (employee._id.startsWith('local-')) {
    const localId = employee._id.slice('local-'.length);
    await deleteQueuedLocalEmployee(localId);
    return;
  }
  await queueEmployeeDelete(employee._id);
}

function applyPendingEdits(
  cachedEmployees: EmployeeSummary[],
  pendingEdits: LocalEmployeeEditRecord[],
  roles: RoleSummary[],
): Map<string, EmployeeSummary> {
  const byId = new Map(cachedEmployees.map((employee) => [employee._id, employee]));
  for (const edit of pendingEdits) {
    const target = byId.get(edit.employeeId);
    if (target) {
      byId.set(edit.employeeId, applyEmployeePatchOptimistically(target, edit.payload, roles));
    }
  }
  return byId;
}

// The single place EmployeesPage.tsx builds the staff list it shows while
// offline - combines the Local Hub's cached cloud snapshot with whatever
// this till still has queued locally (creates overlaid on top, edits
// applied, deletes removed), same "cache first, queue overlaid" pattern as
// mergeOrdersForDisplay.
export function mergeEmployeesForDisplay(
  cachedEmployees: EmployeeSummary[],
  pendingCreates: LocalEmployeeRecord[],
  pendingEdits: LocalEmployeeEditRecord[],
  pendingDeletes: LocalEmployeeDeleteRecord[],
  roles: RoleSummary[],
): EmployeeSummary[] {
  const byId = applyPendingEdits(cachedEmployees, pendingEdits, roles);

  const deletedIds = new Set(pendingDeletes.map((entry) => entry.employeeId));
  for (const id of deletedIds) byId.delete(id);

  for (const record of pendingCreates) {
    const employee = localEmployeeToSummary(record);
    byId.set(employee._id, employee);
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
  );
}

// Fetches and merges all four sources in one call.
export async function loadEmployeesFromLocalHub(roles: RoleSummary[]): Promise<EmployeeSummary[]> {
  const [cache, pendingCreates, pendingEdits, pendingDeletes] = await Promise.all([
    getEmployeesCache(),
    getPendingEmployeeCreates(),
    getPendingEmployeeEdits(),
    getPendingEmployeeDeletes(),
  ]);
  return mergeEmployeesForDisplay(
    cache.employees as EmployeeSummary[],
    pendingCreates,
    pendingEdits,
    pendingDeletes,
    roles,
  );
}
