// Golden Ticket lookup page HTML. One self-contained response; the plate
// check is a fetch to ./check so the answer appears without a page load.
// Used at the counter on a phone or tablet: big input, big verdict.

// Same public R2 logo the damage PDFs and the email shell use. Hard-coded
// because this JS worker does not depend on @splash/storage-r2.
const LOGO = "https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png";

export function renderLookupPage({ base }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>Golden Ticket check · Splash</title>
<style>${CSS}</style>
</head>
<body>
<header class="bar">
  <img src="${LOGO}" alt="Splash Car Wash" class="logo">
  <span class="bar-title">Golden Ticket check</span>
</header>
<main class="wrap">
  <p class="intro">Before awarding free unlimited washing, check the plate. Each vehicle can win once per promo.</p>
  <form id="f" class="search" autocomplete="off">
    <label for="plate" class="lbl">License plate</label>
    <div class="row">
      <input id="plate" name="plate" type="text" inputmode="text" autocapitalize="characters"
             spellcheck="false" maxlength="12" placeholder="ABC1234" required>
      <button type="submit" id="go">Check</button>
    </div>
  </form>
  <div id="out" aria-live="polite"></div>
  <p class="foot">For Splash staff only. Please don&rsquo;t share this link.</p>
</main>
<script type="application/json" id="cfg">${JSON.stringify({ base }).replace(/</g, "\\u003c")}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#f4f5f9;color:#1c164e;font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.bar{display:flex;align-items:center;gap:12px;padding:12px 16px;padding-top:calc(12px + env(safe-area-inset-top,0px));background:#1c164e;color:#fff}
.logo{height:32px;width:auto}
.bar-title{font-weight:700;font-size:17px}
.wrap{max-width:720px;margin:0 auto;padding:16px 16px calc(32px + env(safe-area-inset-bottom,0px))}
.intro{margin:4px 2px 14px;color:#1c164ebb}
.lbl{display:block;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#1c164e99;margin:0 2px 6px}
.row{display:flex;gap:10px}
#plate{flex:1;min-width:0;font-size:24px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:14px 16px;border:2px solid #dbdbdb;border-radius:12px;background:#fff;color:inherit}
#plate:focus{outline:none;border-color:#2b3491}
#go{font-size:18px;font-weight:700;padding:0 22px;border:0;border-radius:12px;background:#2b3491;color:#fff}
#go:disabled{opacity:.6}
.verdict{margin-top:18px;border-radius:14px;padding:18px;font-weight:800;font-size:20px}
.ok{background:#e3f6ea;color:#05603a;border:2px solid #34a56f}
.no{background:#fde2e2;color:#a11d1d;border:2px solid #d64545}
.warn{background:#fdf0c4;color:#7a5a00;border:2px solid #e0b100}
.verdict small{display:block;font-weight:600;font-size:15px;margin-top:6px;opacity:.9}
.verdict .say{display:block;font-weight:600;font-size:17px;line-height:1.4;margin-top:10px;color:#1c164e}
.win{background:#fff;border:1px solid #dbdbdb;border-radius:14px;padding:14px;margin-top:12px}
.win b{font-size:17px}
.win .meta{color:#1c164ebb;margin-top:2px}
.win img{display:block;width:100%;max-height:70vh;object-fit:contain;background:#eee;border-radius:10px;margin-top:10px}
.cmp{margin-top:8px;font-size:14px;color:#1c164ebb}
.foot{margin-top:28px;text-align:center;font-size:13px;color:#1c164e77}
`;

// Plain ES5-ish: lives in a template string.
const CLIENT_JS = `
(function(){
  var BASE = JSON.parse(document.getElementById('cfg').textContent).base;
  var f = document.getElementById('f'), input = document.getElementById('plate');
  var out = document.getElementById('out'), go = document.getElementById('go');
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmt(d){
    var p = String(d).split('-');
    var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(p[1]) - 1];
    return m ? m + ' ' + Number(p[2]) + ', ' + p[0] : d;
  }
  var PRIZE = { GT30: 'Free month', GT365: 'Free year', GTLIFE: 'Free for life' };
  f.addEventListener('submit', function(e){
    e.preventDefault();
    var plate = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (plate.length < 2) { input.focus(); return; }
    go.disabled = true; out.innerHTML = '';
    fetch(BASE + '/check?plate=' + encodeURIComponent(plate), { cache: 'no-store' })
      .then(function(r){ return r.json().then(function(b){ return { ok: r.ok, b: b }; }); })
      .then(function(res){
        var b = res.b;
        if (!res.ok || !b.ok) { out.innerHTML = '<div class="verdict warn">' + esc((b && b.error) || 'Could not check. Try again.') + '</div>'; return; }
        if (!b.promo) {
          out.innerHTML = b.next_promo
            ? '<div class="verdict warn">The golden ticket promo hasn’t started yet.<small>' + esc(b.next_promo.name) + ' starts ' + esc(fmt(b.next_promo.starts_on)) + '. Ask CRD before awarding.</small></div>'
            : '<div class="verdict warn">No golden ticket promo has been set up yet.<small>Ask CRD before awarding.</small></div>';
          return;
        }
        var promoLine = esc(b.promo.name) + ' (' + fmt(b.promo.starts_on) + ' \\u2013 ' + fmt(b.promo.ends_on) + ')' +
          (b.promo.running ? '' : ' \\u2014 this promo has ended');
        if (!b.wins.length) {
          out.innerHTML = '<div class="verdict ok">' + esc(b.plate) + ' has not won. OK to award.<small>' + promoLine + '</small></div>';
          return;
        }
        out.innerHTML = '<div class="verdict no">' + esc(b.plate) + ' has already won' +
          (b.wins.length > 1 ? ' ' + b.wins.length + ' times' : '') + '.' +
          '<span class="say">Explain to the customer that the rule is one free unlimited win per vehicle. You can sign the ticket so they can give it to a friend or family member, or bring it in with another vehicle.</span>' +
          '<small>' + promoLine + '</small></div>' +
          b.wins.map(function(w){
            return '<div class="win"><b>' + esc(PRIZE[w.prize_code] || w.prize || 'Prize') + '</b>' +
              '<div class="meta">' + esc(fmt(w.won_on)) + ' at ' + esc(w.site) + '</div>' +
              (w.photo
                ? '<img loading="lazy" alt="Ticket next to the plate from that win" src="' + esc(w.photo) + '">' +
                  '<div class="cmp">Compare with the car in front of you. A different vehicle with the same plate number (another state) can still win.</div>'
                : '<div class="cmp">No photo on file for this win.</div>') +
              '</div>';
          }).join('');
      })
      .catch(function(){ out.innerHTML = '<div class="verdict warn">Could not check. Check your connection and try again.</div>'; })
      .then(function(){ go.disabled = false; });
  });
  input.focus();
})();
`;
