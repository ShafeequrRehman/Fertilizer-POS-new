import fs from 'fs';

const filePath = 'app/dashboard/pos/page.tsx';
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace("from '@/lib/pos-types';\\nimport { getStoreSettings }", "from '@/lib/pos-types';\nimport { getStoreSettings }");

content = content.replace("= useState(true);\\n  const [taxRate", "= useState(true);\n  const [taxRate");

content = content.replace("  }\\n    setTaxRate(getStoreSettings().taxRate || 0);", "  }\n    setTaxRate(getStoreSettings().taxRate || 0);");
// also fallback
content = content.replace("useEffect(() => {\\n    setTaxRate", "useEffect(() => {\n    setTaxRate");
content = content.replace(".taxRate || 0);\\n    if (!isAuthenticated())", ".taxRate || 0);\n    if (!isAuthenticated())");

content = content.replace(" * item.quantity, 0);\\n  const tax =", " * item.quantity, 0);\n  const tax =");
content = content.replace(") / 100;\\n  const total =", ") / 100;\n  const total =");

fs.writeFileSync(filePath, content);
console.log("Fixed!");
