// DashboardShell.tsx - the sidebar+header chrome wrapping every /dashboard
// route (including POS). Sidebar nav labels themselves live in sidebar.ts,
// not here - this file is for the rest of the shell's own text (header
// buttons, notifications panel, shop status, connectivity badges, etc).
export const dashboardShell = {
  logout: "Logout",
} as const;
