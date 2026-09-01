import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Wifi, WifiOff, RefreshCcw, KeyRound, Smartphone, Monitor, CheckCircle2, AlertCircle } from 'lucide-react';
import { getPairingInfo, rotatePairingKey, isLocalHubReachable, type PairingInfo } from '@/lib/local-hub-api';
import { useOfflineSync } from '@/lib/offline-sync';
import { useNetworkStatus } from '@/lib/network-status';
import { isDesktopApp } from '@/lib/api';
import { useToast } from '@/lib/toast';

// "Connect Devices" - lets a Shop Owner/staff pair a phone to this till so
// order-taking can keep going during an internet outage. The QR code and
// the plain-text IP/port/key below it encode the exact same thing - the
// QR is just a faster way to get it onto the phone (see pos-mobile's
// Connect to Desktop screen, which currently only supports typing it in
// manually; QR camera scanning is a planned fast-follow that needs a
// mobile app rebuild, see project notes).
export default function OfflineSyncPage() {
  const { isOnline } = useNetworkStatus();
  const { status, lastSyncAt, lastResult, isSyncing, syncNow, refreshStatus } = useOfflineSync();
  const { toast } = useToast();

  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null);
  const [hubReachable, setHubReachable] = useState<boolean | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const reachable = await isLocalHubReachable();
      setHubReachable(reachable);
      if (reachable) {
        const info = await getPairingInfo();
        setPairingInfo(info);
        setSelectedIp((previous) => previous && info.ips.includes(previous) ? previous : info.ips[0] || null);
      }
    } finally {
      setLoading(false);
      void refreshStatus();
    }
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!pairingInfo || !selectedIp) { setQrDataUrl(null); return; }
    const payload = JSON.stringify({ ip: selectedIp, port: pairingInfo.port, key: pairingInfo.pairingKey });
    QRCode.toDataURL(payload, { width: 260, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [pairingInfo, selectedIp]);

  const handleRotate = async () => {
    setRotating(true);
    try {
      await rotatePairingKey();
      await load();
      toast.success('Pairing key changed. Any already-connected phones will need the new key.');
    } catch {
      toast.error('Failed to rotate the pairing key.');
    } finally {
      setRotating(false);
    }
  };

  const handleSyncNow = async () => {
    const result = await syncNow();
    if (!result) return;
    if (result.error) {
      toast.error(result.error);
    } else if (result.imported > 0) {
      toast.success(`Synced ${result.imported} offline order${result.imported === 1 ? '' : 's'} to the cloud.`);
    } else {
      toast.success('Nothing to sync - everything is already up to date.');
    }
  };

  if (!isDesktopApp()) {
    return (
      <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-sm text-slate-500">
        Connect Devices is only available in the desktop app, since a paired phone connects directly to the till's
        own computer over WiFi.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-slate-900">Connect Devices</h1>
          <p className="mt-1 text-sm text-slate-500">
            Pair a phone to this till so orders can still be taken if the internet goes down. Paired phones sync
            automatically once you're back online.
          </p>
        </div>
        <div className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-black ${isOnline ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
          {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
          {isOnline ? 'Online' : 'Offline'}
        </div>
      </div>

      {loading ? (
        <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-sm text-slate-500">Loading...</div>
      ) : !hubReachable ? (
        <div className="flex items-center gap-3 rounded-[28px] border border-amber-200 bg-amber-50 p-6 text-sm font-bold text-amber-800">
          <AlertCircle size={20} />
          The Local Hub isn't running on this till right now. Restart the app to enable offline pairing.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-2">
              <Smartphone size={18} className="text-indigo-600" />
              <h2 className="text-lg font-black text-slate-900">Scan from the phone</h2>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Open Connect to Desktop on the phone and scan this code (or enter the details on the right manually).
            </p>

            {pairingInfo && pairingInfo.ips.length > 1 ? (
              <>
                <p className="mt-4 text-xs font-bold text-amber-600">
                  This till has more than one network adapter - pick the one labeled Wi-Fi (or matching this till's actual WiFi connection). The others - VPNs, Docker/WSL/Hyper-V's virtual adapters - look identical but a phone on the same WiFi can never reach them, which is the most common reason pairing fails even though both devices are genuinely on the same network.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {pairingInfo.ips.map((ip) => {
                    const label = pairingInfo.interfaceNames?.[ip];
                    return (
                      <button
                        key={ip}
                        type="button"
                        onClick={() => setSelectedIp(ip)}
                        className={`rounded-full px-3 py-1.5 text-xs font-bold ${selectedIp === ip ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}
                        title={label}
                      >
                        {ip}{label ? ` (${label})` : ''}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}

            <div className="mt-5 flex items-center justify-center rounded-2xl bg-slate-50 p-6">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Pairing QR code" className="h-[220px] w-[220px]" />
              ) : (
                <div className="flex h-[220px] w-[220px] items-center justify-center text-xs font-bold text-slate-400">
                  {pairingInfo?.ips.length ? 'Generating QR code...' : 'No LAN network detected on this till.'}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-2">
              <Monitor size={18} className="text-indigo-600" />
              <h2 className="text-lg font-black text-slate-900">Or enter manually</h2>
            </div>
            <p className="mt-2 text-sm text-slate-500">Type these into the phone's Connect to Desktop screen.</p>

            <div className="mt-5 space-y-3">
              <ManualField label="IP Address" value={selectedIp || '—'} />
              <ManualField label="Port" value={String(pairingInfo?.port ?? '')} />
              <ManualField label="Pairing Key" value={pairingInfo?.pairingKey || ''} mono />
            </div>

            <button
              type="button"
              onClick={() => void handleRotate()}
              disabled={rotating}
              className="mt-5 inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              <KeyRound size={14} />
              {rotating ? 'Rotating...' : 'Rotate Pairing Key'}
            </button>
            <p className="mt-2 text-xs text-slate-400">
              Changing the key means any phone already paired will need to be reconnected with the new one.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-slate-900">Offline Orders</h2>
            <p className="mt-1 text-sm text-slate-500">
              Orders queued locally (from this till or a paired phone) while the internet was down. They sync
              automatically every 5 minutes once you're back online.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSyncNow()}
            disabled={isSyncing || !isOnline}
            className="flex items-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-black text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCcw size={16} className={isSyncing ? 'animate-spin' : ''} />
            {isSyncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatBox label="Pending Orders" value={status?.pendingCount ?? 0} tone="amber" />
          <StatBox label="Pending Edits" value={status?.pendingEditCount ?? 0} tone="amber" />
          <StatBox label="Failed" value={(status?.failedCount ?? 0) + (status?.failedEditCount ?? 0)} tone="rose" />
          <StatBox label="Total Queued" value={status?.totalQueued ?? 0} tone="slate" />
        </div>

        {!isOnline && (status?.pendingCount ?? 0) + (status?.pendingEditCount ?? 0) > 0 ? (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700">
            <WifiOff size={14} /> Waiting for the internet to come back before these can sync.
          </div>
        ) : null}

        {lastSyncAt ? (
          <div className="mt-4 flex items-center gap-2 text-xs font-bold text-slate-400">
            <CheckCircle2 size={14} className="text-emerald-500" />
            Last synced {lastSyncAt.toLocaleTimeString()}
            {lastResult?.error ? ` — ${lastResult.error}` : ''}
          </div>
        ) : null}
      </div>

      {/* Offline Manage Staff - see localStaff.js. Same sync engine/5-minute
          tick as Offline Orders above, just a separate queue. */}
      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <div>
          <h2 className="text-lg font-black text-slate-900">Offline Staff Changes</h2>
          <p className="mt-1 text-sm text-slate-500">
            Staff members created, edited, or removed on Manage Staff while the internet was down. They sync
            automatically the same way offline orders do.
          </p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatBox label="Pending New" value={status?.pendingStaffCount ?? 0} tone="amber" />
          <StatBox label="Pending Edits" value={status?.pendingStaffEditCount ?? 0} tone="amber" />
          <StatBox label="Pending Removals" value={status?.pendingStaffDeleteCount ?? 0} tone="amber" />
          <StatBox
            label="Failed"
            value={(status?.failedStaffCount ?? 0) + (status?.failedStaffEditCount ?? 0) + (status?.failedStaffDeleteCount ?? 0)}
            tone="rose"
          />
        </div>

        {!isOnline && (status?.pendingStaffCount ?? 0) + (status?.pendingStaffEditCount ?? 0) + (status?.pendingStaffDeleteCount ?? 0) > 0 ? (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-xs font-bold text-amber-700">
            <WifiOff size={14} /> Waiting for the internet to come back before these can sync.
          </div>
        ) : null}
      </div>

      {/* Offline Cancel Order - see localOrders.js's "Cancelling an
          ALREADY-SYNCED order while offline" section. A "Failed" count here
          almost always means the Cancel Order Key entered offline turned
          out to be wrong once actually checked against the cloud - that
          order was NOT really cancelled and needs to be redone (with the
          correct key) from the Sales or Record page. */}
      <div className="rounded-[28px] border border-slate-200 bg-white p-6">
        <div>
          <h2 className="text-lg font-black text-slate-900">Offline Cancellations</h2>
          <p className="mt-1 text-sm text-slate-500">
            Orders cancelled while the internet was down. The Cancel Order Key is only actually checked once this
            syncs - a wrong key shows up here as Failed, meaning that order was NOT really cancelled.
          </p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-2">
          <StatBox label="Pending" value={status?.pendingCancellationCount ?? 0} tone="amber" />
          <StatBox label="Failed (wrong key)" value={status?.failedCancellationCount ?? 0} tone="rose" />
        </div>

        {(status?.failedCancellationCount ?? 0) > 0 ? (
          <div className="mt-4 flex items-center gap-2 rounded-2xl bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">
            <AlertCircle size={14} /> One or more offline cancellations used the wrong key and were not applied - redo them with the correct key.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ManualField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-black text-slate-900 ${mono ? 'tracking-[0.2em]' : ''}`}>{value}</p>
    </div>
  );
}

function StatBox({ label, value, tone }: { label: string; value: number; tone: 'amber' | 'rose' | 'slate' }) {
  const toneClass = tone === 'amber' ? 'text-amber-600 bg-amber-50' : tone === 'rose' ? 'text-rose-600 bg-rose-50' : 'text-slate-700 bg-slate-50';
  return (
    <div className={`rounded-2xl p-4 ${toneClass}`}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}
