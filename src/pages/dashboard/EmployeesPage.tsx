import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBackspaceToClose } from "@/lib/keyboard-shortcuts";
import { Plus, KeyRound, Trash2, X, ShieldCheck, ShieldPlus, RefreshCcw, Pencil, WifiOff, Eye } from "lucide-react";
import { shopApi, type EmployeeSummary, type RoleSummary, type PermissionDef } from "@/lib/shop-api";
import { STAFF_DESIGNATIONS } from "@/lib/staff-designations";
import { useToast } from "@/lib/toast";
import { isDesktopApp } from "@/lib/api";
import { useNetworkStatus } from "@/lib/network-status";
import { getReferenceData, queueEmployeeCreate, pushEmployeesCache } from "@/lib/local-hub-api";
import { loadEmployeesFromLocalHub, saveEmployeeEditOffline, deleteEmployeeOffline } from "@/lib/offline-staff-helpers";

// Shop Owner-only page (see App.tsx route guard) for managing staff -
// login accounts (Employees tab) and the roles that control what they
// can see and do (Roles tab). Renamed "Manage Staff" in the UI because it
// now also holds each staff member's designation (Chief, Manager,
// Cashier, Order Taker, Waiter, etc.) and directory details (ID card
// number, address, phone, reference, comment) - the frontend half of
// backend/routes/shopOwnerRoutes.js. Employees are created only here,
// never self-registered (see authController.register - self-service
// registration is disabled).
//
// The "Waiter" and "Order Taker" designations are what feed the POS
// waiter dropdown (see waiterController.getWaiters) - there is no
// separate waiter list to manage anymore (see SettingsPage.tsx).
export default function EmployeesPage() {
  const { toast, confirm } = useToast();
  const { isOnline } = useNetworkStatus();
  const [tab, setTab] = useState<"employees" | "roles">("employees");
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [permissions, setPermissions] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateEmployee, setShowCreateEmployee] = useState(false);
  const [editTarget, setEditTarget] = useState<EmployeeSummary | null>(null);
  const [viewTarget, setViewTarget] = useState<EmployeeSummary | null>(null);
  const [showRoleEditor, setShowRoleEditor] = useState<RoleSummary | "new" | null>(null);
  const [resetTarget, setResetTarget] = useState<EmployeeSummary | null>(null);
  // Dynamic Permissions: per-account grant/revoke on top of whatever
  // employeeRoleId's own permission set defaults to - see
  // EmployeePermissionsModal's own comment.
  const [permTarget, setPermTarget] = useState<EmployeeSummary | null>(null);

  // Desktop + genuinely offline (the network-status hook does a real
  // backend round-trip, not just navigator.onLine - see network-status.ts)
  // is when staff create/edit/delete get queued through the Local Hub
  // instead of calling shopApi directly against the cloud. See
  // offline-staff-helpers.ts / backend/localHub/localStaff.js.
  const offline = isDesktopApp() && !isOnline;

  // Cache-first-on-failure load: tries the cloud first (so a normal online
  // session always shows the truest, most current list), and only falls
  // back to the Local Hub's cached snapshot + pending queue if that fails -
  // covers both "known offline" and "looked online a second ago but this
  // particular request still failed" without a separate code path for each.
  const loadOffline = async () => {
    try {
      const reference = await getReferenceData();
      const cachedRoles = (reference.roles || []) as RoleSummary[];
      setRoles(cachedRoles);
      const merged = await loadEmployeesFromLocalHub(cachedRoles);
      setEmployees(merged);
    } catch {
      toast.error("Could not load staff - Local Hub unreachable.");
    } finally {
      setLoading(false);
    }
  };

  const load = () => {
    setLoading(true);
    if (offline) {
      void loadOffline();
      return;
    }
    Promise.all([shopApi.listEmployees(), shopApi.listRoles(), shopApi.listPermissions()])
      .then(([e, r, p]) => {
        setEmployees(e);
        setRoles(r);
        setPermissions(p);
        setLoading(false);
        // Best-effort - keeps Manage Staff's own offline cache current
        // every time this till successfully loads the list online. Never
        // blocks or fails the on-screen load if the Local Hub isn't running.
        if (isDesktopApp()) void pushEmployeesCache(e).catch(() => {});
      })
      .catch(() => {
        // loadOffline() manages its own setLoading(false) once the Local
        // Hub read actually resolves - not set here too, or the list would
        // flash "No staff members yet" for a moment while it's still loading.
        if (isDesktopApp()) void loadOffline();
        else { toast.error("Failed to load staff."); setLoading(false); }
      });
  };

  // Loads on mount, and again any time connectivity flips (either
  // direction) rather than waiting for the next manual Refresh - e.g. a
  // staff member queued while offline should disappear from "queued"
  // display once it actually syncs shortly after reconnecting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [isOnline]);

  const roleName = (emp: EmployeeSummary) => {
    if (emp.employeeRoleId && typeof emp.employeeRoleId === "object") return emp.employeeRoleId.name;
    return roles.find((r) => r._id === emp.employeeRoleId)?.name || "—";
  };

  const toggleActive = async (emp: EmployeeSummary) => {
    if (offline) {
      await saveEmployeeEditOffline(emp, { isActive: !emp.isActive }, roles);
    } else {
      await shopApi.updateEmployee(emp._id, { isActive: !emp.isActive });
    }
    load();
  };

  const removeEmployee = async (emp: EmployeeSummary) => {
    const confirmed = await confirm(`Remove staff member "${emp.name}"?`, { title: "Remove staff member", confirmText: "Remove", tone: "danger" });
    if (!confirmed) return;
    if (offline) {
      await deleteEmployeeOffline(emp);
    } else {
      await shopApi.deleteEmployee(emp._id);
    }
    load();
    toast.success(`"${emp.name}" removed.`);
  };

  const removeRole = async (role: RoleSummary) => {
    const confirmed = await confirm(`Delete role "${role.name}"?`, { title: "Delete role", confirmText: "Delete", tone: "danger" });
    if (!confirmed) return;
    try {
      await shopApi.deleteRole(role._id);
      load();
      toast.success(`Role "${role.name}" deleted.`);
    } catch (err: any) {
      toast.error(err?.response?.data?.message || "Failed to delete role");
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Manage Staff</h1>
            {offline ? (
              <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-700">
                <WifiOff size={12} /> Offline — changes will sync automatically
              </span>
            ) : null}
          </div>
          <p className="text-sm text-gray-500">Staff accounts, designations, directory details, and the roles that control what they can see and do.</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={load} disabled={loading} className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-60">
            <RefreshCcw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {tab === "employees" ? (
            <button type="button" onClick={() => setShowCreateEmployee(true)} className="flex items-center gap-2 rounded-full bg-black px-4 py-2.5 text-sm font-bold text-white">
              <Plus size={16} /> New Staff Member
            </button>
          ) : (
            <button type="button" onClick={() => setShowRoleEditor("new")} className="flex items-center gap-2 rounded-full bg-black px-4 py-2.5 text-sm font-bold text-white">
              <Plus size={16} /> New Role
            </button>
          )}
        </div>
      </div>

      <div className="mb-6 flex gap-2">
        <TabButton active={tab === "employees"} onClick={() => setTab("employees")}>Staff</TabButton>
        <TabButton active={tab === "roles"} onClick={() => setTab("roles")}>Roles &amp; Permissions</TabButton>
      </div>

      {tab === "employees" ? (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Designation</th>
                <th className="px-4 py-3">Username</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Loading...</td></tr>
              ) : employees.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No staff members yet.</td></tr>
              ) : (
                employees.map((emp) => (
                  <tr key={emp._id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-semibold">{emp.name}</td>
                    <td className="px-4 py-3">
                      {emp.designation ? (
                        <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-700">{emp.designation}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500">@{emp.username}</td>
                    <td className="px-4 py-3 text-gray-500">{emp.phone || "—"}</td>
                    <td className="px-4 py-3">{roleName(emp)}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => toggleActive(emp)}
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${emp.isActive ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}
                      >
                        {emp.isActive ? "Active" : "Disabled"}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button type="button" title="View full details" onClick={() => setViewTarget(emp)} className="rounded-full border border-gray-200 p-2 text-gray-500 hover:bg-gray-100">
                          <Eye size={15} />
                        </button>
                        <button type="button" title="Edit staff details" onClick={() => setEditTarget(emp)} className="rounded-full border border-gray-200 p-2 text-gray-500 hover:bg-gray-100">
                          <Pencil size={15} />
                        </button>
                        <button type="button" title="Grant or revoke individual permissions" onClick={() => setPermTarget(emp)} className="rounded-full border border-gray-200 p-2 text-gray-500 hover:bg-gray-100">
                          <ShieldPlus size={15} />
                        </button>
                        <button type="button" title="Reset password" onClick={() => setResetTarget(emp)} className="rounded-full border border-gray-200 p-2 text-gray-500 hover:bg-gray-100">
                          <KeyRound size={15} />
                        </button>
                        <button type="button" title="Remove" onClick={() => removeEmployee(emp)} className="rounded-full border border-gray-200 p-2 text-red-500 hover:bg-red-50">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {roles.map((role) => (
            <div key={role._id} className="rounded-2xl border border-gray-200 bg-white p-5">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold"><ShieldCheck size={16} className="text-gray-400" /> {role.name}</div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowRoleEditor(role)} className="text-xs font-semibold text-gray-500 hover:text-black">Edit</button>
                  <button type="button" onClick={() => removeRole(role)} className="text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                </div>
              </div>
              {role.hideDashboard ? (
                <span className="mb-1.5 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Hides Dashboard</span>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {role.permissions.length === 0 ? (
                  <span className="text-xs text-gray-400">No permissions assigned</span>
                ) : (
                  role.permissions.map((p) => (
                    <span key={p} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{p}</span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateEmployee ? (
        <StaffFormModal roles={roles} offline={offline} onClose={() => setShowCreateEmployee(false)} onSaved={load} />
      ) : null}
      {editTarget ? (
        <StaffFormModal roles={roles} offline={offline} employee={editTarget} onClose={() => setEditTarget(null)} onSaved={load} />
      ) : null}
      {viewTarget ? (
        <StaffDetailsModal
          employee={viewTarget}
          roleLabel={roleName(viewTarget)}
          onClose={() => setViewTarget(null)}
          onEdit={() => { setEditTarget(viewTarget); setViewTarget(null); }}
        />
      ) : null}
      {permTarget ? (
        <EmployeePermissionsModal
          employee={permTarget}
          roles={roles}
          permissions={permissions}
          onClose={() => setPermTarget(null)}
          onSaved={load}
        />
      ) : null}
      {showRoleEditor ? (
        <RoleEditorModal
          role={showRoleEditor === "new" ? null : showRoleEditor}
          permissions={permissions}
          onClose={() => setShowRoleEditor(null)}
          onSaved={load}
        />
      ) : null}
      {resetTarget ? <ResetEmployeePasswordModal employee={resetTarget} onClose={() => setResetTarget(null)} /> : null}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${active ? "bg-black text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
    >
      {children}
    </button>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 text-gray-400 hover:bg-gray-100"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Read-only view of everything on file for one staff member - the Manage
// Staff table itself only has room for name/designation/username/phone/
// role/status, so this is where directory details (ID card, address,
// vehicle number, reference, salary, comment) actually show up without
// having to open Edit (and risk accidentally changing something). Rider-
// specific fields (vehicle number) only render when there's actually a
// value, same idea as StaffFormModal only offering that field for a
// Delivery Rider designation.
function StaffDetailsModal({
  employee,
  roleLabel,
  onClose,
  onEdit,
}: {
  employee: EmployeeSummary;
  roleLabel: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["Full Name", employee.name || "—"],
    ["Username", `@${employee.username}`],
    ["Designation", employee.designation || "—"],
    ["Role", roleLabel],
    ["Status", employee.isActive ? "Active" : "Disabled"],
    ["Email", employee.email || "—"],
    ["Phone Number", employee.phone || "—"],
    ["ID Card Number", employee.idCardNumber || "—"],
    ["Address", employee.address || "—"],
    ...(employee.vehicleNumber ? ([["Vehicle / Bike Number", employee.vehicleNumber]] as Array<[string, string]>) : []),
    ["Reference", employee.reference || "—"],
    ["Monthly Salary", employee.monthlySalary ? `PKR ${employee.monthlySalary.toLocaleString()}` : "—"],
    ["Comment", employee.comment || "—"],
  ];

  return (
    <ModalShell title={`Staff Details — ${employee.name || employee.username}`} onClose={onClose}>
      <div className="max-h-[65vh] space-y-2 overflow-y-auto pr-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-4 border-b border-gray-100 py-2 last:border-0">
            <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</span>
            <span className="text-right font-medium text-gray-800">{value}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="mt-4 w-full rounded-lg bg-black py-2 font-bold text-white"
      >
        Edit Details
      </button>
    </ModalShell>
  );
}

// Handles both "New Staff Member" and "Edit Staff Member" - the same
// fields either way, just pre-filled and PATCHed instead of POSTed when
// `employee` is passed in.
function StaffFormModal({
  roles,
  employee,
  offline = false,
  onClose,
  onSaved,
}: {
  roles: RoleSummary[];
  employee?: EmployeeSummary;
  offline?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = Boolean(employee);
  const initialRoleId = employee?.employeeRoleId
    ? (typeof employee.employeeRoleId === "object" ? employee.employeeRoleId._id : employee.employeeRoleId)
    : "";
  const [form, setForm] = useState({
    name: employee?.name || "",
    username: employee?.username || "",
    password: "",
    email: employee?.email || "",
    phone: employee?.phone || "",
    roleId: initialRoleId || "",
    designation: employee?.designation || "",
    customDesignation: "",
    idCardNumber: employee?.idCardNumber || "",
    address: employee?.address || "",
    vehicleNumber: employee?.vehicleNumber || "",
    reference: employee?.reference || "",
    comment: employee?.comment || "",
    monthlySalary: employee?.monthlySalary ? String(employee.monthlySalary) : "",
  });
  const [useCustomDesignation, setUseCustomDesignation] = useState(
    Boolean(employee?.designation) && !STAFF_DESIGNATIONS.includes(employee?.designation as any)
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Shows the rider-only Vehicle/Bike Number field once the chosen
  // designation looks like "Delivery Rider" (handles the custom-typed
  // case too, not just the dropdown pick) - see waiterController.getRiders,
  // which does the same case-insensitive match on the backend.
  const currentDesignation = useCustomDesignation ? form.customDesignation : form.designation;
  const isRider = /delivery rider/i.test(currentDesignation);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    const designation = useCustomDesignation ? form.customDesignation.trim() : form.designation;
    const payload: Record<string, unknown> = {
      name: form.name,
      email: form.email,
      phone: form.phone,
      roleId: form.roleId,
      designation,
      idCardNumber: form.idCardNumber,
      address: form.address,
      vehicleNumber: form.vehicleNumber,
      reference: form.reference,
      comment: form.comment,
      monthlySalary: form.monthlySalary ? Number(form.monthlySalary) : 0,
    };
    try {
      if (isEdit && employee) {
        if (form.username !== employee.username) payload.username = form.username;
        if (offline) {
          await saveEmployeeEditOffline(employee, payload, roles);
        } else {
          await shopApi.updateEmployee(employee._id, payload);
        }
      } else {
        payload.username = form.username;
        payload.password = form.password;
        if (offline) {
          // Denormalize the role's name alongside its id purely for
          // display - the Local Hub queue has no live cloud role lookup to
          // resolve it from (see offline-staff-helpers.ts's
          // localEmployeeToSummary). The real roleId is still what actually
          // gets sent to the cloud once this syncs for real.
          payload.roleName = roles.find((r) => r._id === form.roleId)?.name || "";
          payload.isActive = true;
          await queueEmployeeCreate(payload);
        } else {
          await shopApi.createEmployee(payload);
        }
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || `Failed to ${isEdit ? "update" : "create"} staff member`);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = isEdit
    ? Boolean(form.username && form.roleId)
    : Boolean(form.username && form.password && form.roleId);

  return (
    <ModalShell title={isEdit ? `Edit Staff — ${employee?.name || employee?.username}` : "New Staff Member"} onClose={onClose}>
      <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 text-sm">
        <TextField label="Full Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Username" value={form.username} onChange={(v) => setForm({ ...form, username: v })} />
          {isEdit ? (
            <div className="flex items-end pb-2 text-xs text-gray-400">Use "Reset password" to change the password.</div>
          ) : (
            <TextField label="Password" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Email (optional)" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
          <TextField label="Phone Number" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
        </div>

        <div>
          <label className="mb-1 block text-xs text-gray-500">Role (permissions)</label>
          <select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2">
            <option value="">Select a role</option>
            {roles.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-gray-500">
            Designation (job title - Waiter/Order Taker show up in the POS waiter list)
          </label>
          {useCustomDesignation ? (
            <div className="flex gap-2">
              <input
                type="text"
                value={form.customDesignation}
                onChange={(e) => setForm({ ...form, customDesignation: e.target.value })}
                placeholder="e.g. Barista"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10"
              />
              <button type="button" onClick={() => setUseCustomDesignation(false)} className="whitespace-nowrap rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-600 hover:bg-gray-50">
                Choose from list
              </button>
            </div>
          ) : (
            <select
              value={form.designation}
              onChange={(e) => {
                if (e.target.value === "__custom__") { setUseCustomDesignation(true); return; }
                setForm({ ...form, designation: e.target.value });
              }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2"
            >
              <option value="">Select a designation</option>
              {STAFF_DESIGNATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value="__custom__">Other (type custom)…</option>
            </select>
          )}
        </div>

        <TextField label="ID Card Number" value={form.idCardNumber} onChange={(v) => setForm({ ...form, idCardNumber: v })} />
        <TextField label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
        {isRider ? (
          <TextField
            label="Vehicle / Bike Number"
            value={form.vehicleNumber}
            onChange={(v) => setForm({ ...form, vehicleNumber: v })}
          />
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Reference" value={form.reference} onChange={(v) => setForm({ ...form, reference: v })} />
          <TextField label="Monthly Salary" type="number" value={form.monthlySalary} onChange={(v) => setForm({ ...form, monthlySalary: v })} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">Comment</label>
          <textarea
            value={form.comment}
            onChange={(e) => setForm({ ...form, comment: e.target.value })}
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
      </div>
      {error ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-600">{error}</div> : null}
      <button
        type="button"
        disabled={submitting || !canSubmit}
        onClick={submit}
        className="mt-4 w-full rounded-lg bg-black py-2 font-bold text-white disabled:opacity-50"
      >
        {submitting ? "Saving..." : isEdit ? "Save Changes" : "Create Staff Member"}
      </button>
    </ModalShell>
  );
}

function ResetEmployeePasswordModal({ employee, onClose }: { employee: EmployeeSummary; onClose: () => void }) {
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await shopApi.resetEmployeePassword(employee._id, newPassword);
      setDone(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to reset password");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ModalShell title="Password Reset" onClose={onClose}>
        <p className="text-sm text-gray-600">The staff member's password has been updated.</p>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-lg bg-black py-2 font-bold text-white">Done</button>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={`Reset Password — ${employee.name}`} onClose={onClose}>
      <TextField label="New Password" type="password" value={newPassword} onChange={setNewPassword} />
      {error ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-600">{error}</div> : null}
      <button type="button" disabled={submitting || newPassword.length < 6} onClick={submit} className="mt-4 w-full rounded-lg bg-black py-2 font-bold text-white disabled:opacity-50">
        {submitting ? "Saving..." : "Reset Password"}
      </button>
    </ModalShell>
  );
}

function RoleEditorModal({
  role,
  permissions,
  onClose,
  onSaved,
}: {
  role: RoleSummary | null;
  permissions: PermissionDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name || "");
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions || []));
  // Dashboard Permission Gate: "If a specific staff role has this
  // permission restricted, they must not see or access the main Dashboard
  // page upon logging in." Defaults to false (Dashboard visible, same as
  // every role before this existed) - only an explicit check hides it.
  const [hideDashboard, setHideDashboard] = useState(Boolean(role?.hideDashboard));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const grouped = permissions.reduce<Record<string, PermissionDef[]>>((acc, p) => {
    (acc[p.module] ||= []).push(p);
    return acc;
  }, {});

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const payload = { name, permissions: Array.from(selected), hideDashboard };
      if (role) {
        await shopApi.updateRole(role._id, payload);
      } else {
        await shopApi.createRole(payload);
      }
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to save role");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={role ? `Edit Role — ${role.name}` : "New Role"} onClose={onClose}>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        <TextField label="Role Name" value={name} onChange={setName} />
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={hideDashboard} onChange={(e) => setHideDashboard(e.target.checked)} />
            <span>
              <span className="font-medium">Hide Dashboard</span>
              <span className="block text-xs text-gray-500">Staff with this role won't see or be able to open the main Dashboard home page after logging in - they land on their first available page instead.</span>
            </span>
          </label>
        </div>
        {Object.entries(grouped).map(([module, perms]) => (
          <div key={module}>
            <div className="mb-1 text-xs font-semibold uppercase text-gray-400">{module}</div>
            <div className="space-y-1">
              {perms.map((p) => (
                <label key={p.key} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5" checked={selected.has(p.key)} onChange={() => toggle(p.key)} />
                  <span>
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-xs text-gray-400">{p.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      {error ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-600">{error}</div> : null}
      <button type="button" disabled={submitting || !name} onClick={submit} className="mt-4 w-full rounded-lg bg-black py-2 font-bold text-white disabled:opacity-50">
        {submitting ? "Saving..." : "Save Role"}
      </button>
    </ModalShell>
  );
}

// Dynamic Permissions: "the Admin must have the capability to manually
// edit an individual staff account later to grant or revoke specific
// additional page permissions dynamically" - every checkbox starts at
// exactly what this ONE account's role grants (roleBasePermissions), so an
// admin only ever has to touch the handful of keys they actually want to
// differ. Saving computes the diff against that same base and sends it as
// two small arrays (extraPermissions/revokedPermissions) rather than one
// flat "final list" - that's what backend/models/User.js actually stores,
// so the override survives the employee later being reassigned to a
// different role (see authController.resolveEmployeePermissions).
function EmployeePermissionsModal({
  employee,
  roles,
  permissions,
  onClose,
  onSaved,
}: {
  employee: EmployeeSummary;
  roles: RoleSummary[];
  permissions: PermissionDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const roleBasePermissions = useMemo(() => {
    if (employee.employeeRoleId && typeof employee.employeeRoleId === "object") return employee.employeeRoleId.permissions;
    return roles.find((r) => r._id === employee.employeeRoleId)?.permissions || [];
  }, [employee, roles]);
  const roleBaseSet = new Set(roleBasePermissions);

  const [selected, setSelected] = useState<Set<string>>(() => {
    const extra = employee.extraPermissions || [];
    const revoked = new Set(employee.revokedPermissions || []);
    return new Set([...roleBasePermissions, ...extra].filter((key) => !revoked.has(key)));
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const grouped = permissions.reduce<Record<string, PermissionDef[]>>((acc, p) => {
    (acc[p.module] ||= []).push(p);
    return acc;
  }, {});

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const extraPermissions = Array.from(selected).filter((key) => !roleBaseSet.has(key));
      const revokedPermissions = roleBasePermissions.filter((key) => !selected.has(key));
      await shopApi.updateEmployee(employee._id, { extraPermissions, revokedPermissions });
      toast.success(`Permissions updated for "${employee.name}".`);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.message || "Failed to save permissions");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Permissions — ${employee.name}`} onClose={onClose}>
      <p className="mb-4 text-xs text-gray-500">
        Starts from this account's role. Check a box to grant that permission to <span className="font-semibold">{employee.name}</span> specifically; uncheck one their role would otherwise grant to take it away - just for this account.
      </p>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {Object.entries(grouped).map(([module, perms]) => (
          <div key={module}>
            <div className="mb-1 text-xs font-semibold uppercase text-gray-400">{module}</div>
            <div className="space-y-1">
              {perms.map((p) => {
                const fromRole = roleBaseSet.has(p.key);
                const isChecked = selected.has(p.key);
                const isOverridden = isChecked !== fromRole;
                return (
                  <label key={p.key} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5" checked={isChecked} onChange={() => toggle(p.key)} />
                    <span>
                      <span className="font-medium">{p.label}</span>
                      {isOverridden ? (
                        <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${isChecked ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"}`}>
                          {isChecked ? "Added" : "Removed"}
                        </span>
                      ) : fromRole ? (
                        <span className="ml-2 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gray-500">Role default</span>
                      ) : null}
                      <span className="block text-xs text-gray-400">{p.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {error ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-600">{error}</div> : null}
      <button type="button" disabled={submitting} onClick={submit} className="mt-4 w-full rounded-lg bg-black py-2 font-bold text-white disabled:opacity-50">
        {submitting ? "Saving..." : "Save Permissions"}
      </button>
    </ModalShell>
  );
}

function TextField({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10" />
    </div>
  );
}
