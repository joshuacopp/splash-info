"use client";

// The request builder. Parts are typed or PASTED: copy cells out of Excel and
// paste into any cell of the table (fills across and down, adding rows), or
// paste a whole sheet -- header row included -- into the "Paste from Excel"
// box, which maps columns by their headings. Competitor evidence is a link
// per part and/or attached quotes (PDF, photo, or a screenshot pasted
// straight in). The draft survives a reload; attachments do not.
//
// Prices are PER UNIT. Quantities live only in the optional Order section:
// sites x parts, one PO per site, ship-to from the site record.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Line {
  /** Client-only, so order quantities stay with their part when rows move. */
  id: string;
  part: string;
  ncs_part_no: string;
  ncs_price: string;
  ncs_url: string;
  competitor_part_no: string;
  competitor_price: string;
  competitor_url: string;
}
type Field = Exclude<keyof Line, "id">;

export interface SiteOption {
  id: number;
  site_number: number | null;
  site: string | null;
  ship_to: string;
}

/** One site in the order: quantities keyed by line id. */
interface Order {
  location_id: number;
  qty: Record<string, string>;
}

const FIELDS: Array<{ key: Field; label: string; width: string; placeholder?: string }> = [
  { key: "part", label: "Part", width: "min-w-[200px]", placeholder: "X458 Sprocket" },
  { key: "ncs_part_no", label: "NCS Part #", width: "min-w-[110px]" },
  { key: "ncs_price", label: "NCS Price (each)", width: "min-w-[110px]", placeholder: "229.67" },
  { key: "ncs_url", label: "NCS Link", width: "min-w-[220px]", placeholder: "https://estore.ncswash.com/…" },
  { key: "competitor_part_no", label: "Comp. Part #", width: "min-w-[110px]" },
  { key: "competitor_price", label: "Comp. Price (each)", width: "min-w-[110px]", placeholder: "167.13" },
  { key: "competitor_url", label: "Comp. Link", width: "min-w-[220px]", placeholder: "optional" }
];

let seq = 0;
const newId = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

const blank = (): Line => ({
  id: newId(),
  part: "",
  ncs_part_no: "",
  ncs_price: "",
  ncs_url: "",
  competitor_part_no: "",
  competitor_price: "",
  competitor_url: ""
});

/** A stored or pasted row -> a Line with only the known fields and a fresh id. */
function toLine(raw: Partial<Record<string, unknown>>): Line {
  const l = blank();
  for (const f of FIELDS) if (typeof raw[f.key] === "string") l[f.key] = raw[f.key] as string;
  if (typeof raw.id === "string" && raw.id) l.id = raw.id;
  return l;
}

const DRAFT_KEY = "price-match.draft.v1";
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 15 * 1024 * 1024;
const MAX_FILES = 10;
const input = "w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm";
const label = "mb-1 block text-sm font-semibold text-splash-navy";

function priceNumber(s: string): number | null {
  const t = s.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function diff(l: Line): number | null {
  const a = priceNumber(l.ncs_price);
  const b = priceNumber(l.competitor_price);
  return a == null || b == null ? null : Math.round((a - b) * 100) / 100;
}
const isBlank = (l: Line) => FIELDS.every((f) => l[f.key].trim() === "");

/** Same rule as the worker's parseQty: blank/0 = none, else a number. */
function qtyValue(s: string | undefined): number | null {
  const t = (s ?? "").trim();
  if (t === "") return 0;
  return /^\d{1,6}(\.\d{1,2})?$/.test(t) ? Number(t) : null;
}

function siteLabel(s: Pick<SiteOption, "site_number" | "site">): string {
  const n = s.site_number != null ? String(s.site_number).padStart(3, "0") : "";
  return [n, s.site].filter(Boolean).join(" · ") || "Site";
}

/** Excel copies cells as TSV; a cell with a line break comes quoted. */
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

/** Map a heading to a field. "competitor" alone = the competitor's NAME. */
function headerField(h: string): Field | "competitor" | null {
  const s = h.toLowerCase();
  const link = /link|url|web/.test(s);
  const num = /#|number|\bno\b|sku|item/.test(s);
  const price = /price|cost|\$|discount/.test(s);
  if (/comp|vendor/.test(s)) {
    if (link) return "competitor_url";
    if (price) return "competitor_price";
    if (num) return "competitor_part_no";
    return "competitor";
  }
  if (/ncs|macneil|mac neil/.test(s)) {
    if (link) return "ncs_url";
    if (num && !price) return "ncs_part_no";
    return "ncs_price";
  }
  // Quantities are not part of a price match (they go in the Order section).
  if (/qty|quantity/.test(s)) return null;
  if (/part|desc|item|name/.test(s)) return "part";
  return null;
}

function rowsToLines(rows: string[][]): { lines: Line[]; competitor: string | null; mapped: boolean } {
  if (rows.length === 0) return { lines: [], competitor: null, mapped: false };
  const head = rows[0]!.map(headerField);
  const mapped = head.filter(Boolean).length >= 2;
  const cols: Array<Field | "competitor" | null> = mapped ? head : FIELDS.map((f) => f.key);
  let competitor: string | null = null;
  const lines = (mapped ? rows.slice(1) : rows).map((r) => {
    const l = blank();
    r.forEach((v, i) => {
      const f = cols[i];
      if (!f) return;
      if (f === "competitor") competitor = competitor ?? (v || null);
      else l[f] = v;
    });
    return l;
  });
  return { lines: lines.filter((l) => !isBlank(l)), competitor, mapped };
}

async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

interface Preview {
  subject: string;
  html: string;
  to: string;
  cc: string[];
  test: boolean;
}

export default function PriceMatchForm(props: {
  live: boolean;
  to: string;
  cc: string[];
  liveRecipients: string[];
  senderEmail: string;
  competitors: string[];
  sites: SiteOption[];
  /** Default PO initials, e.g. "Jc". */
  initials: string;
  /** Today in Eastern time as YYYYMMDD, for the PO preview. */
  today: string;
}) {
  const router = useRouter();
  const [competitor, setCompetitor] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [blank()]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [initials, setInitials] = useState(props.initials);
  const [addSite, setAddSite] = useState("");
  const [siteCursor, setSiteCursor] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [paste, setPaste] = useState("");
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // ---- draft
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      const d = raw
        ? (JSON.parse(raw) as { competitor?: string; note?: string; lines?: Array<Record<string, unknown>>; orders?: Order[]; initials?: string })
        : null;
      if (d) {
        setCompetitor(d.competitor ?? "");
        setNote(d.note ?? "");
        // Older drafts carried a per-line qty; toLine drops it.
        if (Array.isArray(d.lines) && d.lines.length) setLines(d.lines.map(toLine));
        if (Array.isArray(d.orders)) {
          const known = new Set(props.sites.map((s) => s.id));
          setOrders(d.orders.filter((o) => o && known.has(o.location_id)).map((o) => ({ location_id: o.location_id, qty: o.qty ?? {} })));
        }
        if (d.initials) setInitials(d.initials);
      }
    } catch {
      // storage blocked: start empty
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      const empty = !competitor && !note && lines.every(isBlank) && orders.length === 0;
      if (empty) window.localStorage.removeItem(DRAFT_KEY);
      else window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ competitor, note, lines, orders, initials }));
    } catch {
      // ignore
    }
  }, [loaded, competitor, note, lines, orders, initials]);

  // ---- lines
  const setCell = (row: number, key: Field, value: string) =>
    setLines((ls) => ls.map((l, i) => (i === row ? { ...l, [key]: value } : l)));

  /** Multi-cell paste into a table cell: fill right and down from there. */
  const onCellPaste = (row: number, col: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.replace(/\n$/, ""))) return;
    e.preventDefault();
    const rows = parseTsv(text);
    setLines((ls) => {
      const next = ls.map((l) => ({ ...l }));
      rows.forEach((r, ri) => {
        const target = row + ri;
        while (next.length <= target) next.push(blank());
        r.forEach((v, ci) => {
          const f = FIELDS[col + ci];
          if (f) next[target]![f.key] = v;
        });
      });
      return next;
    });
  };

  const addFromPasteBox = () => {
    const { lines: parsed, competitor: comp, mapped } = rowsToLines(parseTsv(paste));
    if (parsed.length === 0) {
      setPasteMsg("Nothing to add -- copy the rows out of Excel and paste them here.");
      return;
    }
    setLines((ls) => [...ls.filter((l) => !isBlank(l)), ...parsed]);
    if (comp && !competitor) setCompetitor(comp);
    setPaste("");
    setPasteMsg(
      `Added ${parsed.length} part${parsed.length === 1 ? "" : "s"}${
        mapped ? " (columns matched by heading)" : " (no heading row, so columns were read in the table's order)"
      }. Check them below.`
    );
  };

  const filled = lines.filter((l) => !isBlank(l));

  // ---- orders
  const siteById = useMemo(() => new Map(props.sites.map((s) => [s.id, s])), [props.sites]);
  const setQty = (locationId: number, lineId: string, value: string) =>
    setOrders((os) => os.map((o) => (o.location_id === locationId ? { ...o, qty: { ...o.qty, [lineId]: value } } : o)));

  /** Multi-cell paste into the order grid: rows = parts, columns = sites. */
  const onQtyPaste = (row: number, col: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!/[\t\n]/.test(text.replace(/\n$/, ""))) return;
    e.preventDefault();
    const rows = parseTsv(text);
    setOrders((os) => {
      const next = os.map((o) => ({ ...o, qty: { ...o.qty } }));
      rows.forEach((r, ri) => {
        const l = filled[row + ri];
        if (!l) return;
        r.forEach((v, ci) => {
          const o = next[col + ci];
          if (o) o.qty[l.id] = v;
        });
      });
      return next;
    });
  };

  const orderProblems = useMemo(() => {
    const out: string[] = [];
    for (const o of orders) {
      const s = siteById.get(o.location_id);
      const name = s ? siteLabel(s) : "A site";
      const qs = filled.map((l) => qtyValue(o.qty[l.id]));
      if (qs.some((q) => q === null)) out.push(`${name}: quantities must be numbers.`);
      else if (!qs.some((q) => (q ?? 0) > 0)) out.push(`${name}: enter at least one quantity, or remove the site.`);
    }
    return out;
  }, [orders, filled, siteById]);

  const savings = useMemo(() => {
    let t = 0;
    let any = false;
    for (const o of orders)
      for (const l of filled) {
        const q = qtyValue(o.qty[l.id]) ?? 0;
        if (!q) continue;
        const d = diff(l);
        if (d == null) return null;
        t += d * q;
        any = true;
      }
    return any ? Math.round(t * 100) / 100 : null;
  }, [orders, filled]);

  const cleanInitials = initials.replace(/[^A-Za-z]/g, "").slice(0, 4);
  const poPreview = (s: SiteOption) =>
    `${s.site_number != null ? String(s.site_number).padStart(3, "0") : "000"}-${props.today}-${cleanInitials || props.initials}`;
  const availableSites = props.sites.filter((s) => !orders.some((o) => o.location_id === s.id));

  /**
   * Type-ahead: digits match the site number ("122", "12", "9" -> 009),
   * anything else matches inside the site name ("bin" -> Binghamton).
   * An exact site number sorts first, so "122" + Enter adds Binghamton.
   */
  const siteMatches = useMemo(() => {
    const q = addSite.trim().toLowerCase();
    if (!q) return [];
    if (/^\d+$/.test(q)) {
      const n = Number(q);
      return availableSites
        .filter((s) => s.site_number != null && (String(s.site_number).startsWith(String(n)) || String(s.site_number).padStart(3, "0").startsWith(q)))
        .sort((a, b) => Number(b.site_number === n) - Number(a.site_number === n) || (a.site_number ?? 0) - (b.site_number ?? 0))
        .slice(0, 12);
    }
    return availableSites.filter((s) => (s.site ?? "").toLowerCase().includes(q)).slice(0, 12);
  }, [addSite, availableSites]);

  const pickSite = (id: number) => {
    setOrders((os) => (os.some((o) => o.location_id === id) ? os : [...os, { location_id: id, qty: {} }]));
    setAddSite("");
    setSiteCursor(0);
  };

  // ---- files
  const addFiles = useCallback(async (incoming: File[]) => {
    setError(null);
    const shrunk = await Promise.all(incoming.map(shrinkImage));
    setFiles((cur) => {
      const next = [...cur];
      for (const f of shrunk) {
        if (next.length >= MAX_FILES) {
          setError(`At most ${MAX_FILES} attachments.`);
          break;
        }
        if (f.size > MAX_FILE) {
          setError(`${f.name} is over 5 MB.`);
          continue;
        }
        next.push(f);
      }
      return next;
    });
  }, []);

  const onZonePaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
      .map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${Date.now()}-${i + 1}.png`, { type: f.type })));
    if (imgs.length) {
      e.preventDefault();
      void addFiles(imgs);
    }
  };

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  // ---- submit
  const payload = () => ({
    competitor,
    note,
    initials: cleanInitials,
    lines: filled.map(({ id: _id, ...rest }) => rest),
    // qty[i] belongs to lines[i] as sent.
    orders: orders.map((o) => ({ location_id: o.location_id, qty: filled.map((l) => o.qty[l.id] ?? "") }))
  });

  const doPreview = async () => {
    setError(null);
    setBusy("preview");
    try {
      const res = await fetch("/admin/price-match/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload(), file_names: files.map((f) => f.name) })
      });
      const data = (await res.json().catch(() => null)) as (Preview & { error?: string }) | null;
      if (!res.ok || !data) setError(data?.error ?? `Preview failed (${res.status}).`);
      else setPreview(data);
    } catch {
      setError("Network error -- try again.");
    } finally {
      setBusy(null);
    }
  };

  const doSend = async () => {
    setError(null);
    if (totalBytes > MAX_TOTAL) {
      setError("Attachments are over 15 MB in total.");
      return;
    }
    setBusy("send");
    try {
      const fd = new FormData();
      fd.append("data", JSON.stringify(payload()));
      for (const f of files) fd.append("files", f, f.name);
      const res = await fetch("/admin/price-match/api/send", { method: "POST", body: fd });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; to?: string; cc?: string[]; test?: boolean; ref_no?: number | null; po_numbers?: string[] }
        | null;
      if (!res.ok || !data || data.error) {
        setError(data?.error ?? `Send failed (${res.status}).`);
        return;
      }
      setPreview(null);
      const pos = data.po_numbers ?? [];
      setSent(
        `${data.test ? "Test request" : "Request"}${data.ref_no ? ` #${data.ref_no}` : ""} queued to ${data.to}${
          data.cc?.length ? `, CC ${data.cc.join(", ")}` : ""
        }${pos.length ? ` with PO${pos.length === 1 ? "" : "s"} ${pos.join(", ")}${data.test ? " (test - not reserved)" : ""}` : ""}. It goes out within about 5 minutes.`
      );
      setCompetitor("");
      setNote("");
      setLines([blank()]);
      setOrders([]);
      setFiles([]);
      router.refresh();
    } catch {
      setError("Network error -- nothing was sent. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const ready = competitor.trim() !== "" && filled.length > 0 && orderProblems.length === 0;

  return (
    <div className="space-y-5">
      <div
        className={`rounded-splash-md border px-4 py-3 text-sm ${
          props.live ? "border-sudsy-blue/40 bg-sudsy-blue/5 text-splash-navy" : "border-amber-300 bg-amber-50 text-amber-900"
        }`}
      >
        {props.live ? (
          <>
            Sends to <strong>{props.to}</strong>
            {props.cc.length > 0 && <>, CC {props.cc.join(", ")}</>}. Replies come to you ({props.senderEmail}).
          </>
        ) : (
          <>
            <strong>Test mode:</strong> requests go only to <strong>{props.to}</strong>, marked [TEST]. Live they go to{" "}
            {props.liveRecipients.length ? props.liveRecipients.join(" and ") : "(no NCS addresses set)"}, CC you.
          </>
        )}
      </div>

      {sent && (
        <p role="status" className="rounded-splash-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {sent}
        </p>
      )}

      <div className="grid gap-4 rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-5 shadow-splash-card md:grid-cols-2">
        <div>
          <label className={label} htmlFor="pm-competitor">
            Competitor
          </label>
          <input
            id="pm-competitor"
            className={input}
            list="pm-competitors"
            value={competitor}
            maxLength={120}
            placeholder="Triumph Car Wash Parts"
            onChange={(e) => setCompetitor(e.target.value)}
          />
          <datalist id="pm-competitors">
            {props.competitors.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div>
          <label className={label} htmlFor="pm-note">
            Note to NCS <span className="font-normal text-splash-navy/50">(optional)</span>
          </label>
          <textarea
            id="pm-note"
            className={input}
            rows={2}
            maxLength={2000}
            value={note}
            placeholder="e.g. Quote is valid through Dec 15."
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      <div className="rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-5 shadow-splash-card">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-splash-navy">
            Parts <span className="text-sm font-normal text-splash-navy/60">— prices per unit</span>
          </h2>
          <p className="text-xs text-splash-navy/60">
            Paste cells from Excel into any box to fill across and down. Prices can be text, e.g. &ldquo;9.25/foot&rdquo;.
            Quantities go in the Order section below.
          </p>
        </div>

        <details className="mb-4 rounded-splash-sm border border-gray-light bg-gray-light/20 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-splash-navy">Paste from Excel</summary>
          <p className="mt-2 text-xs text-splash-navy/70">
            Copy the rows <em>including the heading row</em> and paste here. Headings like Part, NCS / MacNeil Price,
            MacNeil Link, Competitor, Competitor Price, Competitor Link are recognised (a Qty column is ignored). Without
            headings, columns are read in the table&apos;s order.
          </p>
          <textarea
            className={`${input} mt-2 font-mono text-xs`}
            rows={5}
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              setPasteMsg(null);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={addFromPasteBox}
              className="rounded-splash-sm bg-splash-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-splash-navy"
            >
              Add rows
            </button>
            {pasteMsg && <span className="text-xs text-splash-navy/70">{pasteMsg}</span>}
          </div>
        </details>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-splash-navy/60">
              <tr>
                {FIELDS.map((f) => (
                  <th key={f.key} className={`px-1 py-1 ${f.width}`}>
                    {f.label}
                    {(f.key === "part" || f.key === "ncs_price" || f.key === "ncs_url" || f.key === "competitor_price") && (
                      <span className="text-racecar-red"> *</span>
                    )}
                  </th>
                ))}
                <th className="px-1 py-1 text-right">Diff.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, ri) => {
                const d = diff(l);
                return (
                  <tr key={l.id} className="align-top">
                    {FIELDS.map((f, ci) => (
                      <td key={f.key} className={`px-1 py-1 ${f.width}`}>
                        <input
                          className={input}
                          value={l[f.key]}
                          placeholder={ri === 0 ? f.placeholder : undefined}
                          aria-label={`${f.label}, row ${ri + 1}`}
                          onChange={(e) => setCell(ri, f.key, e.target.value)}
                          onPaste={onCellPaste(ri, ci)}
                        />
                      </td>
                    ))}
                    <td
                      className={`whitespace-nowrap px-1 py-2.5 text-right ${
                        d == null ? "text-splash-navy/40" : d > 0 ? "font-semibold text-emerald-700" : "text-splash-navy/70"
                      }`}
                      title="NCS minus competitor, each"
                    >
                      {d == null ? "–" : money(d)}
                    </td>
                    <td className="px-1 py-1">
                      <button
                        type="button"
                        aria-label={`Remove row ${ri + 1}`}
                        className="rounded px-2 py-1.5 text-splash-navy/50 hover:bg-gray-light hover:text-racecar-red"
                        onClick={() => setLines((ls) => (ls.length === 1 ? [blank()] : ls.filter((_, i) => i !== ri)))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, blank()])}
            className="rounded-splash-sm border border-splash-blue px-3 py-1.5 text-sm font-semibold text-splash-blue hover:bg-splash-blue/5"
          >
            + Add part
          </button>
        </div>
      </div>

      <div
        className="rounded-splash-md border-[1.5px] border-dashed border-splash-navy/25 bg-white p-5 shadow-splash-card"
        onPaste={onZonePaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files));
        }}
        tabIndex={0}
      >
        <h2 className="text-lg font-bold text-splash-navy">Competitor quotes</h2>
        <p className="mb-3 text-sm text-splash-navy/70">
          Drop a PDF or photo here, choose files, or click this box and paste a screenshot (Ctrl+V). Up to 10 files,
          5 MB each. Large photos are shrunk before sending.
        </p>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.xlsx,.xls,.csv,.doc,.docx,.txt,image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="rounded-splash-sm border border-splash-blue px-3 py-1.5 text-sm font-semibold text-splash-blue hover:bg-splash-blue/5"
        >
          Choose files
        </button>
        {files.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-3">
                <span className="text-splash-navy">{f.name}</span>
                <span className="text-xs text-splash-navy/50">{(f.size / 1024 / 1024).toFixed(2)} MB</span>
                <button
                  type="button"
                  className="text-xs text-racecar-red hover:underline"
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-5 shadow-splash-card">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-splash-navy">
            Order <span className="text-sm font-normal text-splash-navy/60">— optional</span>
          </h2>
          <p className="text-xs text-splash-navy/60">
            &ldquo;If you can match, process these.&rdquo; One PO per site, shipped to the site&apos;s address on file.
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="relative min-w-[240px] flex-1">
            <label className={label} htmlFor="pm-add-site">
              Add a site
            </label>
            <input
              id="pm-add-site"
              className={input}
              value={addSite}
              autoComplete="off"
              role="combobox"
              aria-expanded={siteMatches.length > 0}
              aria-controls="pm-site-matches"
              placeholder="Site number or name, e.g. 122 or bin"
              onChange={(e) => {
                setAddSite(e.target.value);
                setSiteCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSiteCursor((c) => Math.min(c + 1, siteMatches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSiteCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const pick = siteMatches[siteCursor] ?? siteMatches[0];
                  if (pick) pickSite(pick.id);
                } else if (e.key === "Escape") {
                  setAddSite("");
                }
              }}
            />
            {siteMatches.length > 0 && (
              <ul
                id="pm-site-matches"
                role="listbox"
                className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-splash-sm border border-gray-light bg-white py-1 text-sm shadow-lg"
              >
                {siteMatches.map((s, i) => (
                  <li
                    key={s.id}
                    role="option"
                    aria-selected={i === siteCursor}
                    className={`cursor-pointer px-3 py-1.5 ${i === siteCursor ? "bg-splash-blue/10" : "hover:bg-gray-light/50"}`}
                    onMouseEnter={() => setSiteCursor(i)}
                    // mousedown, not click: fires before the input loses focus.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSite(s.id);
                    }}
                  >
                    <span className="font-semibold text-splash-navy">{siteLabel(s)}</span>
                    <span className="ml-2 text-xs text-splash-navy/50">{s.ship_to.split("\n").slice(1).join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
            {addSite.trim() !== "" && siteMatches.length === 0 && (
              <p className="mt-1 text-xs text-splash-navy/60">No site matches &ldquo;{addSite.trim()}&rdquo; (or it&apos;s already added).</p>
            )}
          </div>
          <div className="w-[120px]">
            <label className={label} htmlFor="pm-initials">
              PO initials
            </label>
            <input
              id="pm-initials"
              className={input}
              value={initials}
              maxLength={4}
              onChange={(e) => setInitials(e.target.value.replace(/[^A-Za-z]/g, ""))}
            />
          </div>
        </div>

        {orders.length === 0 ? (
          <p className="rounded-splash-sm border border-dashed border-gray-light px-3 py-4 text-center text-sm italic text-splash-navy/60">
            No order — this sends a price-match request only.
          </p>
        ) : filled.length === 0 ? (
          <p className="text-sm italic text-splash-navy/60">Add parts above, then enter quantities here.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="text-left text-sm">
                <thead className="text-xs text-splash-navy/60">
                  <tr className="align-bottom">
                    <th className="px-1 py-1 uppercase tracking-wide">Part</th>
                    {orders.map((o) => {
                      const s = siteById.get(o.location_id);
                      return (
                        <th key={o.location_id} className="min-w-[110px] px-1 py-1" title={s?.ship_to}>
                          <div className="flex items-start justify-between gap-1">
                            <span className="font-semibold text-splash-navy">{s ? siteLabel(s) : o.location_id}</span>
                            <button
                              type="button"
                              aria-label={`Remove ${s ? siteLabel(s) : "site"} from the order`}
                              className="rounded px-1 text-splash-navy/50 hover:bg-gray-light hover:text-racecar-red"
                              onClick={() => setOrders((os) => os.filter((x) => x.location_id !== o.location_id))}
                            >
                              ✕
                            </button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filled.map((l, ri) => (
                    <tr key={l.id}>
                      <td className="max-w-[280px] px-1 py-1 text-splash-navy">
                        {l.part || <span className="italic text-splash-navy/50">(unnamed part)</span>}
                        {l.ncs_part_no && <span className="ml-1 text-xs text-splash-navy/50">#{l.ncs_part_no}</span>}
                      </td>
                      {orders.map((o, ci) => {
                        const bad = qtyValue(o.qty[l.id]) === null;
                        return (
                          <td key={o.location_id} className="px-1 py-1">
                            <input
                              className={`${input} text-right ${bad ? "border-racecar-red" : ""}`}
                              inputMode="decimal"
                              placeholder="0"
                              value={o.qty[l.id] ?? ""}
                              aria-label={`Quantity of ${l.part || `part ${ri + 1}`} for ${siteLabel(siteById.get(o.location_id) ?? { site: null, site_number: null })}`}
                              onChange={(e) => setQty(o.location_id, l.id, e.target.value)}
                              onPaste={onQtyPaste(ri, ci)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="mt-4 space-y-2 text-sm">
              {orders.map((o) => {
                const s = siteById.get(o.location_id);
                if (!s) return null;
                return (
                  <li key={o.location_id} className="flex flex-wrap gap-x-4 gap-y-1">
                    <span className="font-semibold text-splash-navy">PO {poPreview(s)}</span>
                    <span className="text-splash-navy/70">{s.ship_to.replace(/\n/g, ", ")}</span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-splash-navy/60">
              PO numbers are final when sent — if one is already used today, it becomes …2, …3 (shared with Kleen-Rite
              orders). Paste a block of quantities from Excel to fill across sites and down parts.
            </p>
            {savings != null && savings > 0 && (
              <p className="mt-2 text-sm text-splash-navy">
                At the matched prices this order saves <strong>{money(savings)}</strong>.
              </p>
            )}
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-sm text-racecar-red">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!ready || busy !== null}
          onClick={doPreview}
          className="rounded-splash-sm border border-splash-blue px-4 py-2 text-sm font-semibold text-splash-blue hover:bg-splash-blue/5 disabled:opacity-50"
        >
          {busy === "preview" ? "Building preview…" : "Preview email"}
        </button>
        <button
          type="button"
          disabled={!ready || busy !== null}
          onClick={doSend}
          className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:opacity-50"
        >
          {busy === "send" ? "Sending…" : props.live ? "Send to NCS" : "Send test to me"}
        </button>
        {!ready && (
          <span className="text-xs text-splash-navy/60">
            {competitor.trim() === "" || filled.length === 0 ? "Name the competitor and add at least one part." : orderProblems[0]}
          </span>
        )}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPreview(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Email preview"
            className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-splash-md bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-gray-light px-5 py-3 text-sm text-splash-navy">
              <div>
                <strong>To:</strong> {preview.to}
                {preview.cc.length > 0 && (
                  <>
                    {" "}
                    · <strong>CC:</strong> {preview.cc.join(", ")}
                  </>
                )}
              </div>
              <div>
                <strong>Subject:</strong> {preview.subject}
              </div>
            </div>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="min-h-[420px] w-full flex-1" />
            <div className="flex justify-end gap-3 border-t border-gray-light px-5 py-3">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-splash-sm border border-gray-light px-4 py-2 text-sm font-semibold text-splash-navy"
              >
                Keep editing
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={doSend}
                className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:opacity-50"
              >
                {busy === "send" ? "Sending…" : props.live ? "Send to NCS" : "Send test to me"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
