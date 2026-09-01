import type { Discount } from './pos-types';

// Shared between SalesPage.tsx (where a discount is actually typed, into
// the order-details card, while an order is still pending) and
// PrintOrderPage.tsx's Manual Print Center preview (which needs to reflect
// that same not-yet-saved discount without requiring the order to be
// completed first, or a printer to be connected - see PrintOrderPage.tsx's
// own comment on why). Keeping both the sessionStorage key and the
// amount/percent -> Discount math in exactly one place is what guarantees
// the preview always matches exactly what Complete Order would actually
// save - two separate copies of this math drifting apart over time was a
// real risk otherwise.

const DISCOUNT_DRAFT_KEY_PREFIX = 'pos_sales_discount_draft_';

export function loadDiscountDraft(orderId: string): { amount: string; percent: string } {
  if (typeof window === 'undefined') return { amount: '', percent: '' };
  try {
    const raw = window.sessionStorage.getItem(DISCOUNT_DRAFT_KEY_PREFIX + orderId);
    if (!raw) return { amount: '', percent: '' };
    const parsed = JSON.parse(raw) as { amount?: string; percent?: string };
    return { amount: parsed.amount || '', percent: parsed.percent || '' };
  } catch {
    return { amount: '', percent: '' };
  }
}

export function saveDiscountDraft(orderId: string, amount: string, percent: string) {
  if (typeof window === 'undefined') return;
  if (!amount && !percent) {
    window.sessionStorage.removeItem(DISCOUNT_DRAFT_KEY_PREFIX + orderId);
    return;
  }
  window.sessionStorage.setItem(DISCOUNT_DRAFT_KEY_PREFIX + orderId, JSON.stringify({ amount, percent }));
}

// Same "flat PKR wins the instant it's non-zero, otherwise fall back to
// percent, clamp to the subtotal" rule the two input fields' own disabled
// state already enforces in SalesPage.tsx - see that page's Discount (%)
// input's disabled prop for the other half of this rule.
export function computeDiscountFromInputs(amountInput: string, percentInput: string, subtotal: number): Discount | null {
  const amountValue = Number(amountInput) || 0;
  const percentValue = Number(percentInput) || 0;
  const type: Discount['type'] = amountValue > 0 ? 'value' : 'percent';
  const rawValue = amountValue > 0 ? amountValue : percentValue;
  if (rawValue <= 0 || subtotal <= 0) return null;
  const amount = Math.min(type === 'percent' ? Math.round((subtotal * rawValue) / 100) : Math.round(rawValue), subtotal);
  if (amount <= 0) return null;
  return { type, value: rawValue, amount };
}
