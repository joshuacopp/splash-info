// Public Vehicle Guide page — GET /claims/vehicles/{token}.
//
// Read by site staff on a phone or an Android tablet at the tunnel entrance, often one-handed with
// a car waiting. So: one self-contained HTML response (no framework, no
// second request for data), big tap targets, and a search box first because
// typing "prius" beats four taps when you already know the car.
//
// Browse order is the one operators asked for: make -> model -> year -> info.
// Navigation lives in the URL hash (#/toyota/camry/2019) so the phone's back
// button steps back one level instead of leaving the page.
//
// Every entry is embedded as JSON and filtered in the browser. Fine for the
// hundreds of entries this will plausibly ever hold; past a few thousand it
// would want a server-side search instead.

import { ASSETS } from "@splash/storage-r2";
import { type VehicleIssue, vehicleIssueTypeLabel } from "@splash/types/vehicle-guide";

export interface VehicleGuidePageInput {
  issues: VehicleIssue[];
  /** /claims/vehicles/{token} — media URLs hang off it. */
  basePath: string;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

export function renderVehicleGuidePage(input: VehicleGuidePageInput): string {
  const data = {
    base: input.basePath,
    // Last year an open-ended ("2019+") entry lists. Next year, not this one:
    // dealers sell next model year's cars from late summer.
    year: new Date().getUTCFullYear() + 1,
    issues: input.issues.map((i) => ({
      id: i.id,
      make: i.make,
      model: i.model,
      yf: i.year_from,
      yt: i.year_to,
      type: i.issue_type,
      typeLabel: vehicleIssueTypeLabel(i.issue_type),
      issue: i.issue,
      solution: i.solution,
      media: i.media.map((m) => ({ id: m.id, kind: m.kind }))
    }))
  };
  // `<` escaped so no entry text can close the <script> block early.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>Vehicle Guide · Splash</title>
<link rel="icon" type="image/png" href="${escHtml(ASSETS.favicon)}">
<style>${CSS}</style>
</head>
<body>
<header class="bar">
  <img src="${escHtml(ASSETS.logoWhite)}" alt="Splash Car Wash" class="logo">
  <span class="bar-title">Vehicle Guide</span>
</header>
<main class="wrap">
  <label class="search">
    <span class="sr">Search</span>
    <input id="q" type="search" placeholder="Search make, model, year or problem" autocomplete="off" enterkeyhint="search">
  </label>
  <nav id="crumbs" class="crumbs" aria-label="Breadcrumb"></nav>
  <div id="app" aria-live="polite"></div>
  <p class="foot">For Splash staff only. Please don&rsquo;t share this link.</p>
</main>
<script type="application/json" id="vg-data">${json}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f4f5f9;color:#1c164e;font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.bar{display:flex;align-items:center;gap:12px;padding:12px 16px;padding-top:calc(12px + env(safe-area-inset-top,0px));background:#1c164e;color:#fff;position:sticky;top:0;z-index:5}
.logo{height:32px;width:auto}
.bar-title{font-weight:700;font-size:17px;letter-spacing:.01em}
.wrap{max-width:1040px;margin:0 auto;padding:16px 16px calc(32px + env(safe-area-inset-bottom,0px))}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.search input{width:100%;font-size:17px;padding:14px 16px;border:2px solid #dbdbdb;border-radius:12px;background:#fff;color:inherit}
.search input:focus{outline:none;border-color:#2b3491}
.crumbs{margin:14px 2px 10px;font-size:15px;color:#1c164e99;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.crumbs a{color:#2b3491;font-weight:600;text-decoration:none;padding:4px 0}
.crumbs .sep{color:#1c164e55}
.crumbs .here{font-weight:700;color:#1c164e}
h2.view{font-size:20px;margin:6px 2px 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
.tile,.row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border:1px solid #dbdbdb;border-radius:12px;padding:16px;min-height:56px;color:inherit;text-decoration:none;font-weight:700;font-size:17px}
.tile:active,.row:active{background:#d6f1fb}
.count{flex:none;min-width:28px;text-align:center;font-size:13px;font-weight:700;background:#1c164e10;border-radius:999px;padding:2px 8px;color:#1c164ebb}
.list{display:flex;flex-direction:column;gap:10px}
.row small{display:block;font-weight:500;font-size:14px;color:#1c164e99;margin-top:2px}
.years{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:10px}
.years .tile{justify-content:center}
.alllink{display:inline-block;margin-top:14px;color:#2b3491;font-weight:600}
.card{background:#fff;border:1px solid #dbdbdb;border-radius:14px;padding:16px;margin-bottom:14px}
.card-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
.vehicle{font-weight:800;font-size:18px;width:100%}
.pill{display:inline-block;font-size:13px;font-weight:700;border-radius:999px;padding:3px 10px}
.t-neutral{background:#d6f1fb;color:#0b5c7a}
.t-park{background:#fdf0c4;color:#7a5a00}
.t-safety{background:#fde2e2;color:#a11d1d}
.t-other{background:#ececf2;color:#1c164ecc}
.yrs{font-size:14px;color:#1c164e99;font-weight:600}
.card h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#1c164e99;margin:12px 0 4px}
.txt{margin:0;white-space:pre-wrap;word-wrap:break-word}
.sol{background:#eef9ee;border-left:4px solid #059669;padding:10px 12px;border-radius:6px}
.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:12px}
.media img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block;background:#eee}
.media video{width:100%;border-radius:8px;background:#000;grid-column:1/-1;max-height:70vh}
.empty{background:#fff;border:1px dashed #c5c7d4;border-radius:12px;padding:22px;text-align:center;color:#1c164ebb}
/* Tablets (an Android tablet at the entrance is an expected setup): wider
   tap grids and issue cards two-up so a landscape screen isn't one long strip. */
@media (min-width:860px){
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
  .cards .card{margin-bottom:0}
  .grid{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}
  .list{display:grid;grid-template-columns:1fr 1fr}
}
.foot{margin-top:28px;text-align:center;font-size:13px;color:#1c164e77}
`;

// Plain ES5-ish, no template literals: it lives inside a TS template string.
const CLIENT_JS = `
(function(){
  var DATA = JSON.parse(document.getElementById('vg-data').textContent);
  var ISSUES = DATA.issues, BASE = DATA.base, NOW = DATA.year;
  var app = document.getElementById('app');
  var crumbs = document.getElementById('crumbs');
  var q = document.getElementById('q');

  function k(s){ return String(s).trim().toLowerCase(); }
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function yrLabel(i){
    if (i.yt === null) return i.yf + '+';
    if (i.yt === i.yf) return String(i.yf);
    return i.yf + '\\u2013' + i.yt;
  }
  function covers(i, y){ return y >= i.yf && y <= (i.yt === null ? NOW : i.yt); }
  function href(parts){ return '#/' + parts.map(encodeURIComponent).join('/'); }

  // make key -> { name, count, models: { model key -> { name, issues } } }
  var makes = {};
  ISSUES.forEach(function(i){
    var mk = k(i.make), mo = k(i.model);
    var M = makes[mk] || (makes[mk] = { name: i.make, count: 0, models: {} });
    M.count++;
    var MO = M.models[mo] || (M.models[mo] = { name: i.model, issues: [] });
    MO.issues.push(i);
  });
  function sorted(o){
    return Object.keys(o).sort(function(a, b){ return o[a].name.localeCompare(o[b].name); });
  }

  function setCrumbs(items){
    if (!items.length) { crumbs.innerHTML = ''; return; }
    crumbs.innerHTML = items.map(function(it, n){
      var last = n === items.length - 1;
      var html = last ? '<span class="here">' + esc(it.label) + '</span>'
                      : '<a href="' + it.href + '">' + esc(it.label) + '</a>';
      return (n ? '<span class="sep">\\u203a</span>' : '') + html;
    }).join('');
  }

  function card(i, withVehicle){
    var media = i.media.map(function(m){
      var url = BASE + '/media/' + m.id;
      return m.kind === 'video'
        ? '<video controls playsinline preload="metadata" src="' + url + '"></video>'
        : '<a href="' + url + '" target="_blank" rel="noopener noreferrer"><img loading="lazy" alt="" src="' + url + '"></a>';
    }).join('');
    return '<article class="card"><div class="card-head">' +
      (withVehicle ? '<div class="vehicle">' + esc(i.make) + ' ' + esc(i.model) + '</div>' : '') +
      '<span class="pill t-' + esc(i.type) + '">' + esc(i.typeLabel) + '</span>' +
      '<span class="yrs">' + esc(yrLabel(i)) + '</span></div>' +
      '<h3>The problem</h3><p class="txt">' + esc(i.issue) + '</p>' +
      '<h3>What to do</h3><p class="txt sol">' + esc(i.solution) + '</p>' +
      (media ? '<div class="media">' + media + '</div>' : '') +
      '</article>';
  }

  function viewMakes(){
    setCrumbs([]);
    var keys = sorted(makes);
    if (!keys.length) { app.innerHTML = '<div class="empty">No vehicles have been added yet.</div>'; return; }
    app.innerHTML = '<h2 class="view">Pick a make</h2><div class="grid">' + keys.map(function(mk){
      return '<a class="tile" href="' + href([mk]) + '">' + esc(makes[mk].name) +
        '<span class="count">' + makes[mk].count + '</span></a>';
    }).join('') + '</div>';
  }

  function viewModels(mk){
    var M = makes[mk];
    setCrumbs([{ label: 'All makes', href: '#/' }, { label: M.name }]);
    app.innerHTML = '<h2 class="view">' + esc(M.name) + ' \\u2014 pick a model</h2><div class="list">' +
      sorted(M.models).map(function(mo){
        var is = M.models[mo].issues;
        var lo = Math.min.apply(null, is.map(function(i){ return i.yf; }));
        var open = is.some(function(i){ return i.yt === null; });
        var hi = Math.max.apply(null, is.map(function(i){ return i.yt === null ? i.yf : i.yt; }));
        var span = open ? lo + '+' : (lo === hi ? String(lo) : lo + '\\u2013' + hi);
        return '<a class="row" href="' + href([mk, mo]) + '"><span>' + esc(M.models[mo].name) +
          '<small>' + span + ' \\u00b7 ' + is.length + (is.length === 1 ? ' issue' : ' issues') + '</small></span>' +
          '<span class="count">\\u203a</span></a>';
      }).join('') + '</div>';
  }

  function viewYears(mk, mo){
    var M = makes[mk], MO = M.models[mo];
    setCrumbs([{ label: 'All makes', href: '#/' }, { label: M.name, href: href([mk]) }, { label: MO.name }]);
    var set = {};
    MO.issues.forEach(function(i){
      for (var y = i.yf; y <= (i.yt === null ? NOW : i.yt); y++) set[y] = (set[y] || 0) + 1;
    });
    var years = Object.keys(set).map(Number).sort(function(a, b){ return b - a; });
    app.innerHTML = '<h2 class="view">' + esc(M.name) + ' ' + esc(MO.name) + ' \\u2014 pick a year</h2>' +
      '<div class="years">' + years.map(function(y){
        return '<a class="tile" href="' + href([mk, mo, String(y)]) + '">' + y + '</a>';
      }).join('') + '</div>' +
      '<a class="alllink" href="' + href([mk, mo, 'all']) + '">Not sure of the year? Show all ' +
      MO.issues.length + (MO.issues.length === 1 ? ' issue' : ' issues') + ' \\u203a</a>';
  }

  function viewInfo(mk, mo, yr){
    var M = makes[mk], MO = M.models[mo];
    var all = yr === 'all';
    var y = Number(yr);
    var list = MO.issues.filter(function(i){ return all || covers(i, y); });
    setCrumbs([{ label: 'All makes', href: '#/' }, { label: M.name, href: href([mk]) },
               { label: MO.name, href: href([mk, mo]) }, { label: all ? 'All years' : String(y) }]);
    app.innerHTML = '<h2 class="view">' + (all ? '' : y + ' ') + esc(M.name) + ' ' + esc(MO.name) + '</h2>' +
      (list.length ? '<div class="cards">' + list.map(function(i){ return card(i, false); }).join('') + '</div>'
                   : '<div class="empty">Nothing on file for that year.</div>');
  }

  function viewSearch(query){
    setCrumbs([{ label: 'All makes', href: '#/' }, { label: 'Search' }]);
    var words = k(query).split(/\\s+/).filter(Boolean);
    var hits = ISSUES.filter(function(i){
      var hay = k([i.make, i.model, i.typeLabel, i.issue, i.solution].join(' '));
      return words.every(function(w){
        if (/^\\d{4}$/.test(w)) return covers(i, Number(w));
        return hay.indexOf(w) !== -1;
      });
    });
    app.innerHTML = '<h2 class="view">' + hits.length + (hits.length === 1 ? ' match' : ' matches') + '</h2>' +
      (hits.length ? '<div class="cards">' + hits.map(function(i){ return card(i, true); }).join('') + '</div>'
                   : '<div class="empty">No matches. Try just the make or model.</div>');
  }

  function render(){
    var query = q.value.trim();
    if (query) { viewSearch(query); return; }
    var p = location.hash.replace(/^#\\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    var M = p[0] && makes[p[0]];
    var MO = M && p[1] && M.models[p[1]];
    if (MO && p[2]) viewInfo(p[0], p[1], p[2]);
    else if (MO) viewYears(p[0], p[1]);
    else if (M) viewModels(p[0]);
    else viewMakes();
  }

  q.addEventListener('input', render);
  window.addEventListener('hashchange', function(){ q.value = ''; render(); window.scrollTo(0, 0); });
  render();
})();
`;
