
import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2, Users, UserRoundCheck, UserRoundX } from "lucide-react";
import { createWaiter, deleteWaiter, fetchWaiters, updateWaiter } from "@/lib/pos-api";
import { Waiter } from "@/lib/pos-types";

export function WaiterManagementSection({
  title = "Waiter Directory",
  description = "Add, update, activate, or remove waiters for this restaurant. The same list is used in POS order entry.",
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [newWaiterName, setNewWaiterName] = useState("");
  const [editingWaiterId, setEditingWaiterId] = useState<string | null>(null);
  const [editingWaiterName, setEditingWaiterName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    void loadWaiters();
  }, []);

  const activeWaiters = useMemo(() => waiters.filter((waiter) => waiter.isActive).length, [waiters]);

  async function loadWaiters() {
    try {
      setIsLoading(true);
      const result = await fetchWaiters();
      setWaiters(result);
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load waiters." });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAddWaiter() {
    const name = newWaiterName.trim();
    if (!name) {
      setStatusMessage({ tone: "error", text: "Enter a waiter name first." });
      return;
    }

    try {
      setIsSaving(true);
      const created = await createWaiter({ name, isActive: true });
      setWaiters((previous) => [...previous, created].sort((left, right) => left.name.localeCompare(right.name)));
      setNewWaiterName("");
      setStatusMessage({ tone: "success", text: `Waiter "${created.name}" added.` });
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to add waiter." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveWaiter(waiterId: string) {
    const name = editingWaiterName.trim();
    if (!name) {
      setStatusMessage({ tone: "error", text: "Waiter name cannot be empty." });
      return;
    }

    try {
      setIsSaving(true);
      const updated = await updateWaiter(waiterId, { name });
      setWaiters((previous) => previous.map((waiter) => waiter.id === waiterId ? updated : waiter).sort((left, right) => left.name.localeCompare(right.name)));
      setEditingWaiterId(null);
      setEditingWaiterName("");
      setStatusMessage({ tone: "success", text: `Waiter "${updated.name}" updated.` });
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to update waiter." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggleWaiter(waiter: Waiter) {
    try {
      setIsSaving(true);
      const updated = await updateWaiter(waiter.id, { isActive: !waiter.isActive });
      setWaiters((previous) => previous.map((entry) => entry.id === waiter.id ? updated : entry).sort((left, right) => left.name.localeCompare(right.name)));
      setStatusMessage({ tone: "success", text: `Waiter "${updated.name}" ${updated.isActive ? "activated" : "deactivated"}.` });
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to update waiter status." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteWaiter(waiter: Waiter) {
    try {
      setIsSaving(true);
      await deleteWaiter(waiter.id);
      setWaiters((previous) => previous.filter((entry) => entry.id !== waiter.id));
      if (editingWaiterId === waiter.id) {
        setEditingWaiterId(null);
        setEditingWaiterName("");
      }
      setStatusMessage({ tone: "success", text: `Waiter "${waiter.name}" deleted.` });
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to delete waiter." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={cardClassName}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Users size={18} className="text-indigo-600" />
            <h3 className="text-lg font-black text-slate-900">{title}</h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">{description}</p>
        </div>
        <div className="rounded-3xl bg-slate-50 px-4 py-3 text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Active Waiters</p>
          <p className="text-2xl font-black text-slate-900">{activeWaiters}</p>
        </div>
      </div>

      {statusMessage ? (
        <div className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${statusMessage.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {statusMessage.text}
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 md:flex-row">
        <input
          type="text"
          value={newWaiterName}
          onChange={(event) => setNewWaiterName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleAddWaiter();
            }
          }}
          placeholder="Enter waiter name"
          className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium outline-none focus:border-indigo-400"
        />
        <button
          type="button"
          onClick={() => void handleAddWaiter()}
          disabled={isSaving}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={16} />
          Add Waiter
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {isLoading ? <div className="rounded-3xl bg-slate-50 px-4 py-5 text-sm text-slate-500">Loading waiters...</div> : null}
        {!isLoading && waiters.length === 0 ? <div className="rounded-3xl bg-slate-50 px-4 py-5 text-sm text-slate-500">No waiters saved yet.</div> : null}
        {!isLoading ? waiters.map((waiter) => {
          const isEditing = editingWaiterId === waiter.id;

          return (
            <div key={waiter.id} className="flex flex-col gap-3 rounded-3xl border border-slate-100 bg-slate-50 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-1 items-center gap-3">
                <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${waiter.isActive ? "bg-emerald-100 text-emerald-600" : "bg-slate-200 text-slate-500"}`}>
                  {waiter.isActive ? <UserRoundCheck size={18} /> : <UserRoundX size={18} />}
                </div>
                <div className="flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingWaiterName}
                      onChange={(event) => setEditingWaiterName(event.target.value)}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold outline-none focus:border-indigo-400"
                    />
                  ) : (
                    <p className="text-sm font-black text-slate-900">{waiter.name}</p>
                  )}
                  <p className="mt-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">{waiter.isActive ? "Available in POS" : "Hidden from POS"}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleSaveWaiter(waiter.id)}
                      disabled={isSaving}
                      className="rounded-2xl bg-indigo-600 px-4 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingWaiterId(null);
                        setEditingWaiterName("");
                      }}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingWaiterId(waiter.id);
                      setEditingWaiterName(waiter.name);
                    }}
                    className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700"
                  >
                    <Pencil size={14} />
                    Update
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleToggleWaiter(waiter)}
                  disabled={isSaving}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {waiter.isActive ? "Deactivate" : "Activate"}
                </button>

                <button
                  type="button"
                  onClick={() => void handleDeleteWaiter(waiter)}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 rounded-2xl bg-rose-50 px-4 py-2 text-xs font-black text-rose-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </div>
          );
        }) : null}
      </div>
    </div>
  );
}
