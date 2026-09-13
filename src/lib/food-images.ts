// Real, professional food photography for every product/deal shown across
// the app (POS product grid + cart + variation picker, Sales order cards/
// detail, Record page item rows, etc.) - see Technical Requirement: "if
// pizza then add [a real] pizza image, if burger then add [a real] burger
// image... everywhere its [used]". ProductManagementSection.tsx used to
// offer a picker of 33 flat, single-color SVG glyphs (public/products/*.svg)
// before manual photo upload was added - fine as a tiny admin-picker
// thumbnail, but never good enough as the actual photo shown to staff
// ringing up an order or a customer-facing screen. This module maps every
// one of those old SVG filenames (and free-typed product names/categories)
// to a matching real photo instead, so products saved back when the picker
// still existed keep looking right with no re-picking needed.
//
// Photos are hotlinked from images.unsplash.com (Unsplash's own CDN, not a
// deprecated "random by keyword" redirector) using specific, verified photo
// IDs, with Unsplash's own resize/format query params - no local asset or
// download step needed, and no attribution UI required for hotlinked use.

import { getProductImageUrl } from "./asset-path";

function photo(id: string): string {
  return `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;
}

const PHOTOS = {
  pizza: photo("1513104890138-7c749659a591"),
  burger: photo("1568901346375-23c9450c58cd"),
  biryani: photo("1589302168068-964664d93dc0"),
  fries: photo("1573080496219-bb080dd4f877"),
  wings: photo("1567620832903-9fc6debc209f"),
  nuggets: photo("1562967914-608f82629710"),
  wrap: photo("1626700051175-6818013e1d4f"),
  samosa: photo("1601050690597-df0568f70950"),
  sandwich: photo("1553909489-cd47e0907980"),
  hotdog: photo("1612392062631-94dd858cba88"),
  steak: photo("1544025162-d76694265947"),
  salad: photo("1512621776951-a57141f2eefd"),
  avocado: photo("1523049673857-eb18f1d7b578"),
  bread: photo("1509440159596-0249088772ff"),
  croissant: photo("1555507036-ab1f4038808a"),
  donut: photo("1551106652-a5bcf4b29ab6"),
  cake: photo("1578985545062-69928b1d9587"),
  sweet: photo("1606313564200-e75d5e30476c"),
  chocolate: photo("1511381939415-e44015466834"),
  icecream: photo("1497034825429-c343d7c6a68f"),
  tea: photo("1544787219-7f47ccb76574"),
  icedCoffee: photo("1517701604599-bb29b565090c"),
  coffee: photo("1495474472287-4d71bcdd2085"),
  milk: photo("1550583724-b2692b85b150"),
  cola: photo("1581636625402-29b2a704ef13"),
  water: photo("1548839140-29a749e1cf4d"),
  juice: photo("1600271886742-f049cd451bba"),
  apple: photo("1568702846914-96b305d2aaeb"),
  platter: photo("1550547660-d9450f859349"),
  defaultFood: photo("1504674900247-0877df9cc836"),
} as const;

// Direct 1:1 map for every filename the old "Display Icon" preset picker
// used to offer (removed from ProductManagementSection.tsx - manual photo
// upload only now) - kept so any product that already picked one of these
// filenames before the picker was removed still gets an exact, unambiguous
// real photo instead of falling through to the generic default.
const ICON_FILE_TO_PHOTO: Record<string, string> = {
  "beef-burger-combo.svg": PHOTOS.burger,
  "biryani.svg": PHOTOS.biryani,
  "butter-croissant.svg": PHOTOS.croissant,
  "chai-tea.svg": PHOTOS.tea,
  "chicken-roll.svg": PHOTOS.wrap,
  "chicken-tikka-pizza.svg": PHOTOS.pizza,
  "coffee-beans.svg": PHOTOS.coffee,
  "cold-coffee.svg": PHOTOS.icedCoffee,
  "couple-deal.svg": PHOTOS.platter,
  "dark-chocolate.svg": PHOTOS.chocolate,
  "donut.svg": PHOTOS.donut,
  "family-deal.svg": PHOTOS.platter,
  "french-fries.svg": PHOTOS.fries,
  "fresh-avocado.svg": PHOTOS.avocado,
  "hot-dog.svg": PHOTOS.hotdog,
  "ice-cream.svg": PHOTOS.icecream,
  "kids-meal.svg": PHOTOS.platter,
  "lunch-deal.svg": PHOTOS.platter,
  "malai-boti-roll.svg": PHOTOS.wrap,
  "mega-deal.svg": PHOTOS.platter,
  "midnight-deal.svg": PHOTOS.platter,
  "nuggets.svg": PHOTOS.nuggets,
  "organic-milk.svg": PHOTOS.milk,
  "paratha-roll.svg": PHOTOS.wrap,
  "party-deal.svg": PHOTOS.platter,
  "pizza-slice.svg": PHOTOS.pizza,
  "red-apple.svg": PHOTOS.apple,
  "samosa.svg": PHOTOS.samosa,
  "sandwich.svg": PHOTOS.sandwich,
  "soft-drink.svg": PHOTOS.cola,
  "sparkling-water.svg": PHOTOS.water,
  "whole-grain-bread.svg": PHOTOS.bread,
  "zinger-shawarma.svg": PHOTOS.wrap,
};

// Ordered most-specific-first: a free-typed product/deal/order-item name
// (no icon ever picked, or an order line which only ever stores a name -
// see SavedOrder.items in pos-types.ts) is matched against these keyword
// groups top-to-bottom, so e.g. "Chicken Zinger Burger" matches "burger"
// before it ever reaches the looser "chicken" fallback near the bottom.
const KEYWORD_GROUPS: Array<{ keywords: string[]; photo: string }> = [
  { keywords: ["pizza"], photo: PHOTOS.pizza },
  { keywords: ["burger"], photo: PHOTOS.burger },
  { keywords: ["biryani", "pulao", "rice"], photo: PHOTOS.biryani },
  { keywords: ["fries", "chips"], photo: PHOTOS.fries },
  { keywords: ["wing"], photo: PHOTOS.wings },
  { keywords: ["nugget"], photo: PHOTOS.nuggets },
  { keywords: ["shawarma", "wrap", "roll", "kebab", "kabab"], photo: PHOTOS.wrap },
  { keywords: ["samosa"], photo: PHOTOS.samosa },
  { keywords: ["sandwich", "club"], photo: PHOTOS.sandwich },
  { keywords: ["hot dog", "hotdog"], photo: PHOTOS.hotdog },
  { keywords: ["steak", "bbq", "grill", "karahi", "handi"], photo: PHOTOS.steak },
  { keywords: ["salad"], photo: PHOTOS.salad },
  { keywords: ["avocado"], photo: PHOTOS.avocado },
  { keywords: ["bread"], photo: PHOTOS.bread },
  { keywords: ["croissant"], photo: PHOTOS.croissant },
  { keywords: ["donut", "doughnut"], photo: PHOTOS.donut },
  { keywords: ["cake"], photo: PHOTOS.cake },
  { keywords: ["rasmalai", "sweet", "dessert", "gulab", "kheer", "halwa"], photo: PHOTOS.sweet },
  { keywords: ["chocolate"], photo: PHOTOS.chocolate },
  { keywords: ["ice cream", "icecream", "sundae"], photo: PHOTOS.icecream },
  { keywords: ["chai", "tea"], photo: PHOTOS.tea },
  { keywords: ["cold coffee", "iced coffee"], photo: PHOTOS.icedCoffee },
  { keywords: ["coffee"], photo: PHOTOS.coffee },
  { keywords: ["milk"], photo: PHOTOS.milk },
  { keywords: ["cola", "soda", "soft drink", "pepsi", "sprite", "7up"], photo: PHOTOS.cola },
  { keywords: ["sparkling water", "water"], photo: PHOTOS.water },
  { keywords: ["juice"], photo: PHOTOS.juice },
  { keywords: ["apple"], photo: PHOTOS.apple },
  { keywords: ["haleem", "chicken", "boti", "tikka", "shami"], photo: PHOTOS.wrap },
  { keywords: ["deal", "combo", "meal", "platter", "feast", "family"], photo: PHOTOS.platter },
];

/**
 * Resolves the best real photo for a product/deal/order-item to display -
 * used in place of a bare `getProductImageUrl(product.image)` call anywhere
 * a customer- or staff-facing card/list shows food (POS grid, cart,
 * variation picker, Sales order cards/detail, Record page rows, ...).
 *
 * Priority: (1) a genuinely custom image already stored as a hosted URL or
 * data URI (never one of the 33 flat icon-picker SVGs) wins outright - a
 * shop that pastes/uploads its own real photo later is never overridden;
 * (2) one of the known icon-picker SVG filenames maps 1:1 to an exact
 * matching real photo; (3) free-typed name/category text (or an order
 * line's name, which is all it ever stores) is matched against the ordered
 * keyword groups above; (4) a generic appetizing food photo as the last
 * resort so nothing ever renders as a blank box.
 */
export function resolveProductImage(input: { image?: string | null; name?: string; category?: string }): string {
  const raw = (input.image || "").trim();

  if (raw) {
    const isHostedOrData = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(raw) || raw.startsWith("data:");
    if (isHostedOrData) return getProductImageUrl(raw);

    const filename = raw.replace(/^\/+/, "").replace(/^products\//, "");
    if (ICON_FILE_TO_PHOTO[filename]) return ICON_FILE_TO_PHOTO[filename];
  }

  const haystack = `${input.name ?? ""} ${input.category ?? ""}`.toLowerCase();
  for (const group of KEYWORD_GROUPS) {
    if (group.keywords.some((keyword) => haystack.includes(keyword))) return group.photo;
  }

  return PHOTOS.defaultFood;
}

/**
 * Picks the photo for an order's card/hero image specifically. A single
 * distinct line item (any quantity) gets its own exact matching photo - a
 * Chai order looks like tea, a Burger order looks like a burger, same as
 * everywhere else in the app. An order with more than one distinct item is
 * a mixed/combo plate, so it deliberately shows the generic multi-food
 * spread instead of just whichever item happened to be added first (which
 * would otherwise misrepresent the rest of the order).
 */
export function resolveOrderImage(items: Array<{ image?: string | null; name?: string; category?: string }> | undefined): string {
  if (!items || items.length === 0) return PHOTOS.defaultFood;
  if (items.length > 1) return PHOTOS.defaultFood;
  return resolveProductImage(items[0]);
}
