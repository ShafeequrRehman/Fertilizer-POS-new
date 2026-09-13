import { useEffect, useState } from 'react';
import { AlertCircle, Lock, XCircle } from 'lucide-react';
import { fetchShopProfile, updateEnabledPages, type ShopProfile } from '@/lib/pos-api';
import { updateCachedShopEnabledPages } from '@/lib/auth';
import { DASHBOARD_PAGES } from '@/lib/dashboard-pages';

// Lets the Shop Owner control their OWN dashboard sidebar - check a page
// to show it, uncheck to hide it (see DashboardShell.tsx's isPageEnabled
// filter, which is where this actually gets enforced). The Super Admin has
// no direct say in the selection itself; their only role is issuing the
// Page Visibility Key (via "Set Page Visibility Key" on the Shops page)
// that gates the Save action below - mirrors exactly how Cancel Order Key
// gates cancelling an order (see CancelOrderModal.tsx).
export function SidebarPagesSection() {
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedPages, setSelectedPages] = useState<string[]>(DASHBOARD_PAGES.map((p) => p.key));
  const [showKeyPrompt, setShowKeyPrompt] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const data = await fetchShopProfile();
        if (data) {
          setProfile(data);
          setSelectedPages(data.enabledPages ?? DASHBOARD_PAGES.map((p) => p.key));
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Failed to load your sidebar page settings.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function togglePage(key: string) {
    setSavedMessage('');
    setSelectedPages((previous) =>
      previous.includes(key) ? previous.filter((k) => k !== key) : [...previous, key]
    );
  }

  function handleSaved(saved: string[]) {
    setSelectedPages(saved);
    setProfile((previous) => (previous ? { ...previous, enabledPages: saved } : previous));
    setShowKeyPrompt(false);
    setSavedMessage('Saved - reloading to update your sidebar...');
    // DashboardShell.tsx computes its nav list from the cached shop object
    // (see lib/auth.ts getAuthShop/isPageEnabled) on every render, but
    // nothing tells it to re-render just because localStorage changed - a
    // full reload is the simplest reliable way to pick up the new
    // selection immediately instead of only at the next login.
    updateCachedShopEnabledPages(saved);
    window.setTimeout(() => window.location.reload(), 600);
  }

  if (loading) {
    return <p className="text-sm font-bold text-slate-400">Loading your sidebar page settings...</p>;
  }

  return (
    <div className="space-y-6">
      {loadError ? (
        <div className="flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">
          <AlertCircle size={18} />
          {loadError}
        </div>
      ) : null}

      <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6">
        <p className="text-sm font-black text-slate-900">Which pages does your dashboard show?</p>
        <p className="mt-1 text-xs font-bold text-slate-500">
          Check a page to show it in the sidebar, uncheck it to hide it. This only affects your own shop -
          not other shops on this software.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {DASHBOARD_PAGES.map((page) => {
            const checked = selectedPages.includes(page.key);
            return (
              <label
                key={page.key}
                className={`flex cursor-pointer items-center gap-2 rounded-2xl border px-3 py-2.5 text-xs font-bold transition ${
                  checked ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePage(page.key)}
                  className="h-4 w-4 rounded accent-indigo-600"
                />
                {page.label}
              </label>
            );
          })}
        </div>

        {!profile?.hasPageVisibilityKey ? (
          <div className="mt-5 flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold text-amber-800">
            <AlertCircle size={16} />
            No Page Visibility Key has been set up for your shop yet. Ask your software provider (Super Admin)
            to set one before you can save changes here.
          </div>
        ) : null}

        {savedMessage ? <p className="mt-4 text-xs font-bold text-emerald-600">{savedMessage}</p> : null}

        <button
          type="button"
          disabled={!profile?.hasPageVisibilityKey}
          onClick={() => setShowKeyPrompt(true)}
          className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-black text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Lock size={16} />
          Save Sidebar Pages
        </button>
      </div>

      {showKeyPrompt ? (
        <PageVisibilityKeyModal
          pendingPages={selectedPages}
          onClose={() => setShowKeyPrompt(false)}
          onSaved={handleSaved}
        />
      ) : null}
    </div>
  );
}

// Collects the Page Visibility Key and submits the pending selection.
// Mirrors CancelOrderModal.tsx's key-entry UX exactly - the backend
// (shopOwnerController.exports.updateEnabledPages) is the real gate; this
// modal just collects the key and surfaces any error the server sends
// back (wrong key, no key configured yet).
function PageVisibilityKeyModal({
  pendingPages,
  onClose,
  onSaved,
}: {
  pendingPages: string[];
  onClose: () => void;
  onSaved: (saved: string[]) => void;
}) {
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!key.trim()) {
      setError("Enter the shop's Page Visibility Key.");
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await updateEnabledPages(pendingPages, key.trim());
      if (result) onSaved(result.enabledPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sidebar pages.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-gray-900">Confirm Page Visibility Key</h2>
            <p className="mt-1 text-xs font-bold text-gray-400">
              This is the key your software provider (Super Admin) gave you - not your login password.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-[#F6F7FB] p-2.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900">
            <XCircle size={18} />
          </button>
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Page Visibility Key</label>
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="w-full rounded-2xl border border-gray-200 px-4 py-3 outline-none focus:border-black"
            autoFocus
          />
        </div>

        {error ? <p className="mt-3 text-sm font-bold text-rose-600">{error}</p> : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="rounded-2xl bg-gray-100 py-3 text-sm font-black text-gray-600 transition hover:bg-gray-200">
            Back
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 py-3 text-sm font-black text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Lock size={14} />
            {submitting ? 'Saving...' : 'Confirm & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
