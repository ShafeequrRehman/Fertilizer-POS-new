import React from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Store, CreditCard, Banknote, Settings, ScrollText, LogOut, ShieldCheck } from 'lucide-react';
import { clearAuthSession } from '@/lib/auth';
import { logoutRequest } from '@/lib/api';

// Deliberately separate from pages/dashboard/components/DashboardShell -
// the Super Admin manages the software business (shops, licenses, plans,
// payments across every tenant), not a single shop's day-to-day POS
// operations, so it gets its own shell/nav rather than reusing the shop
// dashboard's sidebar with conditionally-hidden items.
export default function SuperAdminShell() {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();

  const navItems = [
    { icon: <LayoutDashboard size={18} />, label: 'Overview', href: '/superadmin' },
    { icon: <Store size={18} />, label: 'Shops', href: '/superadmin/shops' },
    { icon: <CreditCard size={18} />, label: 'Plans', href: '/superadmin/plans' },
    { icon: <Banknote size={18} />, label: 'Payments', href: '/superadmin/payments' },
    { icon: <ScrollText size={18} />, label: 'Logs', href: '/superadmin/logs' },
    { icon: <Settings size={18} />, label: 'Settings', href: '/superadmin/settings' },
  ];

  const handleLogout = async () => {
    await logoutRequest();
    clearAuthSession();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-[#0F1115] font-sans text-white">
      <aside className="flex w-60 flex-col gap-6 border-r border-white/10 p-4">
        <div className="flex items-center gap-2 px-2">
          <div className="rounded-lg bg-[#E2F33C] p-1.5">
            <ShieldCheck size={16} className="text-black" />
          </div>
          <div>
            <span className="block text-lg font-bold tracking-tight">Super Admin</span>
            <span className="block text-xs text-gray-400">Software Console</span>
          </div>
        </div>

        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <NavItem key={item.label} icon={item.icon} label={item.label} href={item.href} active={pathname === item.href} />
          ))}
        </nav>

        <div className="mt-auto">
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 rounded-full border border-white/10 bg-white/5 px-3 py-2.5 text-sm font-semibold text-gray-300 transition-colors hover:bg-white/10"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({ icon, label, href, active }: { icon: React.ReactNode; label: string; href: string; active?: boolean }) {
  const className = `flex items-center gap-2.5 rounded-full px-3 py-2.5 text-sm transition-all ${
    active ? 'bg-[#E2F33C] font-bold text-black shadow-sm' : 'text-gray-300 hover:bg-white/10'
  }`;

  return (
    <Link to={href} className={className}>
      {icon}
      <span>{label}</span>
    </Link>
  );
}
