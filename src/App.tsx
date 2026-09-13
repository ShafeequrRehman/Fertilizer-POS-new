import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ProtectedRoute from '@/routes/ProtectedRoute';
import RequirePermission from '@/routes/RequirePermission';
import PublicOnlyRoute from '@/routes/PublicOnlyRoute';
import LoginPage from '@/pages/LoginPage';
import LicenseExpiredPage from '@/pages/LicenseExpiredPage';
import ReceiptPrintPage from '@/pages/ReceiptPrintPage';
import CustomerOrderPage from '@/pages/CustomerOrderPage';
import DashboardShell from '@/pages/dashboard/components/DashboardShell';
import DashboardPageClient from '@/pages/dashboard/components/DashboardPageClient';
import POSPage from '@/pages/dashboard/pos/POSPage';
import SalesPage from '@/pages/dashboard/sales/SalesPage';
import EditOrderPage from '@/pages/dashboard/sales/EditOrderPage';
import PrintOrderPage from '@/pages/dashboard/sales/PrintOrderPage';
import AccountingPage from '@/pages/dashboard/AccountingPage';
import PurchasePage from '@/pages/dashboard/PurchasePage';
import IngredientStockPage from '@/pages/dashboard/IngredientStockPage';
import ManagementPage from '@/pages/dashboard/ManagementPage';
import DuesPage from '@/pages/dashboard/DuesPage';
import LedgerPage from '@/pages/dashboard/LedgerPage';
import RecordPage from '@/pages/dashboard/RecordPage';
import ShiftsPage from '@/pages/dashboard/ShiftsPage';
import PayrollPage from '@/pages/dashboard/PayrollPage';
import OfflineSyncPage from '@/pages/dashboard/OfflineSyncPage';
import ReportsPage from '@/pages/dashboard/ReportsPage';
import AdminPage from '@/pages/dashboard/AdminPage';
import EmployeesPage from '@/pages/dashboard/EmployeesPage';
import SettingsPage from '@/pages/dashboard/SettingsPage';
import WhatsappPage from '@/pages/dashboard/WhatsappPage';
import HelpPage from '@/pages/dashboard/HelpPage';
import KitchenPage from '@/pages/dashboard/KitchenPage';
import SuperAdminShell from '@/pages/superadmin/components/SuperAdminShell';
import OverviewPage from '@/pages/superadmin/OverviewPage';
import ShopsPage from '@/pages/superadmin/ShopsPage';
import PlansPage from '@/pages/superadmin/PlansPage';
import PaymentsPage from '@/pages/superadmin/PaymentsPage';
import LogsPage from '@/pages/superadmin/LogsPage';
import SuperAdminSettingsPage from '@/pages/superadmin/SettingsPage';
import { getFirstAccessiblePage } from '@/lib/dashboard-pages';

// Route table for the three-tier multi-tenant app:
//   /dashboard/*   - Shop Owner + Employee (shop's day-to-day POS/business)
//   /superadmin/*  - Super Admin only (software provider's console)
// Both trees are wrapped in <ProtectedRoute allowedRoles={...}/>, which
// redirects a logged-in user of the wrong tier to their own home instead
// of the login screen (see routes/ProtectedRoute.tsx). /dashboard/employees
// is further restricted to Shop Owner only - Employees never manage other
// Employees, per spec ("Created only by the Shop Owner").
function RouteLogger() {
  const location = useLocation();
  console.log('Current route:', location.pathname, location.hash);
  return null;
}

export default function App() {
  console.log('App rendered');
  return (
    <>
      <RouteLogger />
      <Routes>
        {/* Dashboard Permission Gate: an already-authenticated employee
            whose Role hides the Dashboard lands on their own first
            accessible page instead - see lib/dashboard-pages.ts's
            getFirstAccessiblePage (a no-op '/dashboard' for everyone
            else, same as before this existed). */}
        <Route path="/" element={<Navigate to={getFirstAccessiblePage()} replace />} />

        <Route element={<PublicOnlyRoute />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route path="/license-expired" element={<LicenseExpiredPage />} />
        <Route path="/receipt/print/:id" element={<ReceiptPrintPage />} />
        <Route path="/order/:shopId" element={<CustomerOrderPage />} />
        <Route path="/order/:shopId/status/:orderId" element={<CustomerOrderPage />} />

        <Route element={<ProtectedRoute allowedRoles={['shopowner', 'employee']} />}>
          <Route path="/dashboard" element={<DashboardShell />}>
            {/* Broken Access Control fix: every route below now carries the
                SAME permission dashboard-pages.ts already assigns it for the
                sidebar link (DASHBOARD_PAGES), via RequirePermission (see
                routes/RequirePermission.tsx). Before this, only
                dining-tables/offline had a route guard at all - hiding a
                sidebar link never stopped the route itself (or the API
                calls its page makes) from being reachable by typing the URL
                directly. This is the client-side half of the fix; the
                backend routes behind these pages (orderRoutes.js,
                productController.js, etc.) independently enforce the same
                permissions server-side too - see those files' own comments
                - so this is a UX/redirect convenience, never the only gate. */}
            <Route element={<RequirePermission permission="view.dashboard" />}>
              <Route index element={<DashboardPageClient />} />
            </Route>
            <Route element={<RequirePermission permission="sales.create" />}>
              <Route path="pos" element={<POSPage />} />
              <Route path="sales" element={<SalesPage />} />
            </Route>
            <Route element={<RequirePermission permission={['sales.create', 'sales.edit']} />}>
              <Route path="sales/:id/edit" element={<EditOrderPage />} />
            </Route>
            <Route element={<RequirePermission permission={['sales.create', 'sales.print', 'orders.record.view']} />}>
              <Route path="sales/print/:id" element={<PrintOrderPage />} />
            </Route>
            <Route element={<RequirePermission permission="expenses.manage" />}>
              <Route path="accounting" element={<AccountingPage />} />
            </Route>
            <Route element={<RequirePermission permission="purchases.manage" />}>
              <Route path="purchase" element={<PurchasePage />} />
            </Route>
            <Route element={<RequirePermission permission={['inventory.manage', 'stock.manage']} />}>
              <Route path="ingredient-stock" element={<IngredientStockPage />} />
            </Route>
            <Route element={<RequirePermission permission="customers.manage" />}>
              <Route path="management" element={<ManagementPage />} />
            </Route>
            <Route element={<RequirePermission permission="dues.manage" />}>
              <Route path="dues" element={<DuesPage />} />
              <Route path="ledger" element={<LedgerPage />} />
            </Route>
            <Route element={<RequirePermission permission="orders.record.view" />}>
              <Route path="record" element={<RecordPage />} />
            </Route>
            <Route element={<RequirePermission permission="shop.session.manage" />}>
              <Route path="shifts" element={<ShiftsPage />} />
            </Route>
            <Route element={<RequirePermission permission="manage.devices" />}>
              <Route path="offline" element={<OfflineSyncPage />} />
            </Route>
            {/* Payroll is role-gated (Shop Owner only), same as Employees
                below, per dashboard-pages.ts's own comment on this entry -
                not permission-gated, since no employee role should ever see
                payroll figures regardless of what permissions they hold. */}
            <Route element={<ProtectedRoute allowedRoles={['shopowner']} />}>
              <Route path="payroll" element={<PayrollPage />} />
              <Route path="employees" element={<EmployeesPage />} />
            </Route>
            <Route element={<RequirePermission permission={['reports.view', 'reports.view.own_sales', 'reports.view.inventory']} />}>
              <Route path="reports" element={<ReportsPage />} />
            </Route>
            {/* Not in DASHBOARD_PAGES/the sidebar at all, and self-checks for
                a "superadmin" role internally - but that check can never
                pass here anyway, since the outer ProtectedRoute above only
                admits 'shopowner'/'employee' into this whole /dashboard
                tree in the first place (a superadmin is redirected to
                /superadmin before ever reaching this route). Left as-is:
                already unreachable-with-data, not a live gap. */}
            <Route path="admin" element={<AdminPage />} />
            <Route element={<RequirePermission permission="settings.manage" />}>
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route element={<RequirePermission permission="whatsapp.manage" />}>
              <Route path="whatsapp" element={<WhatsappPage />} />
            </Route>
            <Route path="help" element={<HelpPage />} />
            {/* Not in DASHBOARD_PAGES/the sidebar either, but freely read
                every order via fetchOrders() with zero gating before this -
                same tier as POS/Sales/Record, whichever the account holds. */}
            <Route element={<RequirePermission permission={['sales.create', 'orders.record.view']} />}>
              <Route path="kitchen" element={<KitchenPage />} />
            </Route>
          </Route>
        </Route>

        <Route element={<ProtectedRoute allowedRoles={['superadmin']} />}>
          <Route path="/superadmin" element={<SuperAdminShell />}>
            <Route index element={<OverviewPage />} />
            <Route path="shops" element={<ShopsPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="settings" element={<SuperAdminSettingsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to={getFirstAccessiblePage()} replace />} />
      </Routes>
    </>
  );
}
