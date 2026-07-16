// Resolves a product image filename (or an already-formed path/URL) stored
// on a Product document into a usable <img src>.
//
// Product SVGs live in public/products/*.svg, which Vite copies verbatim
// into dist/products/*.svg on `vite build`. This app is loaded two
// different ways depending on context:
//   - dev: Vite dev server at http://localhost:5173
//   - production: Electron loads dist/index.html directly over `file://`
//     (see main.js)
//
// Everything routes through HashRouter (src/main.tsx), specifically so the
// document's base URL never changes across in-app navigation - which means
// a plain RELATIVE path resolves correctly in both contexts. A path with a
// LEADING SLASH must never be used here: under `file://`, `/products/x.svg`
// resolves against the filesystem/drive root, not the app's dist/ folder,
// and silently 404s. That previously broke every product icon in the
// packaged production build while looking fine in dev, because the Vite
// dev server happens to also serve public/ at its own root - masking the
// bug until the app was actually installed.
//
// Product.image in MongoDB has historically been saved in a few different
// shapes depending on which picker UI was used ("beef-burger-combo.svg",
// "/products/beef-burger-combo.svg", or occasionally a full hosted URL) -
// this normalizes all of them to one relative form.
export function getProductImageUrl(image?: string | null): string {
  if (!image) return '';

  // Already a full URL (external/hosted image) or a data URI - leave as-is.
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(image) || image.startsWith('data:')) {
    return image;
  }

  const trimmed = image.replace(/^\/+/, '');
  return trimmed.startsWith('products/') ? trimmed : `products/${trimmed}`;
}
