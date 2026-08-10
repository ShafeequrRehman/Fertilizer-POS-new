// The `qrcode` package (already a dependency - see backend WhatsApp QR
// login flow) ships no TypeScript types of its own and `@types/qrcode`
// isn't installed. Minimal ambient declaration covering just the one
// function OfflineSyncPage.tsx needs (toDataURL), so importing it from
// frontend code type-checks without pulling in a new dependency.
declare module "qrcode" {
  interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    color?: { dark?: string; light?: string };
  }

  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;

  const QRCode: { toDataURL: typeof toDataURL };
  export default QRCode;
}
