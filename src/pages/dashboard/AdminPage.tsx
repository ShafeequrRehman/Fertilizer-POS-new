import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getUsers, createUser, updateUser, deleteUser } from "@/lib/api";
import { getAuthRole } from "@/lib/auth";
import { Plus, Edit, Trash2, Shield, Calendar, X, RefreshCcw } from "lucide-react";
import { useToast } from "@/lib/toast";

interface User {
  _id: string;
  name?: string;
  username: string;
  role: string;
  licenseActive: boolean;
  licenseExpiryDate?: string;
}

export default function AdminPage() {
  const navigate = useNavigate();
  const { toast, confirm } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    username: "",
    password: "",
    role: "admin",
    licenseActive: true,
    licenseExpiryDate: "",
  });

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const data = await getUsers();
      setUsers(data);
    } catch (error) {
      console.error("Failed to fetch users", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (getAuthRole() !== "admin") {
      navigate("/dashboard", { replace: true });
    } else {
      fetchUsers();
    }
  }, []);

  const handleOpenModal = (user?: User) => {
    if (user) {
      setEditingUser(user);
      setFormData({
        name: user.name || "",
        username: user.username,
        password: "", // password is not fetched
        role: user.role,
        licenseActive: user.licenseActive,
        licenseExpiryDate: user.licenseExpiryDate ? user.licenseExpiryDate.substring(0, 10) : "",
      });
    } else {
      setEditingUser(null);
      setFormData({
        name: "",
        username: "",
        password: "",
        role: "admin",
        licenseActive: true,
        licenseExpiryDate: "",
      });
    }
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingUser(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload: any = { ...formData };
      if (!payload.password && editingUser) {
        delete payload.password; // Don't send empty password when editing
      }

      if (editingUser) {
        await updateUser(editingUser._id, payload);
      } else {
        await createUser(payload);
      }
      
      handleCloseModal();
      fetchUsers();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Operation failed");
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirm("Are you sure you want to delete this user?", { title: "Delete user", confirmText: "Delete", tone: "danger" });
    if (!confirmed) return;
    try {
      await deleteUser(id);
      fetchUsers();
      toast.success("User deleted.");
    } catch (error) {
      console.error("Failed to delete user", error);
      toast.error("Failed to delete user.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Admin User Management</h1>
          <p className="text-sm text-gray-500">Manage usernames, passwords, and client licenses.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fetchUsers()}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 shadow-sm transition-all hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshCcw size={16} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => handleOpenModal()}
            className="flex items-center gap-2 rounded-xl bg-black px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-gray-800"
          >
            <Plus size={16} />
            Add User
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-6 py-4 font-medium">Name & Username</th>
                <th className="px-6 py-4 font-medium">Role</th>
                <th className="px-6 py-4 font-medium">License Status</th>
                <th className="px-6 py-4 font-medium">Expiry Date</th>
                <th className="px-6 py-4 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-gray-500">Loading users...</td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-gray-500">No users found.</td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user._id} className="transition-colors hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div className="font-semibold text-gray-900">{user.name || "N/A"}</div>
                      <div className="text-xs text-gray-500">@{user.username}</div>
                    </td>
                    <td className="px-6 py-4 capitalize">
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                        <Shield size={12} />
                        {user.role}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${user.licenseActive ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {user.licenseActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {user.licenseExpiryDate ? new Date(user.licenseExpiryDate).toLocaleDateString() : "Lifetime / No Expiry"}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => handleOpenModal(user)} className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700">
                          <Edit size={16} />
                        </button>
                        <button onClick={() => handleDelete(user._id)} className="rounded p-1.5 text-red-400 transition-colors hover:bg-red-50 hover:text-red-700">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900">{editingUser ? "Edit User & License" : "Create New User"}</h2>
              <button onClick={handleCloseModal} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6">
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                    placeholder="E.g. John Doe"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Username *</label>
                  <input
                    type="text"
                    required
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Password {editingUser ? "(Leave blank to keep)" : "*"}</label>
                  <input
                    type="password"
                    required={!editingUser}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Role</label>
                    <select
                      value={formData.role}
                      onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                    >
                      <option value="admin">Admin</option>
                      <option value="user">User</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">License Status</label>
                    <select
                      value={formData.licenseActive ? "true" : "false"}
                      onChange={(e) => setFormData({ ...formData, licenseActive: e.target.value === "true" })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                    >
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700">
                    <Calendar size={14} /> License Expiry Date
                  </label>
                  <input
                    type="date"
                    value={formData.licenseExpiryDate}
                    onChange={(e) => setFormData({ ...formData, licenseExpiryDate: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                  />
                  <p className="mt-1 text-xs text-gray-500">Leave blank for lifetime access.</p>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button type="button" onClick={handleCloseModal} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800">
                  {editingUser ? "Save Changes" : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
