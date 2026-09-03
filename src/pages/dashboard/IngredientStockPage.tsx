
import { Boxes } from 'lucide-react';
import { IngredientStockSection } from '@/components/IngredientStockSection';

// Moved out of Settings (task: "move Ingredient Stock, Recipe Management,
// and Dining Table pages to the main sidebar navigation menu instead of
// keeping them hidden inside the settings section") - IngredientStockSection
// itself is unchanged, gated by the same 'inventory.manage' permission the
// backend already enforces (see backend/routes/ingredientRoutes.js), just
// reachable directly from the sidebar now instead of only via a Settings
// sub-menu tab.
export default function IngredientStockPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black text-gray-900 tracking-tight flex items-center gap-3">
          Ingredient Stock <Boxes className="text-indigo-600" size={30} />
        </h1>
        <p className="text-gray-500 font-bold">Add raw ingredients, group them into categories, and log incoming stock.</p>
      </div>
      <IngredientStockSection />
    </div>
  );
}
