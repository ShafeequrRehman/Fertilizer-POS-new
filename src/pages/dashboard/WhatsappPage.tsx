
import React, { useState, useEffect, useCallback } from 'react';
import { fetchWhatsappStatus, fetchWhatsappQR, sendWhatsappMessage, fetchAllCustomers } from '@/lib/pos-api';
import { Customer } from '@/lib/pos-types';
import { Send, Users, AlertCircle, CheckCircle2, Phone, MessageSquare, Loader2, RefreshCw } from 'lucide-react';
import { useToast } from '@/lib/toast';

interface WhatsAppStatus {
  isConnected: boolean;
  hasQR: boolean;
  socketReady: boolean;
}

export default function WhatsAppManager() {
  const { toast } = useToast();
  const [status, setStatus] = useState<WhatsAppStatus>({ isConnected: false, hasQR: false, socketReady: false });
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  // Manual message state
  const [manualPhone, setManualPhone] = useState('');
  const [manualMessage, setManualMessage] = useState('');
  const [isSendingManual, setIsSendingManual] = useState(false);
  const [manualStatus, setManualStatus] = useState<{ type: 'success' | 'error' | null, message: string }>({ type: null, message: '' });

  // Promotions state
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [promoMessage, setPromoMessage] = useState('');
  const [isSendingPromo, setIsSendingPromo] = useState(false);
  const [promoProgress, setPromoProgress] = useState(0);

  // Poll status
  const checkStatus = useCallback(async () => {
    try {
      const res = await fetchWhatsappStatus();
      if (res) {
        setStatus(res);
        if (!res.isConnected) {
          fetchQR();
        } else {
          setQrCode(null);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchQR = async () => {
    try {
      const res = await fetchWhatsappQR();
      if (res?.qr) {
        setQrCode(res.qr);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  useEffect(() => {
    fetchAllCustomers().then(c => {
      if (c) setCustomers(c.filter(cust => cust.phone && cust.phone.length >= 10));
    });
  }, []);

  const handleSendManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualPhone || !manualMessage) return;
    
    setIsSendingManual(true);
    setManualStatus({ type: null, message: '' });
    try {
      const res = await sendWhatsappMessage(manualPhone, manualMessage);
      if (res?.success) {
        setManualStatus({ type: 'success', message: 'Message sent successfully!' });
        setManualPhone('');
        setManualMessage('');
      } else {
        setManualStatus({ type: 'error', message: res?.error || 'Failed to send message.' });
      }
    } catch (err: any) {
      setManualStatus({ type: 'error', message: err.message || 'An error occurred.' });
    } finally {
      setIsSendingManual(false);
    }
  };

  const handleSendPromo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promoMessage || customers.length === 0) return;
    
    setIsSendingPromo(true);
    setPromoProgress(0);
    
    let sentCount = 0;
    for (let i = 0; i < customers.length; i++) {
        try {
            await sendWhatsappMessage(customers[i].phone, promoMessage);
        } catch {
            console.error(`Failed to send promo to ${customers[i].phone}`);
        }
        sentCount++;
        setPromoProgress(Math.round((sentCount / customers.length) * 100));
        // Randomized 1-2s delay (not a fixed interval) so a bulk blast
        // doesn't look like a bot firing messages at a perfectly even
        // cadence - reduces the chance WhatsApp flags the number for spam.
        const delayMs = 1000 + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    toast.success(`Promotion sent to ${sentCount} customers!`);
    setIsSendingPromo(false);
    setPromoMessage('');
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">WhatsApp Manager</h1>
        <button onClick={checkStatus} className="p-2 bg-white rounded-md border shadow-sm hover:bg-gray-50 flex items-center gap-2 text-sm">
          <RefreshCw size={16} />
          Refresh Status
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Connection Status Panel */}
        <div className="col-span-1 bg-white rounded-xl shadow-sm border p-6 flex flex-col items-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4 bg-green-100 text-green-600">
            <MessageSquare size={32} />
          </div>
          <h2 className="text-xl font-bold mb-2">Connection Status</h2>
          
          {isLoading ? (
            <div className="flex items-center text-gray-500 mt-4">
              <Loader2 className="animate-spin mr-2" /> Checking...
            </div>
          ) : status.isConnected ? (
            <div className="flex flex-col items-center mt-4">
              <div className="flex items-center text-green-600 font-bold bg-green-50 px-4 py-2 rounded-full">
                <CheckCircle2 className="mr-2" /> Connected & Ready
              </div>
              <p className="text-sm text-gray-500 text-center mt-4">
                Your POS is securely linked to WhatsApp and ready to send receipts and promotions.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center mt-4 w-full">
              <div className="flex items-center text-amber-600 font-bold bg-amber-50 px-4 py-2 rounded-full mb-6">
                <AlertCircle className="mr-2" /> Disconnected
              </div>
              
              {qrCode ? (
                <div className="bg-white p-2 border-2 border-gray-100 rounded-lg shadow-sm w-full mx-auto max-w-[250px] aspect-square flex items-center justify-center">
                  <img src={qrCode} alt="WhatsApp QR Code" className="w-full h-full object-contain" />
                </div>
              ) : (
                <div className="bg-gray-50 w-full max-w-[250px] aspect-square flex items-center justify-center rounded-lg border-2 border-dashed">
                  <Loader2 className="animate-spin text-gray-400" />
                </div>
              )}
              
              <div className="text-sm text-gray-600 text-center mt-6">
                <p className="font-semibold text-gray-900 mb-1">To connect:</p>
                <ol className="list-decimal text-left pl-6 space-y-1">
                  <li>Open WhatsApp on your phone</li>
                  <li>Tap Menu / Settings and select <b>Linked Devices</b></li>
                  <li>Tap on <b>Link a Device</b></li>
                  <li>Point your phone to this screen to capture the code</li>
                </ol>
              </div>
            </div>
          )}
        </div>

        {/* Messaging Panels */}
        <div className="col-span-1 md:col-span-2 space-y-6">
          <div className={`transition-opacity duration-300 ${!status.isConnected ? 'opacity-50 pointer-events-none' : ''}`}>
            {/* Manual Message */}
            <div className="bg-white rounded-xl shadow-sm border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Send className="text-indigo-600" />
                <h2 className="text-lg font-bold">Standard Message</h2>
              </div>
              
              <form onSubmit={handleSendManual} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer Phone Number</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Phone size={16} className="text-gray-400" />
                    </div>
                    <input 
                      type="text" 
                      value={manualPhone}
                      onChange={(e) => setManualPhone(e.target.value)}
                      placeholder="e.g. 03001234567" 
                      className="pl-10 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm border p-2.5"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Message Content</label>
                  <textarea 
                    value={manualMessage}
                    onChange={(e) => setManualMessage(e.target.value)}
                    rows={4} 
                    className="block w-full rounded-md border border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-3"
                    placeholder="Type your message here..."
                  />
                </div>

                <div className="flex items-center gap-4">
                  <button 
                    type="submit" 
                    disabled={isSendingManual || !manualPhone || !manualMessage}
                    className="flex-1 bg-indigo-600 text-white rounded-md py-2.5 px-4 font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:bg-gray-300 disabled:cursor-not-allowed flex justify-center items-center"
                  >
                    {isSendingManual ? <Loader2 className="animate-spin" size={20} /> : 'Send Message'}
                  </button>
                  
                  {manualStatus.type && (
                    <div className={`px-3 py-1 rounded-full text-sm font-medium ${manualStatus.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                      {manualStatus.message}
                    </div>
                  )}
                </div>
              </form>
            </div>

            {/* Mass Promotion (Only visible if connected) */}
            <div className="bg-white rounded-xl shadow-sm border p-6 mt-6 relative overflow-hidden">
              <div className="flex items-center gap-2 mb-2">
                <Users className="text-orange-600" />
                <h2 className="text-lg font-bold">Marketing Blast</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">Send a promotional message or deal to your entire customer database.</p>
              
              <div className="bg-gray-50 p-4 rounded-lg mb-4 border text-sm">
                <span className="font-semibold text-gray-700">Audience: </span>
                <span className="text-indigo-600 font-bold">{customers.length}</span> Customers with registered valid phone numbers
              </div>

              <form onSubmit={handleSendPromo}>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Promotion Message Layout</label>
                  <textarea 
                    value={promoMessage}
                    onChange={e => setPromoMessage(e.target.value)}
                    rows={5} 
                    className="block w-full rounded-md border border-gray-300 shadow-sm focus:border-orange-500 focus:ring-orange-500 sm:text-sm p-3"
                    placeholder="Hi! Check out our new weekend deals at The Heaven Slice! 🔥🍕"
                  />
                  <p className="text-xs text-gray-500 mt-2">To prevent spam blocks, messages are sent one at a time with a random 1-2 second gap between each customer.</p>
                </div>

                {isSendingPromo ? (
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm font-medium text-gray-700">
                      <span>Sending Broadcast...</span>
                      <span>{promoProgress}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5">
                      <div className="bg-orange-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${promoProgress}%` }}></div>
                    </div>
                  </div>
                ) : (
                  <button 
                    type="submit" 
                    disabled={!promoMessage || customers.length === 0}
                    className="w-full bg-orange-600 text-white rounded-md py-2.5 px-4 font-medium hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 disabled:bg-gray-300 flex justify-center items-center gap-2"
                  >
                    <Send size={18} />
                    Blast to {customers.length} Customers
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
