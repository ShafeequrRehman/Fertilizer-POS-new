
import React, { ChangeEvent, useMemo, useRef, useState, useEffect } from 'react';
import {
  Settings, Bell, Lock, Database,
  Store, Printer, Monitor, Save, Shield,
  CreditCard, ImagePlus, Trash2, Package, Receipt, Eye, Users, QrCode
} from 'lucide-react';
import { PRINT_LOGO_STORAGE_KEY, persistPrintLogoToDisk } from '@/lib/print-logo';
import { ProductManagementSection } from '@/components/ProductManagementSection';
import { ReceiptManagementSection } from '@/components/ReceiptManagementSection';
import { SidebarPagesSection } from '@/components/SidebarPagesSection';
import { CustomerOrderingSection } from '@/components/CustomerOrderingSection';
import { ReceiptAutoPrintSection } from '@/components/ReceiptAutoPrintSection';
import { getStoreSettings, saveStoreSettings, StoreSettings, CURRENCIES, TIMEZONES } from '@/lib/pos-settings';
import { fetchPrinters } from '@/lib/pos-api';

export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState("Store Profile");
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [printers, setPrinters] = useState<string[]>([]);

  useEffect(() => {
    setSettings(getStoreSettings());
    const isElectron = typeof window !== 'undefined' && navigator.userAgent.includes('Electron');
    if (isElectron) {
      try {
        const { ipcRenderer } = (window as any).require('electron');
        ipcRenderer.invoke('get-printers').then((p: string[]) => {
          if (p && p.length > 0) {
            setPrinters(p);
          } else {
            fetchPrinters().then(apiP => { if (apiP) setPrinters(apiP) });
          }
        }).catch((e: Error) => {
          console.error("IPC get-printers error:", e);
          fetchPrinters().then(apiP => { if (apiP) setPrinters(apiP) });
        });
      } catch (err) {
        console.error("Failed to require electron:", err);
        fetchPrinters().then(apiP => { if (apiP) setPrinters(apiP) });
      }
    } else {
      fetchPrinters().then(p => { if (p) setPrinters(p) });
    }
  }, []);

  const handleSettingChange = (field: keyof StoreSettings, value: any) => {
    if (settings) {
      setSettings(prev => prev ? { ...prev, [field]: value } : null);
    }
  };

  const saveSettings = () => {
    if (settings) {
      saveStoreSettings(settings);
      // alert("Settings saved successfully!");
    }
  };

  const [printLogo, setPrintLogo] = useState<string | null>(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    return window.localStorage.getItem(PRINT_LOGO_STORAGE_KEY);
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const menuItems = [
    { id: "Store Profile", icon: <Store size={18} /> },
    { id: "Manage Products", icon: <Package size={18} /> },
    { id: "Manage Receipt", icon: <Receipt size={18} /> },
    { id: "Sidebar Pages", icon: <Eye size={18} /> },
    { id: "Customer Ordering", icon: <QrCode size={18} /> },
    { id: "Payments & Tax", icon: <CreditCard size={18} /> },
    { id: "Hardware / POS", icon: <Printer size={18} /> },
    { id: "Security", icon: <Lock size={18} /> },
    { id: "Notifications", icon: <Bell size={18} /> },
    { id: "Backup & Data", icon: <Database size={18} /> },
  ];

  const isHardwareSection = activeSection === "Hardware / POS";

  const selectedLogoName = useMemo(() => {
    if (!printLogo) {
      return 'No logo selected';
    }

    if (printLogo.startsWith('data:')) {
      return 'Uploaded print logo';
    }

    const segments = printLogo.split('/');
    return segments[segments.length - 1] || 'Selected print logo';
  }, [printLogo]);

  const persistLogo = (nextLogo: string | null) => {
    setPrintLogo(nextLogo);

    if (typeof window === 'undefined') {
      return;
    }

    if (nextLogo) {
      window.localStorage.setItem(PRINT_LOGO_STORAGE_KEY, nextLogo);
    } else {
      window.localStorage.removeItem(PRINT_LOGO_STORAGE_KEY);
    }

    persistPrintLogoToDisk(nextLogo);
    window.dispatchEvent(new Event('print-logo-updated'));
  };

  const handleLogoSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null;
      persistLogo(result);
    };
    reader.readAsDataURL(file);

    event.target.value = '';
  };

  const handleRemoveLogo = () => {
    persistLogo(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-4 lg:p-8">
      
      {/* Page Header */}
      <div className="mb-8 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            System Settings <Settings className="text-slate-400 animate-spin-slow" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">Configure your workspace and global preferences.</p>
        </div>
        <button onClick={saveSettings} className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-2xl font-black text-sm hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100">
          <Save size={18} /> Save Changes
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        
        {/* LEFT: Settings Navigation */}
        <div className="w-full lg:w-72 space-y-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center justify-between p-4 rounded-2xl font-bold text-sm transition-all ${
                activeSection === item.id 
                ? "bg-white text-indigo-600 shadow-sm border border-slate-100" 
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              }`}
            >
              <div className="flex items-center gap-3">
                {item.icon}
                {item.id}
              </div>
              {activeSection === item.id && <div className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
            </button>
          ))}
          
          <div className="mt-8 p-6 bg-indigo-50 rounded-[32px] border border-indigo-100">
             <div className="flex items-center gap-2 text-indigo-600 mb-2">
               <Shield size={18}/>
               <span className="text-xs font-black uppercase">System Health</span>
             </div>
             <div className="text-2xl font-black text-indigo-900">99.9%</div>
             <p className="text-[10px] text-indigo-400 font-bold mt-1 uppercase">All systems operational</p>
          </div>
        </div>

        {/* RIGHT: Active Form Area */}
        <div className="flex-1 bg-white rounded-[40px] shadow-sm border border-slate-100 p-8 lg:p-12">
          
          {/* Section Header */}
          <div className="mb-10 pb-6 border-b border-slate-50">
            <h2 className="text-2xl font-black text-slate-900">{activeSection}</h2>
            <p className="text-slate-400 font-medium">Update your {activeSection.toLowerCase()} settings and information.</p>
          </div>

          {/* Form Content (Dynamic based on section) */}
          <div className="max-w-3xl space-y-8">
            {activeSection === "Manage Receipt" ? (
              <ReceiptManagementSection settings={settings} onChange={handleSettingChange} printLogo={printLogo} />
            ) : activeSection === "Manage Products" ? (
              <ProductManagementSection />
            ) : activeSection === "Sidebar Pages" ? (
              <SidebarPagesSection />
            ) : activeSection === "Customer Ordering" ? (
              <CustomerOrderingSection />
            ) : (
              <>
                <div className="rounded-[28px] border border-indigo-100 bg-indigo-50/70 p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-black text-slate-900">Receipt Print Logo</p>
                  <p className="mt-1 text-xs font-bold uppercase tracking-wide text-slate-500">
                    Quick access for the logo used on printed cashier and kitchen receipts.
                  </p>
                </div>
                {!isHardwareSection ? (
                  <button
                    type="button"
                    onClick={() => setActiveSection("Hardware / POS")}
                    className="inline-flex items-center gap-2 rounded-2xl border border-indigo-200 bg-white px-4 py-3 text-sm font-black text-indigo-700"
                  >
                    <Printer size={16} />
                    Open Print Settings
                  </button>
                ) : null}
              </div>

              <PrintLogoCard
                printLogo={printLogo}
                selectedLogoName={selectedLogoName}
                fileInputRef={fileInputRef}
                onSelectLogo={handleLogoSelection}
                onRemoveLogo={handleRemoveLogo}
              />
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white p-6">
              <div className="flex items-center gap-2">
                <Users size={18} className="text-indigo-600" />
                <h3 className="text-lg font-black text-slate-900">Waiter Setup Has Moved</h3>
              </div>
              <p className="mt-2 max-w-2xl text-sm text-slate-500">
                Waiters and order takers are now added from <span className="font-bold text-slate-700">Manage Staff</span>.
                Add a staff member there with designation <span className="font-bold text-slate-700">"Waiter"</span> or{' '}
                <span className="font-bold text-slate-700">"Order Taker"</span> and they'll automatically show up in the POS waiter dropdown.
              </p>
            </div>

            {settings && (
            <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Store Name</label>
                <input 
                  type="text" 
                  value={settings.storeName}
                  onChange={e => handleSettingChange('storeName', e.target.value)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Business Email</label>
                <input 
                  type="email" 
                  value={settings.businessEmail}
                  onChange={e => handleSettingChange('businessEmail', e.target.value)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Store Address</label>
              <textarea 
                rows={3}
                value={settings.storeAddress}
                onChange={e => handleSettingChange('storeAddress', e.target.value)}
                className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none resize-none" 
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Business Start Time</label>
                <input 
                  type="time" 
                  value={settings.businessStartTime || "10:00"}
                  onChange={e => handleSettingChange('businessStartTime', e.target.value)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Business End Time</label>
                <input 
                  type="time" 
                  value={settings.businessEndTime || "02:00"}
                  onChange={e => handleSettingChange('businessEndTime', e.target.value)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Currency</label>
                <select 
                  value={settings.currency}
                  onChange={e => handleSettingChange('currency', e.target.value)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none font-bold outline-none appearance-none"
                >
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Timezone</label>
                <select 
                  value={settings.timezone}
                  onChange={e => handleSettingChange('timezone', e.target.value)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none font-bold outline-none appearance-none"
                >
                  {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Tax Rate (%)</label>
                <input 
                  type="number" 
                  value={settings.taxRate}
                  onChange={e => handleSettingChange('taxRate', parseFloat(e.target.value) || 0)}
                  className="w-full p-4 bg-slate-50 rounded-2xl border-none font-bold outline-none" 
                />
              </div>
            </div>

            {/* Toggle Sections */}
            <div className="pt-6 space-y-4">
               <h3 className="text-sm font-black text-slate-900 mb-4">Device Preferences</h3>
               <ToggleItem icon={<Monitor size={18}/>} label="Dual Screen Display" description="Enable customer-facing checkout screen." enabled={settings.dualScreenDisplay} onToggle={v => handleSettingChange('dualScreenDisplay', v)} />
               <ToggleItem icon={<Printer size={18}/>} label="Auto-print Receipts" description="Print physical receipt after every transaction." enabled={settings.autoPrintReceipts} onToggle={v => handleSettingChange('autoPrintReceipts', v)} />
            </div>
            </>
            )}

            {isHardwareSection && settings ? (
              <div className="space-y-6">
                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6">
                  <h3 className="text-sm font-black text-slate-900 mb-4">Device Printers</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Counter Printer</label>
                      <select 
                        value={settings.counterPrinter || ""}
                        onChange={e => handleSettingChange('counterPrinter', e.target.value)}
                        className="w-full p-4 bg-white rounded-2xl border border-slate-200 font-bold outline-none appearance-none"
                      >
                        <option value="">Select Counter Printer</option>
                        {printers.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Kitchen Printer</label>
                      <select 
                        value={settings.kitchenPrinter || ""}
                        onChange={e => handleSettingChange('kitchenPrinter', e.target.value)}
                        className="w-full p-4 bg-white rounded-2xl border border-slate-200 font-bold outline-none appearance-none"
                      >
                        <option value="">Select Kitchen Printer</option>
                        {printers.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-6">
                <div className="mb-4">
                  <p className="text-sm font-black text-slate-900">Receipt Print Logo</p>
                  <p className="mt-1 text-xs font-bold uppercase tracking-wide text-slate-400">
                    Choose the logo that appears at the top of printed cashier and kitchen receipts.
                  </p>
                </div>

                <PrintLogoCard
                  printLogo={printLogo}
                  selectedLogoName={selectedLogoName}
                  fileInputRef={fileInputRef}
                  onSelectLogo={handleLogoSelection}
                  onRemoveLogo={handleRemoveLogo}
                />
              </div>

              <ReceiptAutoPrintSection />
              </div>
            ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- SHARED UI COMPONENTS ---

function ToggleItem({ icon, label, description, enabled, onToggle }: { icon: React.ReactNode, label: string, description: string, enabled: boolean, onToggle: (val: boolean) => void }) {
  return (
    <div className="flex items-center justify-between p-4 bg-slate-50 rounded-3xl border border-transparent hover:border-slate-200 transition-all cursor-pointer" onClick={() => onToggle(!enabled)}>
      <div className="flex items-center gap-4">
        <div className="p-3 bg-white rounded-2xl text-slate-400 shadow-sm">{icon}</div>
        <div>
          <p className="text-sm font-black text-slate-900">{label}</p>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-tight">{description}</p>
        </div>
      </div>
      <button 
        tabIndex={-1}
        className={`w-12 h-6 rounded-full p-1 transition-all flex items-center ${enabled ? "bg-indigo-600 justify-end" : "bg-slate-300 justify-start"}`}
      >
        <div className="w-4 h-4 bg-white rounded-full shadow-sm" />
      </button>
    </div>
  );
}

function PrintLogoCard({
  printLogo,
  selectedLogoName,
  fileInputRef,
  onSelectLogo,
  onRemoveLogo,
}: {
  printLogo: string | null;
  selectedLogoName: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onSelectLogo: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveLogo: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={onSelectLogo}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-2xl bg-black px-4 py-3 text-sm font-black text-white"
        >
          <ImagePlus size={16} />
          {printLogo ? "Change Logo" : "Select Logo"}
        </button>
        {printLogo ? (
          <button
            type="button"
            onClick={onRemoveLogo}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700"
          >
            <Trash2 size={16} />
            Remove
          </button>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-[140px_minmax(0,1fr)]">
        <div className="flex h-[140px] items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white p-4">
          {printLogo ? (
            <img src={printLogo} alt="Selected print logo preview" className="max-h-full w-auto max-w-full object-contain" />
          ) : (
            <span className="text-center text-[11px] font-black uppercase tracking-[0.25em] text-slate-300">
              No Logo
            </span>
          )}
        </div>
        <div className="space-y-3 rounded-3xl bg-white p-5">
          <p className="text-xs font-black uppercase tracking-[0.25em] text-slate-400">Selected Asset</p>
          <p className="text-sm font-bold text-slate-700">{selectedLogoName}</p>
          <p className="text-sm text-slate-500">
            Use a clean PNG, JPG, WEBP, or SVG. The logo is saved in this browser and will be used the next time you open the print center.
          </p>
        </div>
      </div>
    </>
  );
}
