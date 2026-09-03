
import { ChefHat } from 'lucide-react';
import { RecipeManagementSection } from '@/components/RecipeManagementSection';

// Moved out of Settings - see IngredientStockPage.tsx's own comment.
// Gated by the same 'inventory.manage' permission the backend already
// enforces (see backend/routes/recipeRoutes.js).
export default function RecipeManagementPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black text-gray-900 tracking-tight flex items-center gap-3">
          Recipe Management <ChefHat className="text-indigo-600" size={30} />
        </h1>
        <p className="text-gray-500 font-bold">Define how much of each ingredient goes into a single unit of every product size - the exact amounts automatically deducted from stock when it's sold.</p>
      </div>
      <RecipeManagementSection />
    </div>
  );
}
