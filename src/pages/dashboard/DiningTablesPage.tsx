
import { Table2 } from 'lucide-react';
import { TableManagementSection } from '@/components/TableManagementSection';

// Moved out of Settings - see IngredientStockPage.tsx's own comment.
// Deliberately NOT permission-gated in dashboard-pages.ts: adding, renaming,
// re-categorizing (Family/Simple), or deleting a table is open to any
// authenticated shop member on the backend (see
// backend/routes/tableRoutes.js's own comment - only the shop-wide
// turnover-timer setting requires 'settings.manage'), so the sidebar entry
// matches that same boundary rather than hiding it behind a permission the
// backend doesn't actually require.
export default function DiningTablesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black text-gray-900 tracking-tight flex items-center gap-3">
          Dining Tables <Table2 className="text-indigo-600" size={30} />
        </h1>
        <p className="text-gray-500 font-bold">Mark a table as a Family Table to call it out on the Dine-In screen so staff can seat families accurately.</p>
      </div>
      <TableManagementSection />
    </div>
  );
}
