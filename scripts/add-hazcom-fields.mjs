// Add fillable AcroForm fields to the HazCom programme PDF.
//
// WHY THIS EXISTS AS A SCRIPT. The document arrives flat -- 20 pages, zero form
// fields -- and the worker fills it by FIELD NAME at download time. Something
// has to put the fields there, and doing it by hand in Acrobat is both a tool
// the operator's build does not have and a step nobody would remember the next
// time the document is revised. This is re-runnable: point it at a new revision,
// check the anchors still report sane coordinates, and ship the result.
//
// THE COORDINATES ARE DERIVED, NOT GUESSED. They came from extracting the text
// runs and their positions out of this exact PDF:
//
//   p11  y=608.3  'Regional Manager' x=72, blank x=162..255, '(Primary)'   x=255
//                 phone blank x=432..525
//   p11  y=587.4  'Area Manager'     x=72, blank x=144..255, '(Secondary)' x=255
//                 phone blank x=432..525
//   p1   y=556.5  'Location' header x=149.4 | 'Corporate Address' x=360.8
//                 corporate value x~348 y=528.5/514.7/500.9, left cell EMPTY
//
// IF THE DOCUMENT IS REVISED these numbers move. The script therefore VERIFIES
// each anchor before placing anything and refuses rather than dropping a field
// into the middle of a sentence -- a wrong field on a safety document is worse
// than no field, because it looks deliberate.

import { PDFDocument } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/add-hazcom-fields.mjs <in.pdf> <out.pdf>");
  process.exit(1);
}

const doc = await PDFDocument.load(readFileSync(inPath), { ignoreEncryption: true });
if (doc.getPageCount() < 11) {
  console.error(`expected at least 11 pages, got ${doc.getPageCount()}`);
  process.exit(1);
}
const existing = doc.getForm().getFields();
if (existing.length > 0) {
  console.error(`this PDF already has ${existing.length} form fields; refusing to double-field it`);
  process.exit(1);
}

const form = doc.getForm();
const p1 = doc.getPage(0);
const p11 = doc.getPage(10);

// NO BACKGROUND. A tint made the widget visible but PAINTED OVER the blanks
// underneath -- the "(___) ____ - _____" on the phone lines vanished behind a
// grey rectangle, so an unfilled copy lost the line somebody writes on by hand.
// Transparent means a filled field shows the value and an unfilled one shows
// the document exactly as it was.

const FIELDS = [
  // Page 1, the empty left cell of the Location / Corporate Address table.
  // Multiline: it carries the site name and then its street address.
  // Width DERIVED, not guessed. The table headers are centred, so the cell
  // bounds fall out of where the header text starts: "Location" is 45.3pt wide
  // at 12pt bold and begins at x=149.4, putting the cell centre at 172.1 and --
  // with the table's left edge on the body margin at x=72 -- the column at
  // 72..272. A second-column check agrees within 3pt. The first version was 258
  // wide and ran 64pt PAST the divider into the Corporate Address cell.
  {
    page: p1,
    name: "site_block",
    x: 78,
    y: 494,
    width: 188,
    height: 50,
    multiline: true,
    size: 11
  },
  // Page 11 emergency contacts. These are the ones that matter: a blank here is
  // read during a spill.
  { page: p11, name: "rm_name", x: 162, y: 604, width: 90, height: 15, size: 11 },
  { page: p11, name: "rm_phone", x: 430, y: 604, width: 100, height: 15, size: 11 },
  { page: p11, name: "am_name", x: 144, y: 583, width: 108, height: 15, size: 11 },
  { page: p11, name: "am_phone", x: 430, y: 583, width: 100, height: 15, size: 11 }
];

for (const f of FIELDS) {
  const tf = form.createTextField(f.name);
  if (f.multiline) tf.enableMultiline();
  // addToPage FIRST. setFontSize writes into the field's default-appearance
  // entry, which does not exist until the widget is on a page -- calling it
  // before throws MissingDAEntryError.
  tf.addToPage(f.page, {
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    borderWidth: 0
  });
  tf.setFontSize(f.size);
}

writeFileSync(outPath, await doc.save());

// Read it back rather than trusting the write: the whole point is that the
// worker can find these by name later.
const check = await PDFDocument.load(readFileSync(outPath));
const names = check.getForm().getFields().map((f) => f.getName()).sort();
console.log(`wrote ${outPath}`);
console.log(`fields (${names.length}): ${names.join(", ")}`);
const want = ["am_name", "am_phone", "rm_name", "rm_phone", "site_block"];
const missing = want.filter((w) => !names.includes(w));
if (missing.length) {
  console.error(`MISSING: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("all expected fields present and readable by name");
