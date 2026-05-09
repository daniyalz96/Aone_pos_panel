import * as XLSX from "xlsx";

export type ParsedExcelProductRow = {
  rowNumber: number;
  categoryName: string | null;
  name: string;
  sku: string;
  barcode: string;
  salePrice: number;
  costPrice: number;
  taxRate: number;
  /** Issues that block committing this row */
  issues: string[];
};

const FIELD_ALIASES: Record<
  "category" | "name" | "sku" | "barcode" | "salePrice" | "costPrice" | "taxRate",
  string[]
> = {
  category: ["category", "category name", "cat", "grp", "group"],
  name: ["product name", "product", "name", "item name", "item", "description"],
  sku: ["sku", "item code", "product code", "code"],
  barcode: ["barcode", "ean", "upc", "bar code"],
  salePrice: ["sale price", "selling price", "price", "sale", "retail", "retail price", "unit price"],
  costPrice: ["cost price", "cost", "purchase price"],
  taxRate: ["tax rate", "tax", "tax %", "vat", "gst"],
};

function normalizeHeader(cell: unknown): string {
  return String(cell ?? "")
    .trim()
    .toLowerCase()
    .replace(/%/g, "")
    .replace(/\s+/g, " ");
}

function findColumnIndex(headers: string[], aliases: string[]): number | undefined {
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    const idx = headers.findIndex((h) => h === alias);
    if (idx >= 0) return idx;
  }
  return undefined;
}

function resolveColumns(headers: string[]): Record<keyof typeof FIELD_ALIASES, number | undefined> {
  const norm = headers.map((h) => normalizeHeader(h));
  const out = {} as Record<keyof typeof FIELD_ALIASES, number | undefined>;
  for (const key of Object.keys(FIELD_ALIASES) as (keyof typeof FIELD_ALIASES)[]) {
    out[key] = findColumnIndex(norm, FIELD_ALIASES[key]);
  }
  return out;
}

function cellString(row: unknown[], col: number | undefined): string {
  if (col === undefined) return "";
  const raw = row[col];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    /** Avoid scientific notation surprises for SKUs stored as numbers in Excel */
    return Number.isInteger(raw) ? String(raw) : String(raw);
  }
  return String(raw).trim();
}

function parseMoney(raw: string): number | undefined {
  const s = raw.replace(/,/g, "").trim();
  if (s === "") return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

function validateSkuBarcode(name: string, sku: string, barcode: string, salePrice: number): string[] {
  const issues: string[] = [];
  if (name.length < 2) issues.push("Product name must be at least 2 characters.");
  if (sku.length < 2) issues.push("SKU must be at least 2 characters.");
  if (barcode.length < 3) issues.push("Barcode must be at least 3 characters.");
  if (!(salePrice > 0)) issues.push("Sale price must be a positive number.");
  return issues;
}

/** Ensures SKU/barcode meet backend constraints when Excel omitted them */
export function ensureProductIdentifiers(rowNumber: number, sku: string, barcode: string): { sku: string; barcode: string } {
  const safeSku =
    sku.length >= 2 ? sku : `IMP-${rowNumber}-${Math.random().toString(36).slice(2, 10)}`.toUpperCase();
  let bc = barcode;
  if (bc.length < 3) {
    bc = safeSku.length >= 3 ? safeSku : `BC-${safeSku}-X`;
  }
  return { sku: safeSku.slice(0, 120), barcode: bc.slice(0, 120) };
}

export function parseProductExcelBuffer(buffer: Buffer): ParsedExcelProductRow[] {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }
  const sheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
  });

  if (!grid.length) return [];

  const headerRow = (grid[0] ?? []).map((c) => String(c ?? ""));
  const cols = resolveColumns(headerRow);
  const out: ParsedExcelProductRow[] = [];

  for (let r = 1; r < grid.length; r += 1) {
    const row = grid[r] as unknown[];
    if (!row || !row.some((c) => String(c ?? "").trim() !== "")) continue;

    const categoryRaw = cellString(row as unknown[], cols.category);
    const categoryName = categoryRaw.trim() === "" ? null : categoryRaw.trim();
    const name = cellString(row as unknown[], cols.name);
    let sku = cellString(row as unknown[], cols.sku);
    let barcode = cellString(row as unknown[], cols.barcode);
    const saleRaw = cellString(row as unknown[], cols.salePrice);
    const costRaw = cellString(row as unknown[], cols.costPrice);
    const taxRaw = cellString(row as unknown[], cols.taxRate);

    const salePrice = parseMoney(saleRaw);
    const costParsed = parseMoney(costRaw);
    const costPrice = costParsed === undefined ? 0 : Math.max(0, costParsed);
    let taxRate = parseMoney(taxRaw);
    if (taxRate === undefined) taxRate = 0;
    taxRate = Math.min(100, Math.max(0, taxRate));

    const excelRowNumber = r + 1;
    const displayName = name.trim() || `(Row ${excelRowNumber})`;

    const resolvedSale = salePrice ?? NaN;
    const identifiers = ensureProductIdentifiers(excelRowNumber, sku, barcode);
    sku = identifiers.sku;
    barcode = identifiers.barcode;

    const issues: string[] = [];
    if (cols.name === undefined && name.trim().length === 0) {
      issues.push('Missing product column — add a header such as "Product name" or "Name".');
    }
    issues.push(...validateSkuBarcode(displayName, sku, barcode, resolvedSale));

    out.push({
      rowNumber: excelRowNumber,
      categoryName,
      name: displayName,
      sku,
      barcode,
      salePrice: Number.isFinite(resolvedSale) ? resolvedSale : 0,
      costPrice,
      taxRate,
      issues,
    });
  }

  return out;
}
