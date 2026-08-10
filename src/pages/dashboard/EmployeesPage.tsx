import { useEffect, useState, type ReactNode } from "react";
import { Plus, KeyRound, Trash2, X, ShieldCheck, RefreshCcw, Pencil } from "lucide-react";
import { shopApi, type EmployeeSummary, type RoleSummary, type PermissionDef } from "@/lib/shop-api";
import { STAFF_DESIGNATIONS } from "@/lib/staff-designations";
import { useToast } from "@/lib/toast";

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
  const [tab, setTab] = useState<"employees" | "roles">("employees");
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [permissions, setPermissions] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateEmployee, setShowCreateEmployee] = useState(false);
  const [editTarget, setEditTarget] = useState<EmployeeSummary | null>(null);
  const [showRoleEditor, setShowRoleEditor] = useState<RoleSummary | "new" | null>(null);
  const [resetTarget, setResetTarget] = useState<EmployeeSummary | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([shopApi.listEmployees(), shopApi.listRoles(), shopApi.listPermissions()])
      .then(([e, r, p]) => { setEmployees(e); setRoles(r); setPermissions(p); })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const roleName = (emp: EmployeeSummary) => {
    if (emp.employeeRoleId && typeof emp.employeeRoleId === "object") return emp.employeeRoleId.name;
    return roles.find((r) => r._id === emp.employeeRoleId)?.name || "—";
  };

  const toggleActive = async (emp: EmployeeSummary) => {
    await shopApi.updateEmployee(emp._id, { isActive: !emp.isActive });
    load();
  };

  const removeEmployee = async (emp: EmployeeSummary) => {
    const confirmed = await confirm(`Remove staff member "${emp.name}"?`, { title: "Remove staff member", confirmText: "Remove", tone: "danger" });
    if (!confirmed) return;
    await shopApi.deleteEmployee(emp._id);
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
          <h1 className="text-2xl font-bold">Manage Staff</h1>
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
                        <button type="button" title="Edit staff details" onClick={() => setEditTarget(emp)} className="rounded-full border border-gray-200 p-2 text-gray-500 hover:bg-gray-100">
                          <Pencil size={15} />
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
        <StaffFormModal roles={roles} onClose={() => setShowCreateEmployee(false)} onSaved={load} />
      ) : null}
      {editTarget ? (
        <StaffFormModal roles={roles} employee={editTarget} onClose={() => setEditTarget(null)} onSaved={load} />
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

// Handles both "New Staff Member" and "Edit Staff Member" - the same
// fields either way, just pre-filled and PATCHed instead of POSTed when
// `employee` is passed in.
function StaffFormModal({
  roles,
  employee,
  onClose,
  onSaved,
}: {
  roles: RoleSummary[];
  employee?: EmployeeSummary;
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
    reference: employee?.reference || "",
    comment: employee?.comment || "",
    monthlySalary: employee?.monthlySalary ? String(employee.monthlySalary) : "",
  });
  const [useCustomDesignation, setUseCustomDesignation] = useState(
    Boolean(employee?.designation) && !STAFF_DESIGNATIONS.includes(employee?.designation as any)
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

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
      reference: form.reference,
      comment: form.comment,
      monthlySalary: form.monthlySalary ? Number(form.monthlySalary) : 0,
    };
    try {
      if (isEdit && employee) {
        if (form.username !== employee.username) payload.username = form.username;
        await shopApi.updateEmployee(employee._id, payload);
      } else {
        payload.username = form.username;
        payload.password = form.password;
        await shopApi.createEmployee(payload);
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
      const payload = { name, permissions: Array.from(selected) };
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

function TextField({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-gray-500">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black/10" />
    </div>
  );
}
