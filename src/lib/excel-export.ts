// Zero-dependency, styled Excel export.
//
// Why not a library (exceljs / xlsx)? Adding either requires `npm install`,
// which needs network access to the npm registry - not something this
// codebase can assume is always available while iterating, and not
// something worth a new dependency + install step for. Excel has natively
// understood an XML workbook format ("SpreadsheetML", the Excel 2003 XML
// format) for 20+ years: a plain XML string that Excel opens directly, with
// real multiple named sheets, cell background colors, bold fonts, borders,
// and number formats (e.g. "Rs " currency). That covers everything a
// "beautifully designed" export needs without pulling in a library at all.
//
// Saved with a .xls extension (the traditional extension for this format).
// Modern Excel opens it straight away - occasionally with a one-time "this
// file's format doesn't match its extension, open anyway?" prompt, which is
// expected for this format and safe to accept.

export interface ExcelCellStyle {
  bold?: boolean;
  bg?: string; // fill color, hex WITHOUT '#', e.g. '1F2937'
  color?: string; // font color, hex WITHOUT '#'
  format?: string; // Excel number format string, e.g. '"Rs "#,##0'
  align?: 'Left' | 'Center' | 'Right';
  fontSize?: number;
  borderBottom?: boolean;
}

export interface ExcelCell {
  value: string | number;
  style?: ExcelCellStyle;
}

export interface ExcelSheet {
  name: string;
  columnWidths?: number[];
  rows: ExcelCell[][];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function styleKey(style: ExcelCellStyle): string {
  // Stringify as a plain object (not an array) - this string is parsed
  // straight back into an ExcelCellStyle below, so the shapes must match.
  return JSON.stringify({
    bold: style.bold,
    bg: style.bg,
    color: style.color,
    format: style.format,
    align: style.align,
    fontSize: style.fontSize,
    borderBottom: style.borderBottom,
  });
}

export function buildExcelWorkbookXml(sheets: ExcelSheet[]): string {
  const styleMap = new Map<string, string>();
  let styleCounter = 0;

  function getStyleId(style?: ExcelCellStyle): string | null {
    if (!style) return null;
    const key = styleKey(style);
    const existing = styleMap.get(key);
    if (existing) return existing;
    styleCounter += 1;
    const id = `s${styleCounter}`;
    styleMap.set(key, id);
    return id;
  }

  // Pre-pass: register every distinct style so the <Styles> block can be
  // emitted before any <Worksheet> references it (order matters to Excel).
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        getStyleId(cell.style);
      }
    }
  }

  const stylesXml = Array.from(styleMap.entries())
    .map(([key, id]) => {
      const { bold, bg, color, format, align, fontSize, borderBottom }: ExcelCellStyle = JSON.parse(key);
      const parts: string[] = [];
      if (bold || color || fontSize) {
        parts.push(
          `<Font${bold ? ' ss:Bold="1"' : ''}${color ? ` ss:Color="#${color}"` : ''}${fontSize ? ` ss:Size="${fontSize}"` : ''}/>`,
        );
      }
      if (bg) parts.push(`<Interior ss:Color="#${bg}" ss:Pattern="Solid"/>`);
      if (format) parts.push(`<NumberFormat ss:Format="${escapeXml(format)}"/>`);
      if (align) parts.push(`<Alignment ss:Horizontal="${align}" ss:Vertical="Center"/>`);
      if (borderBottom) {
        parts.push(`<Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1D5DB"/></Borders>`);
      }
      return `  <Style ss:ID="${id}">${parts.join('')}</Style>`;
    })
    .join('\n');

  const sheetsXml = sheets
    .map((sheet) => {
      const colsXml = (sheet.columnWidths || []).map((width) => `<Column ss:Width="${width}"/>`).join('');
      const rowsXml = sheet.rows
        .map((row) => {
          const cellsXml = row
            .map((cell) => {
              const styleId = getStyleId(cell.style);
              const isNumber = typeof cell.value === 'number' && Number.isFinite(cell.value);
              const dataType = isNumber ? 'Number' : 'String';
              const rawValue = isNumber ? String(cell.value) : escapeXml(String(cell.value));
              return `<Cell${styleId ? ` ss:StyleID="${styleId}"` : ''}><Data ss:Type="${dataType}">${rawValue}</Data></Cell>`;
            })
            .join('');
          return `<Row>${cellsXml}</Row>`;
        })
        .join('');

      // Excel worksheet names: max 31 chars, and none of : \ / ? * [ ] allowed.
      const safeName = escapeXml(sheet.name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31)) || 'Sheet';

      return `<Worksheet ss:Name="${safeName}"><Table>${colsXml}${rowsXml}</Table></Worksheet>`;
    })
    .join('\n');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
${stylesXml}
 </Styles>
${sheetsXml}
</Workbook>`;
}

export function downloadExcelWorkbook(sheets: ExcelSheet[], filename: string): void {
  const xml = buildExcelWorkbookXml(sheets);
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.xls') ? filename : `${filename}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Task 5 (Export & WhatsApp Supplier Communication): the same workbook as
// downloadExcelWorkbook above, but as base64 bytes instead of a browser
// download - what pos-api.ts's sendWhatsappDocument needs. The workbook is
// plain UTF-8 XML text (not a binary format), so this only needs a
// TextEncoder + a plain byte->base64 loop - no Blob/FileReader round trip
// required the way the PDF export needs (see pdf-export.tsx's
// pdfDocumentToBase64).
export function excelWorkbookToBase64(sheets: ExcelSheet[]): string {
  const xml = buildExcelWorkbookXml(sheets);
  const bytes = new TextEncoder().encode(xml);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
