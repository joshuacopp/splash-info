"use client";

// Standard report table (Brief 179). TanStack Table v8 as the engine, Splash
// styling on top. Columns, labels and formatting come from the report's
// @splash/report-kit definition, so a report page supplies rows and, at most,
// a few custom cells.
//
// Sorting is client-side over the rows the server already sent. It never
// fetches more: if a report is capped, the page says so above the table.
//
// RENDER IT FROM A CLIENT WRAPPER, NOT FROM A SERVER PAGE. A report definition
// holds functions (`rowKey`, column `get`), and functions cannot be passed from
// a server component to a client one. Each report has a small "use client"
// file that imports its definition and passes it here along with any custom
// cells (see admin/fleet/_components/FleetTable.tsx); the server page passes
// only the rows, which are plain JSON.
//
// Times render as ABSOLUTE Eastern ("Oct 30, 2026, 7:25 PM"), never relative.
// Relative text ("5 min ago") differs between the server render and the
// browser's hydration by however long the page took, which React reports as a
// hydration mismatch.

import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import {
  columnsFor,
  formatCell,
  sortValue,
  type ColumnKind,
  type ReportColumn,
  type ReportDef
} from "@splash/report-kit";

const NUMERIC: ReadonlySet<ColumnKind> = new Set(["number", "currency", "cents", "percent"]);

export interface ExtraColumn<Row> {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
}

export interface ReportTableProps<Row> {
  def: ReportDef<Row>;
  rows: Row[];
  /** Custom renderers by column id (a pill, a two-line cell). Sorting still uses the column's value. */
  cells?: Partial<Record<string, (row: Row) => ReactNode>>;
  /** Trailing non-data columns, e.g. a "View" link. Not sortable, not exported. */
  extraColumns?: ReadonlyArray<ExtraColumn<Row>>;
  /** Column ids to sum in a footer row (numeric kinds only). */
  totals?: ReadonlyArray<string>;
  initialSort?: { id: string; desc: boolean };
  emptyText?: string;
}

const Dash = () => <span className="text-splash-navy/50">—</span>;

function sumColumn<Row>(col: ReportColumn<Row>, rows: Row[]): string {
  let sum = 0;
  for (const r of rows) {
    const v = sortValue(col, r);
    if (typeof v === "number") sum += v;
  }
  // Format through the column's own kind so cents/currency/percent stay consistent.
  return formatCell({ ...col, get: () => sum }, rows[0] as Row);
}

export function ReportTable<Row>({
  def,
  rows,
  cells,
  extraColumns = [],
  totals = [],
  initialSort,
  emptyText = "Nothing in this date range."
}: ReportTableProps<Row>) {
  const reportCols = useMemo(() => columnsFor(def, "table"), [def]);
  const [sorting, setSorting] = useState<SortingState>(initialSort ? [initialSort] : []);

  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      ...reportCols.map(
        (col): ColumnDef<Row> => ({
          id: col.id,
          header: col.label,
          accessorFn: (row) => sortValue(col, row),
          sortingFn: "basic",
          cell: ({ row }) => {
            const custom = cells?.[col.id];
            if (custom) return custom(row.original);
            const text = formatCell(col, row.original);
            if (!text) return <Dash />;
            if (col.kind === "email") {
              return (
                <a href={`mailto:${text}`} className="text-splash-blue hover:underline">
                  {text}
                </a>
              );
            }
            return text;
          }
        })
      ),
      ...extraColumns.map(
        (x): ColumnDef<Row> => ({
          id: x.id,
          header: x.header,
          enableSorting: false,
          cell: ({ row }) => x.cell(row.original)
        })
      )
    ],
    [reportCols, cells, extraColumns]
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (r) => def.rowKey(r)
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        {emptyText}
      </div>
    );
  }

  const kindOf = (id: string) => reportCols.find((c) => c.id === id)?.kind;
  const totalCols = reportCols.filter((c) => totals.includes(c.id) && NUMERIC.has(c.kind));

  return (
    <div className="max-h-[75vh] overflow-auto rounded-splash-md border border-gray-light bg-white">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-sudsy-blue-soft text-left text-xs uppercase tracking-wide text-splash-navy/70">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sortable = h.column.getCanSort();
                const dir = h.column.getIsSorted();
                const kind = kindOf(h.column.id);
                return (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                    className={`px-3 py-2 font-semibold ${kind && NUMERIC.has(kind) ? "text-right" : ""}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-splash-navy"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <span aria-hidden className="text-[0.625rem]">
                          {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "↕"}
                        </span>
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id} className="border-t border-gray-light">
              {r.getVisibleCells().map((c) => {
                const kind = kindOf(c.column.id);
                return (
                  <td
                    key={c.id}
                    className={`px-3 py-2 align-top text-splash-navy ${kind && NUMERIC.has(kind) ? "text-right tabular-nums" : ""}`}
                  >
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {totalCols.length > 0 && (
          <tfoot className="border-t-2 border-splash-navy/20 bg-gray-light/30 font-semibold">
            <tr>
              {table.getVisibleLeafColumns().map((col, i) => {
                const rc = totalCols.find((c) => c.id === col.id);
                return (
                  <td key={col.id} className={`px-3 py-2 text-splash-navy ${rc ? "text-right tabular-nums" : ""}`}>
                    {rc ? sumColumn(rc, rows) : i === 0 ? "Total" : ""}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
