// Shared "Download PDF" building blocks for report-style pages (Record,
// Ledger, and any future one). Built on @react-pdf/renderer, which was
// already a project dependency before this - it's what main.js uses in the
// Electron MAIN process to silently print receipts, just never from the
// renderer/frontend side until now. It ships a dedicated browser build
// (see its package.json "browser" field), so it works the same way here,
// in a plain page component, entirely client-side: no new dependency, no
// backend PDF endpoint, no network round trip beyond the data fetch
// already happening for the on-screen view.
//
// Deliberately NOT a bespoke per-page layout - both Record and Ledger just
// need "a title, maybe a stats row, one or more tables" rendered onto a
// landscape A4 page, so this is one small, reusable document shape rather
// than two near-identical hand-rolled ones.
import type { ReactElement } from 'react';
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer';
import { getAuthShop } from '@/lib/auth';
import { playPrintSound } from '@/lib/audio-feedback';

export interface PdfStat {
  label: string;
  value: string;
}

export interface PdfTableColumn {
  label: string;
  /** Relative flex weight for this column's width - wider content, bigger number. */
  width: number;
  align?: 'left' | 'right' | 'center';
}

export interface PdfTable {
  title?: string;
  columns: PdfTableColumn[];
  rows: Array<Array<string | number>>;
  /** One bolded totals row rendered under the table, same column widths. */
  footer?: Array<string | number>;
  emptyMessage?: string;
}

const styles = StyleSheet.create({
  page: { padding: 28, paddingBottom: 36, fontSize: 9, fontFamily: 'Helvetica', color: '#1f2937' },
  header: { marginBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerLeft: { flexShrink: 1 },
  // Restaurant Name - the letterhead every exported PDF opens with, above
  // the report's own title. The whole reason this matters: these sheets
  // routinely get forwarded straight to a supplier on WhatsApp with no
  // other context attached, so whoever opens it needs to immediately see
  // WHICH restaurant's stock order/statement this is, not just what kind
  // of report it is.
  restaurantName: { fontSize: 16, fontWeight: 700, color: '#111827', letterSpacing: 0.2 },
  title: { fontSize: 12.5, fontWeight: 700, color: '#374151', marginTop: 4 },
  subtitle: { fontSize: 9.5, color: '#6b7280', marginTop: 3 },
  // Live Generation Timestamp - printed top-right on every page, opposite
  // the title, so whoever's holding a printout (or forwarding the PDF on
  // WhatsApp) always knows exactly when these figures were pulled, without
  // having to hunt for the small page-footer text.
  generatedBlock: { alignItems: 'flex-end', flexShrink: 0, marginLeft: 12 },
  generatedLabel: { fontSize: 7, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: 0.6 },
  generatedValue: { fontSize: 9.5, fontWeight: 700, color: '#111827', marginTop: 2 },
  statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  statCard: { flexGrow: 1, flexBasis: 0, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 6, padding: 8 },
  statLabel: { fontSize: 7, textTransform: 'uppercase', color: '#9ca3af', letterSpacing: 0.6 },
  statValue: { fontSize: 13, fontWeight: 700, marginTop: 3, color: '#111827' },
  tableTitle: { fontSize: 11, fontWeight: 700, marginBottom: 6, marginTop: 16, color: '#111827' },
  tableHeaderRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#111827', paddingBottom: 4, marginBottom: 2 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e5e7eb', paddingVertical: 3.5 },
  tableFooterRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#111827', paddingTop: 4, marginTop: 2 },
  th: { fontSize: 7.5, fontWeight: 700, textTransform: 'uppercase', color: '#6b7280', paddingRight: 4 },
  td: { fontSize: 8.5, paddingRight: 4 },
  footerCell: { fontSize: 8.5, fontWeight: 700, paddingRight: 4 },
  emptyRow: { fontSize: 9, color: '#9ca3af', paddingVertical: 10 },
  footer: { position: 'absolute', bottom: 14, left: 28, right: 28, fontSize: 7.5, color: '#9ca3af', textAlign: 'center' },
});

// Takes one of the base cell styles above (th/td/footerCell) and merges in
// this specific column's width/alignment - a plain merged object rather
// than a style ARRAY (react-pdf does support style arrays, but typing one
// generically here would need importing react-pdf's internal `Style` type
// just for this; a merged object structurally satisfies it on its own).
function cellStyle<T extends object>(base: T, align: PdfTableColumn['align'], width: number) {
  return { ...base, flexGrow: width, flexBasis: 0, textAlign: align ?? 'left' };
}

function TableBlock({ table }: { table: PdfTable }) {
  return (
    <View>
      {table.title ? <Text style={styles.tableTitle}>{table.title}</Text> : null}
      <View style={styles.tableHeaderRow}>
        {table.columns.map((column, index) => (
          <Text key={index} style={cellStyle(styles.th, column.align, column.width)}>{column.label}</Text>
        ))}
      </View>
      {table.rows.length === 0 ? (
        <Text style={styles.emptyRow}>{table.emptyMessage || 'No records for this selection.'}</Text>
      ) : (
        table.rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.tableRow} wrap={false}>
            {row.map((cell, cellIndex) => {
              const column = table.columns[cellIndex];
              return (
                <Text key={cellIndex} style={cellStyle(styles.td, column?.align, column?.width ?? 1)}>{String(cell)}</Text>
              );
            })}
          </View>
        ))
      )}
      {table.footer ? (
        <View style={styles.tableFooterRow} wrap={false}>
          {table.footer.map((cell, cellIndex) => {
            const column = table.columns[cellIndex];
            return (
              <Text key={cellIndex} style={cellStyle(styles.footerCell, column?.align, column?.width ?? 1)}>{String(cell)}</Text>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// Renders as a fixed footer on every page ({pageNumber} of {totalPages} via
// react-pdf's built-in `render` prop) - handy once a long transaction log
// spans several pages, which the on-screen "Load More" pagination never
// has to think about since a PDF has no equivalent. The generation
// timestamp itself now lives top-right in the header (see generatedBlock
// above) - this just tracks pagination.
function PageFooter() {
  return (
    <Text
      style={styles.footer}
      fixed
      render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
    />
  );
}

export function ReportPdfDocument({
  title,
  subtitle,
  stats,
  tables,
}: {
  title: string;
  subtitle?: string;
  stats?: PdfStat[];
  tables: PdfTable[];
}) {
  // Exact Current Date and Time of generation - computed once, right here,
  // at the moment this document is actually rendered (a download or a
  // WhatsApp send both call this fresh), not cached or reused across
  // exports.
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  // Restaurant Name letterhead - read fresh at render time (same
  // localStorage-backed source DashboardShell.tsx's sidebar reads, kept
  // current the instant Settings saves a new name via updateCachedShopName)
  // so a stale name is never baked into a PDF someone downloaded before an
  // edit synced.
  const restaurantName = getAuthShop()?.name || 'Restaurant';
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page} wrap>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.restaurantName}>{restaurantName}</Text>
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          <View style={styles.generatedBlock}>
            <Text style={styles.generatedLabel}>Generated</Text>
            <Text style={styles.generatedValue}>{generatedAt}</Text>
          </View>
        </View>
        {stats && stats.length > 0 ? (
          <View style={styles.statsRow}>
            {stats.map((stat, index) => (
              <View key={index} style={styles.statCard}>
                <Text style={styles.statLabel}>{stat.label}</Text>
                <Text style={styles.statValue}>{stat.value}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {tables.map((table, index) => <TableBlock key={index} table={table} />)}
        <PageFooter />
      </Page>
    </Document>
  );
}

// Renders the given document to a Blob and triggers a browser download -
// same "create object URL, click a throwaway anchor, revoke it" pattern
// excel-export.ts's downloadExcelWorkbook already uses for the Excel
// export, just with a PDF blob instead of an XML one. Exported alongside
// the ReportPdfDocument component above (same trade-off toast.tsx's
// useToast()/notifications.tsx's useNotifications() already make) rather
// than split into a separate file purely to satisfy react-refresh - this
// module's document component and its one download helper are meant to be
// read and used together.
// eslint-disable-next-line react-refresh/only-export-components
export async function downloadPdfDocument(document: ReactElement, filename: string): Promise<void> {
  // Global UI Audio Feedback System: every "Download/Print PDF" button in
  // the app funnels through this one function - fired immediately, before
  // the (synchronous but non-zero-cost) PDF render below, so it reads as
  // an instant response to the click rather than a delayed afterthought.
  playPrintSound();
  // Callers pass a <ReportPdfDocument> element (or any other component
  // that itself renders down to a <Document>), not a <Document> element
  // directly - react-pdf's own `pdf()` typing wants the latter, but at
  // runtime it just needs anything React can render into that tree, so
  // this cast is safe.
  const blob = await pdf(document as Parameters<typeof pdf>[0]).toBlob();
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Task 5 (Export & WhatsApp Supplier Communication): the same rendered PDF
// as downloadPdfDocument above, but as base64 bytes instead of a browser
// download - what pos-api.ts's sendWhatsappDocument actually needs (see its
// own comment on why it's real bytes, not a filesystem path). FileReader's
// data: URL is "data:application/pdf;base64,<the actual base64>" - split on
// the first comma to hand callers just the part after it.
// eslint-disable-next-line react-refresh/only-export-components
export async function pdfDocumentToBase64(document: ReactElement): Promise<string> {
  const blob = await pdf(document as Parameters<typeof pdf>[0]).toBlob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read PDF blob'));
    reader.readAsDataURL(blob);
  });
}
