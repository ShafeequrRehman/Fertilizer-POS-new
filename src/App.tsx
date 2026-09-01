import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ProtectedRoute from '@/routes/ProtectedRoute';
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
        <Route path="/" element={<Navigate to="/dashboard" replace />} />

        <Route element={<PublicOnlyRoute />}>
          <Route path="/login" element={<LoginPage />} />
        </Route>

        <Route path="/license-expired" element={<LicenseExpiredPage />} />
        <Route path="/receipt/print/:id" element={<ReceiptPrintPage />} />
        <Route path="/order/:shopId" element={<CustomerOrderPage />} />
        <Route path="/order/:shopId/status/:orderId" element={<CustomerOrderPage />} />

        <Route element={<ProtectedRoute allowedRoles={['shopowner', 'employee']} />}>
          <Route path="/dashboard" element={<DashboardShell />}>
            <Route index element={<DashboardPageClient />} />
            <Route path="pos" element={<POSPage />} />
            <Route path="sales" element={<SalesPage />} />
            <Route path="sales/:id/edit" element={<EditOrderPage />} />
            <Route path="sales/print/:id" element={<PrintOrderPage />} />
            <Route path="accounting" element={<AccountingPage />} />
            <Route path="purchase" element={<PurchasePage />} />
            <Route path="management" element={<ManagementPage />} />
            <Route path="dues" element={<DuesPage />} />
            <Route path="ledger" element={<LedgerPage />} />
            <Route path="record" element={<RecordPage />} />
            <Route path="shifts" element={<ShiftsPage />} />
            <Route path="offline" element={<OfflineSyncPage />} />
            <Route path="payroll" element={<PayrollPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route element={<ProtectedRoute allowedRoles={['shopowner']} />}>
              <Route path="employees" element={<EmployeesPage />} />
            </Route>
            <Route path="settings" element={<SettingsPage />} />
            <Route path="whatsapp" element={<WhatsappPage />} />
            <Route path="help" element={<HelpPage />} />
            <Route path="kitchen" element={<KitchenPage />} />
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

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </>
  );
}
