
import { useEffect, useMemo, useState } from "react";
import { Clock, Heart, Pencil, Plus, Table2, Trash2 } from "lucide-react";
import { createTable, deleteTable, fetchTables, fetchTableSettings, updateTable, updateTableSettings } from "@/lib/pos-api";
import { Table } from "@/lib/pos-types";

function sortTables(tables: Table[]) {
  return [...tables].sort((left, right) => {
    const leftNumber = Number(left.name);
    const rightNumber = Number(right.name);
    const leftIsNumeric = left.name.trim() !== "" && !Number.isNaN(leftNumber);
    const rightIsNumeric = right.name.trim() !== "" && !Number.isNaN(rightNumber);

    if (leftIsNumeric && rightIsNumeric) return leftNumber - rightNumber;
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return left.name.localeCompare(right.name);
  });
}

export function TableManagementSection({
  title = "Dining Tables",
  description = "Mark a table as a Family Table to call it out on the Dine-In screen so staff can seat families accurately.",
  cardClassName = "rounded-[28px] border border-slate-200 bg-white p-6",
}: {
  title?: string;
  description?: string;
  cardClassName?: string;
}) {
  const [tables, setTables] = useState<Table[]>([]);
  const [newTableName, setNewTableName] = useState("");
  const [newTableIsFamily, setNewTableIsFamily] = useState(false);
  const [editingTableId, setEditingTableId] = useState<string | null>(null);
  const [editingTableName, setEditingTableName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  // The estimated combined prep + dining duration (minutes) that drives the
  // Dine-In table availability countdown on the POS screen - see
  // POSPage.tsx's getTableRemainingMs. Shop-wide, not per-table: once a
  // DineIn order is placed on any table, that table stays locked for this
  // long (or until it's paid, whichever happens first), then re-opens
  // automatically either way.
  const [turnoverMinutesInput, setTurnoverMinutesInput] = useState("45");
  const [isLoadingTurnover, setIsLoadingTurnover] = useState(true);
  const [isSavingTurnover, setIsSavingTurnover] = useState(false);

  useEffect(() => {
    void loadTables();
    void loadTurnoverMinutes();
  }, []);

  const familyTableCount = useMemo(() => tables.filter((table) => table.isFamily).length, [tables]);

  async function loadTurnoverMinutes() {
    try {
      setIsLoadingTurnover(true);
      const settings = await fetchTableSettings();
      if (settings?.tableTurnoverMinutes) setTurnoverMinutesInput(String(settings.tableTurnoverMinutes));
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load the table timer setting." });
    } finally {
      setIsLoadingTurnover(false);
    }
  }

  async function handleSaveTurnoverMinutes() {
    const minutes = Number(turnoverMinutesInput);
    if (!Number.isFinite(minutes) || minutes < 1) {
      setStatusMessage({ tone: "error", text: "Enter a table timer of at least 1 minute." });
      return;
    }

    try {
      setIsSavingTurnover(true);
      const updated = await updateTableSettings({ tableTurnoverMinutes: Math.round(minutes) });
      if (updated) {
        setTurnoverMinutesInput(String(updated.tableTurnoverMinutes));
        setStatusMessage({ tone: "success", text: `Tables now free up ${updated.tableTurnoverMinutes} minutes after an order is placed.` });
      }
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to save the table timer setting." });
    } finally {
      setIsSavingTurnover(false);
    }
  }

  async function loadTables() {
    try {
      setIsLoading(true);
      const result = await fetchTables();
      setTables(sortTables(result ?? []));
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to load tables." });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleAddTable() {
    const name = newTableName.trim();
    if (!name) {
      setStatusMessage({ tone: "error", text: "Enter a table name/number first." });
      return;
    }

    try {
      setIsSaving(true);
      const created = await createTable({ name, isFamily: newTableIsFamily, isActive: true });
      if (created) {
        setTables((previous) => sortTables([...previous, created]));
        setStatusMessage({ tone: "success", text: `Table "${created.name}" added.` });
      }
      setNewTableName("");
      setNewTableIsFamily(false);
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to add table." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveTable(tableId: string) {
    const name = editingTableName.trim();
    if (!name) {
      setStatusMessage({ tone: "error", text: "Table name cannot be empty." });
      return;
    }

    try {
      setIsSaving(true);
      const updated = await updateTable(tableId, { name });
      if (updated) {
        setTables((previous) => sortTables(previous.map((table) => (table.id === tableId ? updated : table))));
        setStatusMessage({ tone: "success", text: `Table "${updated.name}" updated.` });
      }
      setEditingTableId(null);
      setEditingTableName("");
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to update table." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggleFamily(table: Table) {
    try {
      setIsSaving(true);
      const updated = await updateTable(table.id, { isFamily: !table.isFamily });
      if (updated) {
        setTables((previous) => sortTables(previous.map((entry) => (entry.id === table.id ? updated : entry))));
        setStatusMessage({ tone: "success", text: `Table "${updated.name}" ${updated.isFamily ? "marked as a Family Table" : "no longer a Family Table"}.` });
      }
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to update table." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggleActive(table: Table) {
    try {
      setIsSaving(true);
      const updated = await updateTable(table.id, { isActive: !table.isActive });
      if (updated) {
        setTables((previous) => sortTables(previous.map((entry) => (entry.id === table.id ? updated : entry))));
        setStatusMessage({ tone: "success", text: `Table "${updated.name}" ${updated.isActive ? "activated" : "deactivated"}.` });
      }
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to update table status." });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteTable(table: Table) {
    try {
      setIsSaving(true);
      await deleteTable(table.id);
      setTables((previous) => previous.filter((entry) => entry.id !== table.id));
      if (editingTableId === table.id) {
        setEditingTableId(null);
        setEditingTableName("");
      }
      setStatusMessage({ tone: "success", text: `Table "${table.name}" deleted.` });
    } catch (error) {
      setStatusMessage({ tone: "error", text: error instanceof Error ? error.message : "Failed to delete table." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={cardClassName}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Table2 size={18} className="text-pink-600" />
            <h3 className="text-lg font-black text-slate-900">{title}</h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">{description}</p>
        </div>
        <div className="glass-pill rounded-3xl px-4 py-3 text-right">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Family Tables</p>
          <p className="text-2xl font-black text-slate-900">{familyTableCount}</p>
        </div>
      </div>

      {statusMessage ? (
        <div className={`mt-5 rounded-2xl px-4 py-3 text-sm shadow-inner ${statusMessage.tone === "success" ? "bg-emerald-50/70 text-emerald-700" : "bg-rose-50/70 text-rose-700"}`}>
          {statusMessage.text}
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 rounded-3xl bg-white/40 p-4 shadow-inner sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-100/80 text-indigo-600 shadow-inner">
            <Clock size={18} />
          </div>
          <div>
            <p className="text-sm font-black text-slate-900">Table Availability Timer</p>
            <p className="text-[11px] font-bold text-slate-400">Combined prep + dining time before a table auto-frees on the Dine-In screen.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={turnoverMinutesInput}
            onChange={(event) => setTurnoverMinutesInput(event.target.value)}
            disabled={isLoadingTurnover}
            className="w-20 rounded-2xl border border-white/60 bg-white/60 px-3 py-2.5 text-sm font-black text-slate-900 shadow-inner outline-none focus:border-indigo-400 disabled:opacity-60"
          />
          <span className="text-xs font-bold text-slate-400">minutes</span>
          <button
            type="button"
            onClick={() => void handleSaveTurnoverMinutes()}
            disabled={isSavingTurnover || isLoadingTurnover}
            className="glass-dark rounded-2xl px-4 py-2.5 text-xs font-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center">
        <input
          type="text"
          value={newTableName}
          onChange={(event) => setNewTableName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleAddTable();
            }
          }}
          placeholder="Enter table name/number"
          className="flex-1 rounded-2xl border border-white/60 bg-white/50 px-4 py-3 text-sm font-medium shadow-inner outline-none focus:border-pink-400"
        />
        <label className="flex items-center gap-2 rounded-2xl border border-white/60 bg-white/50 px-4 py-3 text-sm font-bold text-slate-600 shadow-inner">
          <input
            type="checkbox"
            checked={newTableIsFamily}
            onChange={(event) => setNewTableIsFamily(event.target.checked)}
            className="h-4 w-4 rounded accent-pink-500"
          />
          Family Table
        </label>
        <button
          type="button"
          onClick={() => void handleAddTable()}
          disabled={isSaving}
          className="glass-dark inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={16} />
          Add Table
        </button>
      </div>

      <div className="mt-6 space-y-3">
        {isLoading ? <div className="rounded-3xl bg-white/40 px-4 py-5 text-sm text-slate-500 shadow-inner">Loading tables...</div> : null}
        {!isLoading && tables.length === 0 ? <div className="rounded-3xl bg-white/40 px-4 py-5 text-sm text-slate-500 shadow-inner">No tables saved yet.</div> : null}
        {!isLoading ? tables.map((table) => {
          const isEditing = editingTableId === table.id;

          return (
            <div key={table.id} className="flex flex-col gap-3 rounded-3xl bg-white/40 p-4 shadow-inner lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-1 items-center gap-3">
                <div className={`flex h-11 w-11 items-center justify-center rounded-2xl shadow-inner ${table.isFamily ? "bg-pink-100/80 text-pink-600" : "bg-slate-200/70 text-slate-500"}`}>
                  {table.isFamily ? <Heart size={18} fill="currentColor" /> : <Table2 size={18} />}
                </div>
                <div className="flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingTableName}
                      onChange={(event) => setEditingTableName(event.target.value)}
                      className="w-full rounded-2xl border border-white/60 bg-white/60 px-4 py-2.5 text-sm font-semibold shadow-inner outline-none focus:border-pink-400"
                    />
                  ) : (
                    <p className="text-sm font-black text-slate-900">Table {table.name}</p>
                  )}
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                    <span>{table.isActive ? "Available in POS" : "Hidden from POS"}</span>
                    {table.isFamily ? <span className="rounded-full bg-pink-100/80 px-2 py-0.5 text-pink-600">Family Table</span> : null}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleSaveTable(table.id)}
                      disabled={isSaving}
                      className="rounded-2xl border-[0.5px] border-white/30 bg-gradient-to-b from-indigo-500 to-indigo-700 px-4 py-2 text-xs font-black text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(49,46,129,0.5)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTableId(null);
                        setEditingTableName("");
                      }}
                      className="glass-pill rounded-2xl px-4 py-2 text-xs font-black text-slate-700"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingTableId(table.id);
                      setEditingTableName(table.name);
                    }}
                    className="glass-pill inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-xs font-black text-slate-700"
                  >
                    <Pencil size={14} />
                    Update
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void handleToggleFamily(table)}
                  disabled={isSaving}
                  className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-xs font-black disabled:cursor-not-allowed disabled:opacity-60 ${table.isFamily ? "border-[0.5px] border-white/30 bg-gradient-to-b from-pink-400 to-pink-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(157,23,77,0.5)]" : "glass-pill text-slate-700"}`}
                >
                  <Heart size={14} fill={table.isFamily ? "currentColor" : "none"} />
                  {table.isFamily ? "Family Table" : "Mark as Family"}
                </button>

                <button
                  type="button"
                  onClick={() => void handleToggleActive(table)}
                  disabled={isSaving}
                  className="glass-pill rounded-2xl px-4 py-2 text-xs font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {table.isActive ? "Deactivate" : "Activate"}
                </button>

                <button
                  type="button"
                  onClick={() => void handleDeleteTable(table)}
                  disabled={isSaving}
                  className="inline-flex items-center gap-2 rounded-2xl bg-rose-50/70 px-4 py-2 text-xs font-black text-rose-600 shadow-inner disabled:cursor-not-allowed disabled:opacity-60"
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
