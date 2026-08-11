import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { StoreSettings } from '@/lib/pos-settings';

interface Props {
  settings: StoreSettings | null;
  onChange: (field: keyof StoreSettings, value: string | number) => void;
  printLogo: string | null;
}

// Which printed layout each receipt type uses - see
// src/pages/dashboard/components/ReceiptRenderer.tsx for how these get
// picked at print time, and ItemizedBillReceipt.tsx / KitchenKotReceipt.tsx
// for the newer templates modeled on real till printouts the shop provided
// ("Classic" is the app's original ThermalReceipt.tsx layout).
const CASHIER_TEMPLATES: Array<{ id: NonNullable<StoreSettings['cashierReceiptTemplate']>; label: string; description: string }> = [
  { id: 'classic', label: 'Classic', description: 'Large centered order number, simple item list.' },
  { id: 'itemizedBill', label: 'Itemized Bill', description: 'Qty/Price/Amount columns, totals, and an "In Words" line.' },
];

const KITCHEN_TEMPLATES: Array<{ id: NonNullable<StoreSettings['kitchenReceiptTemplate']>; label: string; description: string }> = [
  { id: 'classic', label: 'Classic', description: 'Large centered order number, simple item list.' },
  { id: 'kot', label: 'KOT Ticket', description: 'Numbered item table styled like a traditional kitchen order ticket.' },
];

function TemplateOptionCard<T extends string>({ id, label, description, selected, onSelect }: { id: T; label: string; description: string; selected: boolean; onSelect: (id: T) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`flex-1 text-left rounded-2xl border-2 p-4 transition-all ${selected ? 'border-indigo-500 bg-indigo-50' : 'border-slate-100 bg-slate-50 hover:border-slate-200'}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-black text-slate-900">{label}</span>
        {selected && <CheckCircle2 size={18} className="text-indigo-600" />}
      </div>
      <p className="mt-1 text-xs font-bold text-slate-500">{description}</p>
    </button>
  );
}

export function ReceiptManagementSection({ settings, onChange, printLogo }: Props) {
  if (!settings) return null;

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      {/* Form Area - Left Side */}
      <div className="flex-1 space-y-6">
        <div className="space-y-3">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Customer Receipt Template</label>
          <div className="flex flex-col sm:flex-row gap-3">
            {CASHIER_TEMPLATES.map((tpl) => (
              <TemplateOptionCard
                key={tpl.id}
                id={tpl.id}
                label={tpl.label}
                description={tpl.description}
                selected={(settings.cashierReceiptTemplate || 'classic') === tpl.id}
                onSelect={(id) => onChange('cashierReceiptTemplate', id)}
              />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Kitchen Ticket Template</label>
          <div className="flex flex-col sm:flex-row gap-3">
            {KITCHEN_TEMPLATES.map((tpl) => (
              <TemplateOptionCard
                key={tpl.id}
                id={tpl.id}
                label={tpl.label}
                description={tpl.description}
                selected={(settings.kitchenReceiptTemplate || 'classic') === tpl.id}
                onSelect={(id) => onChange('kitchenReceiptTemplate', id)}
              />
            ))}
          </div>
        </div>

        {settings.cashierReceiptTemplate === 'itemizedBill' && (
          <div className="space-y-2">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Service Charge % (Itemized Bill only)</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={settings.serviceChargePercent ?? 0}
              onChange={e => onChange('serviceChargePercent', parseFloat(e.target.value) || 0)}
              placeholder="e.g. 5"
              className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none"
            />
            <p className="text-xs text-slate-400 font-bold ml-1">Leave at 0 to hide the SC line on the bill.</p>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Receipt Top Heading</label>
          <input 
            type="text" 
            value={settings.receiptHeader || ''}
            onChange={e => onChange('receiptHeader', e.target.value)}
            placeholder="e.g. The Heaven Slice"
            className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
          />
        </div>
        
        <div className="space-y-2">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Establishment / Sub-heading</label>
          <input 
            type="text" 
            value={settings.receiptSubHeader || ''}
            onChange={e => onChange('receiptSubHeader', e.target.value)}
            placeholder="e.g. Est. 2022"
            className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Receipt Address</label>
          <textarea 
            rows={2}
            value={settings.receiptAddress || ''}
            onChange={e => onChange('receiptAddress', e.target.value)}
            placeholder="e.g. Gojra Road Near Ali Merriage Hall"
            className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none resize-none" 
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Contact Number</label>
          <input 
            type="text" 
            value={settings.receiptContact || ''}
            onChange={e => onChange('receiptContact', e.target.value)}
            placeholder="e.g. 0300-0310275"
            className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Payment Info (JazzCash/EasyPaisa)</label>
          <input 
            type="text" 
            value={settings.receiptPaymentInfo || ''}
            onChange={e => onChange('receiptPaymentInfo', e.target.value)}
            placeholder="e.g. 0307 - 4798089 Jazzcash/EasyPaisa"
            className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Footer Message</label>
          <input 
            type="text" 
            value={settings.receiptFooterMessage || ''}
            onChange={e => onChange('receiptFooterMessage', e.target.value)}
            placeholder="e.g. Thank You for your Order!"
            className="w-full p-4 bg-slate-50 rounded-2xl border-none focus:ring-2 focus:ring-indigo-500 font-bold outline-none" 
          />
        </div>
      </div>

      {/* Preview Area - Right Side */}
      <div className="w-full lg:w-[350px] lg:border-l lg:border-slate-100 lg:pl-8 flex flex-col items-center">
        <h3 className="text-sm font-black text-slate-900 mb-6 w-full text-center uppercase tracking-widest">Live Preview</h3>
        
        {/* Receipt Mockup */}
        <div className="bg-white border border-slate-200 shadow-md p-6 w-[300px] text-center shrink-0" style={{ fontFamily: 'monospace' }}>
          {printLogo && (
            <img src={printLogo} alt="Logo" className="max-w-[110px] mx-auto mb-2 grayscale" />
          )}
          
          <h2 className="font-bold text-xl uppercase leading-tight mt-2">
            {settings.receiptHeader || 'Store Name'}
          </h2>
          
          {settings.receiptSubHeader && (
            <p className="text-[11px] text-slate-600 mb-2">{settings.receiptSubHeader}</p>
          )}
          
          {settings.receiptAddress && (
            <p className="text-xs mb-1 mt-2 whitespace-pre-wrap">{settings.receiptAddress}</p>
          )}
          
          {settings.receiptContact && (
            <p className="text-xs mb-1">Tel: {settings.receiptContact}</p>
          )}
          
          <div className="border-t border-dashed border-slate-400 my-4"></div>
          
          <p className="text-xs text-left">Date: 12-Oct-2026 14:30</p>
          <p className="text-xs text-left mb-2">Order #: 1024</p>
          
          <div className="border-t border-dashed border-slate-400 my-2"></div>
          
          <div className="flex justify-between text-xs font-bold mb-2">
            <span>Item</span>
            <span>Total</span>
          </div>
          <div className="flex justify-between text-xs mb-1">
            <span>1x Classic Pizza</span>
            <span>850</span>
          </div>
          <div className="flex justify-between text-xs mb-1">
            <span>2x Cold Drink</span>
            <span>150</span>
          </div>
          
          <div className="border-t border-dashed border-slate-400 my-2"></div>
          
          <div className="flex justify-between text-sm font-bold mb-4">
            <span>TOTAL</span>
            <span>1000</span>
          </div>
          
          {settings.receiptPaymentInfo && (
            <p className="text-[11px] mb-2">{settings.receiptPaymentInfo}</p>
          )}
          
          <div className="border-t border-dashed border-slate-400 my-4"></div>
          
          {settings.receiptFooterMessage && (
            <p className="text-xs font-bold">{settings.receiptFooterMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
}
