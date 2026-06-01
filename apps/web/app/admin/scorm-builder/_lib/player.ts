// Brief 148 — Player + SCORM wrapper + CSS templates for the generated package.
//
// These three string constants ship inside the SCORM .zip as scorm.js,
// index.html, and style.css. Lifted verbatim from scorm-builder.html.
//
// The strings are stored in `String.raw` form so backslashes / template
// literal interpolation inside the inlined JS are not interpreted by the
// outer TS compiler.

import type { BuilderState } from "./types";

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m] as string
  );
}

interface CourseConfig {
  title: string;
  description: string;
  passScore: number;
  videoFilename: string;
  videoMime: string;
  questions: {
    text: string;
    type: "mc" | "tf";
    choices: string[];
    correctIndex: number;
  }[];
}

export function buildCourseConfig(
  state: BuilderState,
  videoFilename: string,
  videoMime: string
): CourseConfig {
  return {
    title: state.title,
    description: state.description,
    passScore: state.passScore,
    videoFilename,
    videoMime,
    questions: state.questions.map((q) => ({
      text: q.text,
      type: q.type,
      choices: q.choices.filter((c) => c.trim()),
      correctIndex: q.correctIndex
    }))
  };
}

export function buildIndexHtml(
  state: BuilderState,
  videoFilename: string,
  videoMime: string
): string {
  const courseConfig = buildCourseConfig(state, videoFilename, videoMime);

  // The closing </script> tag inside the inline string is split as
  // "<\/script>" so the surrounding ES module isn't terminated early.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(state.title)}</title>
<link rel="stylesheet" href="style.css">
<script src="scorm.js"><\/script>
</head>
<body>
<div id="app">
  <header class="course-head">
    <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes">
    <div class="head-text">
      <div class="eyebrow">Splash Training</div>
      <h1 id="courseTitle"></h1>
    </div>
  </header>
  <main id="screens">
    <!-- intro -->
    <section class="screen" id="screen-intro">
      <p id="courseDesc"></p>
      <p class="muted">When you're ready, press Begin. You'll watch the video, then answer questions to complete the course.</p>
      <button class="btn primary large" id="beginBtn">Begin</button>
    </section>
    <!-- video -->
    <section class="screen" id="screen-video" hidden>
      <video id="player" controls playsinline preload="metadata">
        <source id="playerSource">
        Your browser does not support the video tag.
      </video>
      <div class="video-foot">
        <p class="muted" id="videoHint">Watch the video, then continue to the quiz.</p>
        <button class="btn primary" id="toQuizBtn" disabled>Continue to quiz</button>
      </div>
    </section>
    <!-- quiz -->
    <section class="screen" id="screen-quiz" hidden>
      <form id="quizForm"></form>
      <div class="quiz-foot">
        <button class="btn primary large" type="button" id="submitQuiz">Submit answers</button>
      </div>
    </section>
    <!-- results -->
    <section class="screen" id="screen-results" hidden>
      <h2 id="resultsHeading"></h2>
      <p id="resultsScore" class="score"></p>
      <p id="resultsMsg" class="muted"></p>
      <div class="results-actions">
        <button class="btn secondary" type="button" id="reviewBtn" hidden>Review answers</button>
        <button class="btn primary" type="button" id="retryBtn" hidden>Retry quiz</button>
        <button class="btn primary" type="button" id="finishBtn" hidden>Finish</button>
      </div>
    </section>
  </main>
</div>
<script>
window.COURSE_CONFIG = ${JSON.stringify(courseConfig)};
<\/script>
<script src="player.js" onerror="initPlayer()"><\/script>
<script>
${PLAYER_JS}
<\/script>
</body>
</html>`;
}

export function buildScormJs(): string {
  return SCORM_WRAPPER_JS;
}

export function buildStyleCss(): string {
  return PLAYER_CSS;
}

// ---------- SCORM wrapper (goes into scorm.js inside the package) ----------
const SCORM_WRAPPER_JS = String.raw`
// SCORM 1.2 API wrapper. Walks window.parent chain to find window.API.
// All functions are fail-safe: if the LMS isn't there (e.g. previewing
// the index.html locally), they no-op and the course still runs.
(function() {
  var API = null;
  var initialized = false;
  var MAX_DEPTH = 500;

  function findAPI(win) {
    var depth = 0;
    while (win && win.API == null && win.parent && win.parent !== win && depth < MAX_DEPTH) {
      depth++;
      win = win.parent;
    }
    return win && win.API ? win.API : null;
  }

  function getAPI() {
    if (API) return API;
    API = findAPI(window);
    if (!API && window.opener) API = findAPI(window.opener);
    return API;
  }

  function call(name, val) {
    var api = getAPI();
    if (!api) return null;
    try {
      if (val === undefined) return api[name]("");
      return api[name]("", val);
    } catch (e) { return null; }
  }

  window.SCORM = {
    init: function() {
      if (initialized) return true;
      var api = getAPI();
      if (!api) { initialized = false; return false; }
      var r = call("LMSInitialize");
      initialized = (r === "true" || r === true);
      if (initialized) {
        // Set incomplete on launch so the LMS sees a heartbeat.
        call("LMSSetValue", "cmi.core.lesson_status");
        var status = call("LMSGetValue", "cmi.core.lesson_status");
        if (!status || status === "not attempted" || status === "") {
          api["LMSSetValue"]("cmi.core.lesson_status", "incomplete");
        }
        api["LMSCommit"]("");
      }
      return initialized;
    },
    setScore: function(raw, max, min) {
      var api = getAPI();
      if (!api || !initialized) return false;
      try {
        api["LMSSetValue"]("cmi.core.score.raw", String(raw));
        api["LMSSetValue"]("cmi.core.score.max", String(max == null ? 100 : max));
        api["LMSSetValue"]("cmi.core.score.min", String(min == null ? 0 : min));
        api["LMSCommit"]("");
        return true;
      } catch (e) { return false; }
    },
    setStatus: function(status) {
      var api = getAPI();
      if (!api || !initialized) return false;
      try {
        api["LMSSetValue"]("cmi.core.lesson_status", status);
        api["LMSCommit"]("");
        return true;
      } catch (e) { return false; }
    },
    setExit: function(reason) {
      var api = getAPI();
      if (!api || !initialized) return false;
      try {
        api["LMSSetValue"]("cmi.core.exit", reason || "");
        api["LMSCommit"]("");
        return true;
      } catch (e) { return false; }
    },
    finish: function() {
      if (!initialized) return false;
      var api = getAPI();
      if (!api) return false;
      try {
        api["LMSCommit"]("");
        api["LMSFinish"]("");
        initialized = false;
        return true;
      } catch (e) { return false; }
    },
    isConnected: function() {
      return initialized;
    }
  };

  // Auto-init on load; auto-finish on unload.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function() { window.SCORM.init(); });
  } else {
    window.SCORM.init();
  }
  window.addEventListener("beforeunload", function() {
    try { window.SCORM.setExit("suspend"); window.SCORM.finish(); } catch (e) {}
  });
})();
`;

// ---------- Player UI (goes into index.html <script>) ----------
const PLAYER_JS = String.raw`
function initPlayer() {
  var cfg = window.COURSE_CONFIG;
  document.getElementById("courseTitle").textContent = cfg.title;
  document.getElementById("courseDesc").textContent = cfg.description || "";

  var beginBtn = document.getElementById("beginBtn");
  var toQuizBtn = document.getElementById("toQuizBtn");
  var submitBtn = document.getElementById("submitQuiz");
  var retryBtn = document.getElementById("retryBtn");
  var finishBtn = document.getElementById("finishBtn");
  var player = document.getElementById("player");
  var playerSource = document.getElementById("playerSource");
  playerSource.src = cfg.videoFilename;
  playerSource.type = cfg.videoMime;
  player.load();

  function show(id) {
    ["screen-intro","screen-video","screen-quiz","screen-results"].forEach(function(n) {
      document.getElementById(n).hidden = (n !== id);
    });
    window.scrollTo(0, 0);
  }

  beginBtn.addEventListener("click", function() { show("screen-video"); });

  player.addEventListener("ended", function() { toQuizBtn.disabled = false; });
  // Allow advancing even without full play (some LMSs reload mid-video).
  player.addEventListener("timeupdate", function() {
    if (player.duration && player.currentTime / player.duration > 0.9) {
      toQuizBtn.disabled = false;
    }
  });

  toQuizBtn.addEventListener("click", function() {
    renderQuiz(cfg);
    show("screen-quiz");
  });

  submitBtn.addEventListener("click", function() {
    var result = gradeQuiz(cfg);
    showResults(cfg, result);
  });

  retryBtn.addEventListener("click", function() {
    renderQuiz(cfg);
    show("screen-quiz");
  });

  finishBtn.addEventListener("click", function() {
    try { window.SCORM && window.SCORM.setExit(""); window.SCORM && window.SCORM.finish(); } catch (e) {}
    window.close(); // some LMSs honor this; others ignore.
  });
}

function renderQuiz(cfg) {
  var form = document.getElementById("quizForm");
  form.innerHTML = "";
  cfg.questions.forEach(function(q, qi) {
    var qDiv = document.createElement("div");
    qDiv.className = "qblock";
    var heading = document.createElement("p");
    heading.className = "qtext";
    heading.textContent = (qi + 1) + ". " + q.text;
    qDiv.appendChild(heading);
    q.choices.forEach(function(c, ci) {
      var id = "q" + qi + "c" + ci;
      var row = document.createElement("label");
      row.className = "qchoice";
      row.setAttribute("for", id);
      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "q" + qi;
      radio.value = String(ci);
      radio.id = id;
      var span = document.createElement("span");
      span.textContent = c;
      row.appendChild(radio);
      row.appendChild(span);
      qDiv.appendChild(row);
    });
    form.appendChild(qDiv);
  });
}

function gradeQuiz(cfg) {
  var correct = 0;
  var total = cfg.questions.length;
  var answers = [];
  cfg.questions.forEach(function(q, qi) {
    var picked = document.querySelector('input[name="q' + qi + '"]:checked');
    var pickedIdx = picked ? Number(picked.value) : -1;
    var isCorrect = pickedIdx === q.correctIndex;
    if (isCorrect) correct++;
    answers.push({ pickedIdx: pickedIdx, correct: isCorrect });
  });
  var pct = total === 0 ? 0 : Math.round((correct / total) * 100);
  return { correct: correct, total: total, pct: pct, answers: answers };
}

function showResults(cfg, result) {
  var passed = result.pct >= cfg.passScore;
  document.getElementById("resultsHeading").textContent = passed ? "Passed" : "Not passed";
  document.getElementById("resultsHeading").className = passed ? "pass" : "fail";
  document.getElementById("resultsScore").textContent = "Score: " + result.pct + "%  (" + result.correct + " of " + result.total + ")";
  document.getElementById("resultsMsg").textContent = passed
    ? "Nice work — your completion has been recorded."
    : "You need " + cfg.passScore + "% to pass. Try again.";
  document.getElementById("retryBtn").hidden = passed;
  document.getElementById("finishBtn").hidden = !passed;

  // Report to LMS
  try {
    if (window.SCORM && window.SCORM.isConnected()) {
      window.SCORM.setScore(result.pct, 100, 0);
      window.SCORM.setStatus(passed ? "passed" : "failed");
      if (passed) window.SCORM.setExit("");
    }
  } catch (e) {}

  document.getElementById("screen-results").hidden = false;
  document.getElementById("screen-quiz").hidden = true;
  window.scrollTo(0, 0);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPlayer);
} else {
  initPlayer();
}
`;

// ---------- Player CSS (goes into style.css) ----------
const PLAYER_CSS = String.raw`
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  color: #1c164e;
  background: #f6f7f9;
  min-height: 100vh;
}
#app { max-width: 820px; margin: 0 auto; padding: 24px 20px 56px; }
.course-head {
  background: linear-gradient(135deg, #2b3491 0%, #1c164e 100%);
  margin: -24px -20px 18px; padding: 22px 24px;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  border-bottom: none;
}
.course-head img { height: 44px; width: auto; flex-shrink: 0; }
.course-head .head-text { display: flex; flex-direction: column; gap: 2px; }
.course-head .eyebrow {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.14em; text-transform: uppercase;
  color: #3dbeee;
}
.course-head h1 { margin: 0; font-size: 22px; font-weight: 700; color: #fff; line-height: 1.2; }
.screen { background: #fff; padding: 26px; border-radius: 14px; box-shadow: 0 6px 20px rgba(28,22,78,0.08); }
.muted { color: #6b7280; font-size: 14px; }
.btn {
  appearance: none; border: 1.5px solid transparent; cursor: pointer;
  padding: 10px 16px;
  border-radius: 6px;
  font: 700 13px inherit;
  letter-spacing: 0.02em;
  transition: filter .15s ease, transform .05s ease;
}
.btn:hover { filter: brightness(1.08); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: #2b3491; color: #fff; }
.btn.secondary { background: #fff; color: #2b3491; border-color: #2b3491; }
.btn.large { padding: 14px 28px; font-size: 15px; margin-top: 16px; }
video { width: 100%; max-width: 100%; border-radius: 10px; background: #000; }
.video-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 14px; }
.qblock { margin: 0 0 22px; padding: 0 0 22px; border-bottom: 1px dashed #e3e6eb; }
.qblock:last-child { border-bottom: none; }
.qtext { font-weight: 600; margin: 0 0 12px; font-size: 15px; }
.qchoice {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  border: 1.5px solid #e3e6eb;
  border-radius: 6px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.qchoice:hover { background: #d6f1fb; border-color: #3dbeee; }
.qchoice input[type=radio] {
  appearance: none; width: 16px; height: 16px;
  border: 1.5px solid #d0d4dc; border-radius: 50%; background: #fff;
  cursor: pointer; flex-shrink: 0; position: relative;
}
.qchoice input[type=radio]:checked { border-color: #2b3491; background: #2b3491; }
.qchoice input[type=radio]:checked::after {
  content: ''; position: absolute; inset: 3px; background: #fff; border-radius: 50%;
}
.quiz-foot { margin-top: 18px; }
.score { font-size: 28px; font-weight: 800; color: #1c164e; margin: 14px 0; }
#resultsHeading { font-size: 28px; margin: 0 0 6px; }
#resultsHeading.pass { color: #067647; }
#resultsHeading.fail { color: #dc3e26; }
.results-actions { display: flex; gap: 10px; margin-top: 18px; }
`;
