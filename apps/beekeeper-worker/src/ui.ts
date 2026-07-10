// Single-file HTML UI served at schedule.splashcarwashes.info/{location_code}.
//
// Deliberately dependency-free (no framework, no bundler) — one inline <script>
// that talks to the /api/loc/{location_code}/* JSON API. Auth is cookie-based
// (the operator is already signed in via the dashboard SSO); the API returns
// 401/403 and the page surfaces that as a sign-in prompt.
//
// The picker model matches the ET dropdown design: employee + date + four
// time dropdowns (start H:M, end H:M). Titles auto-generate server-side.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

/** Render the shell for a location_code. The code is JSON-embedded so the
 *  inline script can key every API call to it. */
export function renderScheduleUi(locationCode: string): string {
  const codeJson = JSON.stringify(locationCode);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Shift Schedule — ${esc(locationCode)}</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --ink:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --danger:#f87171; --ok:#4ade80; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; }
  .sub { color:var(--muted); font-size:13px; }
  main { padding:20px; max-width:1000px; margin:0 auto; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:18px; }
  label { font-size:12px; color:var(--muted); display:block; margin-bottom:4px; }
  select, input, button { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:#0b1220; color:var(--ink); }
  button { cursor:pointer; border-color:var(--accent); }
  button.primary { background:var(--accent); color:#04283a; border-color:var(--accent); font-weight:600; }
  button.danger { border-color:var(--danger); color:var(--danger); background:transparent; }
  button.ghost { border-color:var(--line); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); font-size:14px; }
  th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .msg { padding:10px 12px; border-radius:8px; margin-bottom:14px; display:none; }
  .msg.err { background:#3f1d1d; color:#fecaca; display:block; }
  .msg.ok { background:#16351f; color:#bbf7d0; display:block; }
  .field { min-width:120px; }
  .muted { color:var(--muted); }
  .actions button { padding:5px 9px; font-size:13px; }
  .overnight { color:var(--accent); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Shift Schedule</h1>
  <span class="sub" id="ctxLabel">Loading ${esc(locationCode)}…</span>
</header>
<main>
  <div class="msg" id="msg"></div>

  <div class="card" id="editor" style="display:none">
    <div class="row">
      <div class="field">
        <label>Employee</label>
        <select id="fUser"></select>
      </div>
      <div class="field">
        <label>Date (start)</label>
        <input type="date" id="fDate" />
      </div>
      <div class="field">
        <label>Start</label>
        <div class="row">
          <select id="fSh"></select><select id="fSm"></select>
        </div>
      </div>
      <div class="field">
        <label>End</label>
        <div class="row">
          <select id="fEh"></select><select id="fEm"></select>
        </div>
      </div>
      <div class="field">
        <label>Title (optional)</label>
        <input type="text" id="fTitle" maxlength="80" placeholder="auto" />
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="btnSave">Add shift</button>
      <button class="ghost" id="btnClear" style="display:none">Cancel edit</button>
      <span class="overnight" id="overnightHint"></span>
    </div>
  </div>

  <div class="card">
    <div class="row" style="justify-content:space-between; margin-bottom:12px">
      <div class="row">
        <div class="field">
          <label>Week of</label>
          <input type="date" id="weekOf" />
        </div>
        <button class="ghost" id="btnReload">Reload</button>
      </div>
      <span class="muted" id="rangeLabel"></span>
    </div>
    <table>
      <thead><tr><th>Employee</th><th>Day</th><th>Start</th><th>End</th><th>Title</th><th></th></tr></thead>
      <tbody id="grid"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
    </table>
  </div>
</main>

<script>
const LOC = ${codeJson};
const API = "/api/loc/" + encodeURIComponent(LOC);
let editingId = null;
let roster = [];

const $ = (id) => document.getElementById(id);
function showMsg(text, kind){ const m=$("msg"); m.textContent=text; m.className="msg "+(kind||"err"); if(!text) m.className="msg"; }

function pad(n){ return String(n).padStart(2,"0"); }
function fmt12(h,m){ const h12=((h+11)%12)+1; const ap=h<12?"AM":"PM"; return m===0?(h12+" "+ap):(h12+":"+pad(m)+" "+ap); }
function isoWeekStart(d){ const dt=new Date(d+"T00:00:00Z"); return dt; }

// Populate the time dropdowns: hours 0-23, minutes 0/15/30/45.
function fillTimeDropdowns(){
  const hours=[...Array(24).keys()];
  const mins=[0,15,30,45];
  for(const sel of [$("fSh"),$("fEh")]){
    sel.innerHTML = hours.map(h=>'<option value="'+h+'">'+fmt12(h,0).replace(" AM","a").replace(" PM","p")+'</option>').join("");
  }
  for(const sel of [$("fSm"),$("fEm")]){
    sel.innerHTML = mins.map(m=>'<option value="'+m+'">:'+pad(m)+'</option>').join("");
  }
  $("fSh").value="9"; $("fSm").value="0"; $("fEh").value="17"; $("fEm").value="0";
}

function updateOvernightHint(){
  const s=+$("fSh").value*60 + +$("fSm").value;
  const e=+$("fEh").value*60 + +$("fEm").value;
  $("overnightHint").textContent = (e<=s) ? "→ overnight (ends next day)" : "";
}

async function api(path, opts){
  const res = await fetch(path, Object.assign({ headers:{ "Content-Type":"application/json" }, credentials:"same-origin" }, opts||{}));
  if(res.status===401){ throw new Error("Not signed in — open the dashboard, sign in, then reload."); }
  if(res.status===403){ throw new Error("You don't have access to this location's schedule."); }
  const data = await res.json().catch(()=>({}));
  if(!res.ok){
    if(data && data.details) throw new Error(data.details.map(d=>d.message).join("; "));
    throw new Error((data && data.error) || ("Error "+res.status));
  }
  return data;
}

function weekRange(weekOf){
  const start = new Date(weekOf+"T00:00:00Z");
  const end = new Date(start); end.setUTCDate(end.getUTCDate()+7);
  return { startIso:start.toISOString().replace(/\\.000Z$/,"Z"), endIso:end.toISOString().replace(/\\.000Z$/,"Z") };
}

async function loadContext(){
  const ctx = await api(API+"/context");
  roster = ctx.roster||[];
  $("ctxLabel").textContent = (ctx.name||LOC) + " · " + (roster.length) + " employees";
  $("fUser").innerHTML = roster.map(r=>'<option value="'+r.id+'">'+r.name+'</option>').join("");
  $("editor").style.display = roster.length ? "block" : "block";
}

async function loadShifts(){
  const weekOf = $("weekOf").value;
  if(!weekOf) return;
  const { startIso, endIso } = weekRange(weekOf);
  $("rangeLabel").textContent = startIso.slice(0,10) + " → " + endIso.slice(0,10);
  $("grid").innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  try {
    const { shifts } = await api(API+"/shifts?start="+encodeURIComponent(startIso)+"&end="+encodeURIComponent(endIso));
    renderGrid(shifts||[]);
  } catch(e){ showMsg(e.message); $("grid").innerHTML='<tr><td colspan="6" class="muted">—</td></tr>'; }
}

function dayLabel(dateStr){
  const d=new Date(dateStr+"T00:00:00Z");
  return d.toLocaleDateString("en-US",{ weekday:"short", month:"short", day:"numeric", timeZone:"UTC" });
}

function renderGrid(shifts){
  if(!shifts.length){ $("grid").innerHTML='<tr><td colspan="6" class="muted">No shifts this week.</td></tr>'; return; }
  shifts.sort((a,b)=> a.startUtc.localeCompare(b.startUtc));
  $("grid").innerHTML = shifts.map(s=>{
    const overnight = s.endDate!==s.startDate ? ' <span class="overnight">+1</span>' : '';
    return '<tr>'
      + '<td>'+s.userName+'</td>'
      + '<td>'+dayLabel(s.startDate)+'</td>'
      + '<td>'+fmt12(s.startHour,s.startMinute)+'</td>'
      + '<td>'+fmt12(s.endHour,s.endMinute)+overnight+'</td>'
      + '<td>'+(s.title||"")+'</td>'
      + '<td class="actions"><button class="ghost" data-edit=\\''+encodeURIComponent(JSON.stringify(s))+'\\'>Edit</button> '
      + '<button class="danger" data-del="'+s.id+'">Delete</button></td>'
      + '</tr>';
  }).join("");
  $("grid").querySelectorAll("[data-edit]").forEach(b=> b.onclick=()=> startEdit(JSON.parse(decodeURIComponent(b.getAttribute("data-edit")))));
  $("grid").querySelectorAll("[data-del]").forEach(b=> b.onclick=()=> delShift(b.getAttribute("data-del")));
}

function startEdit(s){
  editingId = s.id;
  $("fUser").value = s.userId;
  $("fDate").value = s.startDate;
  $("fSh").value = s.startHour; $("fSm").value = roundMin(s.startMinute);
  $("fEh").value = s.endHour;   $("fEm").value = roundMin(s.endMinute);
  $("fTitle").value = s.title||"";
  $("btnSave").textContent = "Save changes";
  $("btnClear").style.display = "inline-block";
  updateOvernightHint();
  window.scrollTo({ top:0, behavior:"smooth" });
}
function roundMin(m){ return [0,15,30,45].includes(m)? m : (m<8?0:m<23?15:m<38?30:m<53?45:0); }

function clearEdit(){
  editingId=null;
  $("btnSave").textContent="Add shift";
  $("btnClear").style.display="none";
  $("fTitle").value="";
}

function currentInput(){
  return {
    userId: $("fUser").value,
    date: $("fDate").value,
    startHour:+$("fSh").value, startMinute:+$("fSm").value,
    endHour:+$("fEh").value, endMinute:+$("fEm").value,
    title: $("fTitle").value.trim() || undefined
  };
}

async function save(){
  showMsg("");
  const input = currentInput();
  if(!input.userId){ showMsg("Pick an employee."); return; }
  if(!input.date){ showMsg("Pick a date."); return; }
  try {
    if(editingId){
      await api(API+"/shifts/"+encodeURIComponent(editingId), { method:"PUT", body:JSON.stringify(input) });
      showMsg("Shift updated.","ok");
    } else {
      await api(API+"/shifts", { method:"POST", body:JSON.stringify(input) });
      showMsg("Shift added.","ok");
    }
    clearEdit();
    await loadShifts();
  } catch(e){ showMsg(e.message); }
}

async function delShift(id){
  if(!confirm("Delete this shift?")) return;
  showMsg("");
  try { await api(API+"/shifts/"+encodeURIComponent(id), { method:"DELETE" }); showMsg("Shift deleted.","ok"); await loadShifts(); }
  catch(e){ showMsg(e.message); }
}

function mondayOf(date){
  const d=new Date(date); const day=(d.getDay()+6)%7; d.setDate(d.getDate()-day);
  return d.toISOString().slice(0,10);
}

async function init(){
  fillTimeDropdowns();
  ["fSh","fSm","fEh","fEm"].forEach(id=> $(id).addEventListener("change", updateOvernightHint));
  const today=new Date();
  $("weekOf").value = mondayOf(today);
  $("fDate").value = today.toISOString().slice(0,10);
  $("btnSave").onclick = save;
  $("btnClear").onclick = clearEdit;
  $("btnReload").onclick = loadShifts;
  $("weekOf").addEventListener("change", loadShifts);
  updateOvernightHint();
  try { await loadContext(); await loadShifts(); }
  catch(e){ showMsg(e.message); }
}
init();
</script>
</body>
</html>`;
}
