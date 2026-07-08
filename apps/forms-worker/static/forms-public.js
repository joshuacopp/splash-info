/*!
 * Splash Forms — public-form client wiring (Brief 92 + Brief 93 + Brief 122).
 *
 * Loaded via <script src="/forms/api/static/forms-public.js" defer> on every
 * public render. Wires:
 *   - signature canvases (signature_pad library, loaded separately)
 *   - file inputs (immediate POST to /forms/api/upload, hidden-input r2_key)
 *   - lookup fields — listen for changes on the configured key field and
 *     POST to /forms/api/lookup/{slug}; populate the dependent lookup UI
 *     (Brief 93)
 *   - per-field error/status display under each affected field wrapper
 *   - Brief 122: localStorage autosave keyed by form slug, resume banner on
 *     page load when a <30-day draft exists, clear-on-successful-submit.
 *     Survives refresh / browser close / multi-day gaps on the same
 *     browser+device.
 *
 * No framework. Vanilla JS. Reads pending_submission_id from the form's
 * <input name="pending_submission_id"> hidden input written by the Brief 90
 * renderer.
 */
(function () {
  "use strict";

  var DRAFT_KEY_PREFIX = "forms.draft.";
  var DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var SAVE_DEBOUNCE_MS = 500;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initForms);
  } else {
    initForms();
  }

  function initForms() {
    var forms = document.querySelectorAll("form.forms-body");
    Array.prototype.forEach.call(forms, function (formEl) {
      var pending = formEl.querySelector('input[name="pending_submission_id"]');
      if (!pending) return;
      // Form action is /forms/api/submit/{slug} — slug is the last path segment.
      var actionUrl = formEl.getAttribute("action") || "";
      var slug = actionUrl.split("/").pop();
      if (!slug) return;

      // Per-form wiring. Note that the signature / file handlers read the
      // pending_submission_id from the live <input> element at upload time
      // (not capture-time), so a Brief 122 resume that rewrites the hidden
      // input flows through naturally to new uploads.
      var sigWraps = formEl.querySelectorAll('[data-field-type="signature"]');
      Array.prototype.forEach.call(sigWraps, function (wrap) {
        wireSignature(wrap, slug, formEl);
      });
      var fileWraps = formEl.querySelectorAll('[data-field-type="file"]');
      Array.prototype.forEach.call(fileWraps, function (wrap) {
        wireFile(wrap, slug, formEl);
      });
      wireLookups(formEl, slug);
      wireMultiMax(formEl);

      // Brief 122 — autosave / resume. Submit interception (below) owns
      // clear-on-submit now (only clears on a confirmed 200 success).
      maybeRenderResumeBanner(formEl, slug);
      wireAutosave(formEl, slug);
      wireSubmitInterception(formEl, slug);
    });
  }

  // ---------------------------------------------------------------------
  // Signature
  // ---------------------------------------------------------------------

  function wireSignature(wrap, slug, formEl) {
    var canvas = wrap.querySelector("canvas.field-signature-canvas");
    var hidden = wrap.querySelector('input[type="hidden"]');
    var clearBtn = wrap.querySelector(".signature-clear-btn");
    var fieldKey = wrap.getAttribute("data-field-key");
    var format = wrap.getAttribute("data-format") || "png";
    var penColor = wrap.getAttribute("data-pen-color") || "#000000";
    if (!canvas || !hidden || !window.SignaturePad) return;

    var pad = new window.SignaturePad(canvas, { penColor: penColor });
    var debounce;

    pad.addEventListener("endStroke", function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        var pendingId = currentPendingId(formEl);
        if (!pendingId) return;
        uploadSignature(pad, format, slug, pendingId, fieldKey, hidden, wrap);
      }, 800);
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        pad.clear();
        hidden.value = "";
        clearError(wrap);
        clearStatus(wrap);
      });
    }
  }

  function uploadSignature(pad, format, slug, pendingId, fieldKey, hiddenInput, wrap) {
    if (pad.isEmpty()) return;
    var blob;
    if (format === "svg") {
      var svg = pad.toSVG();
      blob = new Blob([svg], { type: "image/svg+xml" });
    } else {
      var dataUrl = pad.toDataURL("image/png");
      var b64 = dataUrl.split(",")[1];
      var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      blob = new Blob([bytes], { type: "image/png" });
    }
    showStatus(wrap, "Saving signature…");
    var fd = new FormData();
    fd.append("pending_submission_id", pendingId);
    fd.append("field_key", fieldKey);
    fd.append("signature", blob);
    fetch("/forms/api/signature/" + encodeURIComponent(slug), {
      method: "POST",
      body: fd
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok || res.body.error) {
          showError(wrap, res.body.error || "Failed to save signature");
          return;
        }
        hiddenInput.value = res.body.r2_key;
        showStatus(wrap, "Signature saved");
      })
      .catch(function () { showError(wrap, "Failed to save signature. Please try again."); });
  }

  // ---------------------------------------------------------------------
  // File
  // ---------------------------------------------------------------------

  function wireFile(wrap, slug, formEl) {
    var input = wrap.querySelector('input[type="file"]');
    var fieldKey = wrap.getAttribute("data-field-key");
    if (!input || !fieldKey) return;

    // Hidden companion input carries the r2_key reference for submit.
    var hidden = wrap.querySelector('input[type="hidden"][data-r2-key="1"]');
    if (!hidden) {
      hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = fieldKey + "_r2";
      hidden.setAttribute("data-r2-key", "1");
      wrap.appendChild(hidden);
    }

    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (!file) {
        hidden.value = "";
        clearStatus(wrap);
        return;
      }
      var pendingId = currentPendingId(formEl);
      if (!pendingId) return;
      uploadFile(file, slug, pendingId, fieldKey, hidden, wrap);
    });
  }

  function uploadFile(file, slug, pendingId, fieldKey, hiddenInput, wrap) {
    clearError(wrap);
    showStatus(wrap, "Uploading " + file.name + "…");
    var fd = new FormData();
    fd.append("pending_submission_id", pendingId);
    fd.append("field_key", fieldKey);
    fd.append("file", file);
    fetch("/forms/api/upload/" + encodeURIComponent(slug), {
      method: "POST",
      body: fd
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (!res.ok || res.body.error) {
          showError(wrap, res.body.error || "Upload failed");
          hiddenInput.value = "";
          return;
        }
        hiddenInput.value = res.body.r2_key;
        var kb = Math.round((res.body.size_bytes || 0) / 1024);
        showStatus(wrap, "Uploaded " + file.name + " (" + kb + " KB)");
      })
      .catch(function () {
        showError(wrap, "Upload failed. Please try again.");
        hiddenInput.value = "";
      });
  }

  function currentPendingId(formEl) {
    var el = formEl.querySelector('input[name="pending_submission_id"]');
    return el ? el.value : "";
  }

  // ---------------------------------------------------------------------
  // Multi-select max enforcement
  //
  // The `maxSelected` ceiling is validated server-side at submit, but that
  // only surfaces AFTER a failed submit. Here we prevent the over-selection
  // in the first place: once `max` boxes are checked, disable the remaining
  // unchecked ones; re-enable them the moment the user unchecks one. Groups
  // with no `data-max-selected` (no ceiling) are left alone. `minSelected`
  // can't be enforced this way — you can't force a user to check boxes — so
  // it stays a submit-time check.
  // ---------------------------------------------------------------------
  function wireMultiMax(formEl) {
    var groups = formEl.querySelectorAll(
      '[data-field-type="multi"][data-max-selected]'
    );
    Array.prototype.forEach.call(groups, function (group) {
      var max = parseInt(group.getAttribute("data-max-selected"), 10);
      if (!(max > 0)) return;
      var boxes = group.querySelectorAll('input[type="checkbox"]');

      function enforce() {
        var checked = 0;
        Array.prototype.forEach.call(boxes, function (b) {
          if (b.checked) checked += 1;
        });
        var atMax = checked >= max;
        Array.prototype.forEach.call(boxes, function (b) {
          if (!b.checked) b.disabled = atMax;
        });
      }

      group.addEventListener("change", enforce);
      // Initial pass covers restored drafts / back-button bfcache state.
      enforce();
    });
  }

  // ---------------------------------------------------------------------
  // Lookup (Brief 93)
  //
  // Per planning Decision 5b: when the user changes the key field's value,
  // POST to /forms/api/lookup/{slug} with {lookup_field_id, key_value};
  // populate the dependent lookup field's UI from the response.
  //
  // The displayed value is for UX only — the submit handler always
  // re-resolves server-side and writes the canonical value, regardless of
  // what's in the visible input. So a tampered or stale visible value
  // never reaches form_submissions.payload.
  // ---------------------------------------------------------------------

  function wireLookups(formEl, slug) {
    var lookupWraps = formEl.querySelectorAll('[data-field-type="lookup"]');
    if (!lookupWraps.length) return;

    // Group lookups by their key field id.
    var keyFieldDependencies = {};
    Array.prototype.forEach.call(lookupWraps, function (wrap) {
      var keyId = wrap.getAttribute("data-lookup-key-field");
      if (!keyId) return;
      if (!keyFieldDependencies[keyId]) keyFieldDependencies[keyId] = [];
      keyFieldDependencies[keyId].push(wrap);
    });

    Object.keys(keyFieldDependencies).forEach(function (keyId) {
      var keyEl = formEl.querySelector('[id="' + cssAttrEscape(keyId) + '"]');
      if (!keyEl) return;
      var deps = keyFieldDependencies[keyId];

      var debounceTimer;
      function onKeyChange() {
        clearTimeout(debounceTimer);
        var keyValue = keyEl.value || "";
        debounceTimer = setTimeout(function () {
          deps.forEach(function (wrap) {
            resolveLookupField(wrap, slug, keyValue);
          });
        }, 250);
      }

      keyEl.addEventListener("input", onKeyChange);
      keyEl.addEventListener("change", onKeyChange);

      // Initial resolve if the key field already has a value (e.g.,
      // browser-restored form state on back-button, or Brief 122 resume).
      if (keyEl.value) {
        deps.forEach(function (wrap) {
          resolveLookupField(wrap, slug, keyEl.value);
        });
      }
    });
  }

  function resolveLookupField(wrap, slug, keyValue) {
    var resolutionMode = wrap.getAttribute("data-lookup-resolution-mode") || "prefill_visible";
    var fieldId = wrap.getAttribute("data-lookup-field-id");
    if (!fieldId) return;

    var input = wrap.querySelector('input[type="text"], input[type="hidden"]');
    var displayDiv = wrap.querySelector(".field-display-value");

    function setDisplay(text, italic) {
      if (resolutionMode === "display_only") {
        if (displayDiv) {
          if (italic) {
            displayDiv.innerHTML = "<em></em>";
            displayDiv.firstChild.textContent = String(text);
          } else {
            displayDiv.textContent = String(text);
          }
        }
      } else if (input) {
        input.value = text == null ? "" : String(text);
      }
    }

    if (!keyValue) {
      // Cleared key — reset to empty / placeholder.
      if (resolutionMode === "display_only" && displayDiv) {
        displayDiv.innerHTML = "<em>Select to populate</em>";
      } else if (input) {
        input.value = "";
      }
      return;
    }

    // Loading hint.
    if (resolutionMode === "display_only" && displayDiv) {
      displayDiv.innerHTML = "<em>Resolving...</em>";
    } else if (input && resolutionMode !== "prefill_hidden") {
      input.value = "Resolving...";
    }

    fetch("/forms/api/lookup/" + encodeURIComponent(slug), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookup_field_id: fieldId, key_value: keyValue })
    })
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      })
      .then(function (res) {
        if (!res.ok || !res.body || res.body.error) {
          setDisplay(resolutionMode === "display_only" ? "(error)" : "", false);
          return;
        }
        var value = res.body.value;
        if (value == null || value === "") {
          if (resolutionMode === "display_only" && displayDiv) {
            displayDiv.innerHTML = "<em>(no match)</em>";
          } else if (input) {
            input.value = "";
          }
          return;
        }
        setDisplay(value, false);
      })
      .catch(function () {
        setDisplay(resolutionMode === "display_only" ? "(error)" : "", false);
      });
  }

  // Minimal CSS-attribute escape for [id="..."] selectors. The renderer
  // emits UUID-shaped ids (hex + hyphen), so the universe of dangerous
  // chars is small; this guards against accidental quote injection
  // without pulling in the full CSS.escape polyfill.
  function cssAttrEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // ---------------------------------------------------------------------
  // Brief 122 — localStorage draft persistence
  //
  // Key shape: `forms.draft.{slug}` → JSON {values, pendingSubmissionId,
  // savedAt}. Values is a flat name→value map (string OR string[] for
  // multi-checkbox / select-multiple groups). pendingSubmissionId is the
  // form's hidden-input id at save time; restoring it keeps file/signature
  // r2_keys (which embed that id in their R2 path) wired to the form.
  // ---------------------------------------------------------------------

  function loadDraft(slug) {
    try {
      var raw = window.localStorage.getItem(DRAFT_KEY_PREFIX + slug);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.values || typeof parsed.values !== "object") return null;
      if (typeof parsed.savedAt !== "number") return null;
      return {
        values: parsed.values,
        pendingSubmissionId:
          typeof parsed.pendingSubmissionId === "string"
            ? parsed.pendingSubmissionId
            : "",
        savedAt: parsed.savedAt
      };
    } catch (e) {
      return null;
    }
  }

  function saveDraft(slug, values, pendingSubmissionId) {
    try {
      var payload = {
        values: values,
        pendingSubmissionId: pendingSubmissionId,
        savedAt: Date.now()
      };
      window.localStorage.setItem(
        DRAFT_KEY_PREFIX + slug,
        JSON.stringify(payload)
      );
    } catch (e) {
      // Quota-exceeded, storage disabled, etc. — degrade silently.
      // Form behavior is unaffected; operator just loses persistence.
      try { console.warn("[forms.autosave] saveDraft failed", e); } catch (_) {}
    }
  }

  function clearDraft(slug) {
    try {
      window.localStorage.removeItem(DRAFT_KEY_PREFIX + slug);
    } catch (e) {
      // ignored
    }
  }

  // Serialize the form's named inputs into a flat name→value map.
  // - file inputs: skipped (browser security prevents programmatic
  //   restore of <input type=file>; the OOB upload's hidden _r2 companion
  //   captures the r2_key as an ordinary hidden input).
  // - radio: only the checked option's value.
  // - checkbox (single or grouped): collected as a string[] of checked
  //   values per name. Empty array if none checked.
  // - select multiple: string[] of selected option values.
  // - everything else: el.value.
  function serializeForm(formEl) {
    var values = {};
    var checkboxNames = {};
    var elements = formEl.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.name) continue;
      var type = (el.type || "").toLowerCase();
      if (type === "file" || type === "submit" || type === "button" || type === "reset") continue;

      if (type === "radio") {
        if (el.checked) values[el.name] = el.value;
        continue;
      }
      if (type === "checkbox") {
        // Collect as array per name. First sighting initializes [].
        if (!checkboxNames[el.name]) {
          checkboxNames[el.name] = true;
          values[el.name] = [];
        }
        if (el.checked) values[el.name].push(el.value);
        continue;
      }
      if (el.tagName === "SELECT" && el.multiple) {
        var opts = [];
        for (var j = 0; j < el.options.length; j++) {
          if (el.options[j].selected) opts.push(el.options[j].value);
        }
        values[el.name] = opts;
        continue;
      }
      values[el.name] = el.value;
    }
    return values;
  }

  // Restore a saved name→value map onto the form. Silently skips names
  // whose <input> no longer exists (form schema changed between save and
  // resume — operator gets partial restore, not a crash). Dispatches
  // input + change events on each touched element so wired handlers
  // (lookup resolver, etc.) re-fire.
  function restoreForm(formEl, values) {
    var dispatchedNames = {};
    var elements = formEl.elements;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.name || !Object.prototype.hasOwnProperty.call(values, el.name)) continue;
      var type = (el.type || "").toLowerCase();
      if (type === "file" || type === "submit" || type === "button" || type === "reset") continue;

      var saved = values[el.name];
      if (type === "radio") {
        el.checked = el.value === saved;
        dispatchedNames[el.name] = el;
        continue;
      }
      if (type === "checkbox") {
        var arr = Array.isArray(saved) ? saved : saved == null ? [] : [saved];
        el.checked = arr.indexOf(el.value) !== -1;
        dispatchedNames[el.name] = el;
        continue;
      }
      if (el.tagName === "SELECT" && el.multiple) {
        var arr2 = Array.isArray(saved) ? saved : saved == null ? [] : [saved];
        for (var j = 0; j < el.options.length; j++) {
          el.options[j].selected = arr2.indexOf(el.options[j].value) !== -1;
        }
        dispatchedNames[el.name] = el;
        continue;
      }
      el.value = saved == null ? "" : String(saved);
      dispatchedNames[el.name] = el;
    }
    // Fire one input + change event per touched element so downstream
    // listeners (lookup wiring, etc.) re-resolve. Wrapped in try/catch
    // because some environments throw on synthetic events for non-text
    // inputs.
    Object.keys(dispatchedNames).forEach(function (name) {
      var el = dispatchedNames[name];
      try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
      try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
    });
  }

  function wireAutosave(formEl, slug) {
    var debounceTimer;
    function scheduleSave() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var values = serializeForm(formEl);
        var pendingId = currentPendingId(formEl);
        saveDraft(slug, values, pendingId);
      }, SAVE_DEBOUNCE_MS);
    }
    // Bind on the form so we capture bubbling input/change events from
    // every <input>, <textarea>, <select> without per-element listeners.
    formEl.addEventListener("input", scheduleSave);
    formEl.addEventListener("change", scheduleSave);
  }

  function maybeRenderResumeBanner(formEl, slug) {
    var draft = loadDraft(slug);
    if (!draft) return;
    var age = Date.now() - draft.savedAt;
    if (age < 0 || age > DRAFT_TTL_MS) {
      // Stale or future-dated draft — drop and render fresh.
      clearDraft(slug);
      return;
    }

    var banner = document.createElement("div");
    banner.className = "forms-resume-banner";
    banner.setAttribute("data-forms-resume-banner", "1");
    banner.setAttribute("role", "status");
    banner.style.background = "#fff8e1";
    banner.style.border = "1px solid #f0c674";
    banner.style.borderRadius = "6px";
    banner.style.padding = "12px 14px";
    banner.style.marginBottom = "20px";
    banner.style.display = "flex";
    banner.style.flexWrap = "wrap";
    banner.style.alignItems = "center";
    banner.style.gap = "10px";

    var icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📋";
    icon.style.fontSize = "20px";
    banner.appendChild(icon);

    var text = document.createElement("span");
    text.style.flex = "1 1 auto";
    text.style.color = "#5a4a1a";
    text.style.fontSize = "14px";
    var ago = formatTimeAgo(age);
    text.innerHTML =
      "You have a saved draft from <strong></strong>.";
    text.querySelector("strong").textContent = ago;
    banner.appendChild(text);

    var actions = document.createElement("span");
    actions.style.display = "inline-flex";
    actions.style.gap = "8px";

    var resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.textContent = "Resume draft";
    styleBannerBtn(resumeBtn, true);
    resumeBtn.addEventListener("click", function () {
      if (draft.pendingSubmissionId) {
        var pending = formEl.querySelector(
          'input[name="pending_submission_id"]'
        );
        if (pending) pending.value = draft.pendingSubmissionId;
      }
      restoreForm(formEl, draft.values);
      removeBanner();
    });

    var discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.textContent = "Discard and start fresh";
    styleBannerBtn(discardBtn, false);
    discardBtn.addEventListener("click", function () {
      clearDraft(slug);
      removeBanner();
    });

    actions.appendChild(resumeBtn);
    actions.appendChild(discardBtn);
    banner.appendChild(actions);

    function removeBanner() {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }

    // Insert at the top of the form (before any field).
    if (formEl.firstChild) {
      formEl.insertBefore(banner, formEl.firstChild);
    } else {
      formEl.appendChild(banner);
    }
  }

  function styleBannerBtn(btn, primary) {
    btn.style.cursor = "pointer";
    btn.style.padding = "8px 14px";
    btn.style.borderRadius = "4px";
    btn.style.fontSize = "14px";
    btn.style.fontWeight = "600";
    btn.style.fontFamily = "inherit";
    btn.style.lineHeight = "1.2";
    if (primary) {
      btn.style.background = "#1e5fa8";
      btn.style.color = "white";
      btn.style.border = "1px solid #1e5fa8";
    } else {
      btn.style.background = "white";
      btn.style.color = "#0a2240";
      btn.style.border = "1px solid #c9c9c9";
    }
  }

  function formatTimeAgo(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s <= 1 ? "1 sec ago" : s + " sec ago";
    var m = Math.round(s / 60);
    if (m < 60) return m === 1 ? "1 min ago" : m + " min ago";
    var h = Math.round(m / 60);
    if (h < 24) return h === 1 ? "1 hr ago" : h + " hr ago";
    var d = Math.round(h / 24);
    return d === 1 ? "1 day ago" : d + " days ago";
  }

  // ---------------------------------------------------------------------
  // Submit interception + inline validation UX
  //
  // Replaces the old native-POST flow (which navigated the browser to the
  // raw 422 JSON body on validation failure). We now fetch() the submit,
  // and:
  //   - 200  → clear the saved draft, swap in the success-page HTML.
  //   - 422  → render each `fields` entry inline under its field wrapper
  //            (reusing showError), plus a summary banner + scroll-to-first.
  //   - other → friendly form-level banner keyed off the `error` code.
  // The draft is cleared ONLY on a confirmed 200, so a failed submit no
  // longer wipes the user's in-progress data.
  // ---------------------------------------------------------------------
  function wireSubmitInterception(formEl, slug) {
    var actionUrl = formEl.getAttribute("action") || "";
    var submitBtn = formEl.querySelector('button[type="submit"], .submit-btn');

    formEl.addEventListener("submit", function (e) {
      e.preventDefault();
      clearFormError(formEl);
      clearAllFieldErrors(formEl);

      var origLabel = submitBtn ? submitBtn.textContent : "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting…";
      }

      fetch(actionUrl, {
        method: "POST",
        body: new FormData(formEl),
        headers: { Accept: "application/json" }
      })
        .then(function (resp) {
          if (resp.ok) {
            // Server returns the full success-page HTML. Clear the draft
            // and replace the document with it.
            clearDraft(slug);
            return resp.text().then(function (html) {
              document.open();
              document.write(html);
              document.close();
            });
          }
          return resp.text().then(function (text) {
            var body = null;
            try { body = JSON.parse(text); } catch (_) {}
            restoreSubmitBtn(submitBtn, origLabel);
            // A single-use Turnstile token is consumed on submit; reset the
            // widget so a retry gets a fresh one.
            resetTurnstile();

            if (resp.status === 422 && body && body.fields) {
              applyFieldErrors(formEl, body.fields);
              var n = Object.keys(body.fields).length;
              showFormError(
                formEl,
                "Please fix the highlighted field" + (n === 1 ? "" : "s") + " below."
              );
              scrollToFirstError(formEl);
              return;
            }

            var code = (body && body.error) || "";
            showFormError(formEl, humanizeError(code));
          });
        })
        .catch(function () {
          restoreSubmitBtn(submitBtn, origLabel);
          showFormError(
            formEl,
            "Network error — check your connection and try again."
          );
        });
    });
  }

  function restoreSubmitBtn(btn, label) {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = label || "Submit";
  }

  function resetTurnstile() {
    try {
      if (window.turnstile && typeof window.turnstile.reset === "function") {
        window.turnstile.reset();
      }
    } catch (_) {}
  }

  function applyFieldErrors(formEl, fields) {
    Object.keys(fields).forEach(function (key) {
      var wrap = formEl.querySelector(
        '[data-field-key="' + cssAttrEscape(key) + '"]'
      );
      if (wrap) showError(wrap, fields[key]);
    });
  }

  function clearAllFieldErrors(formEl) {
    var errs = formEl.querySelectorAll('[data-field-error="1"]');
    Array.prototype.forEach.call(errs, function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function scrollToFirstError(formEl) {
    var firstErr = formEl.querySelector('[data-field-error="1"]');
    var target =
      firstErr && firstErr.parentNode
        ? firstErr.parentNode
        : formEl.querySelector('[data-forms-error-summary="1"]');
    if (target && target.scrollIntoView) {
      try {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {
        target.scrollIntoView();
      }
    }
  }

  function showFormError(formEl, msg) {
    clearFormError(formEl);
    var div = document.createElement("div");
    div.setAttribute("data-forms-error-summary", "1");
    div.setAttribute("role", "alert");
    div.style.background = "#fdecea";
    div.style.border = "1px solid #f5c6cb";
    div.style.color = "#8a1c1c";
    div.style.borderRadius = "6px";
    div.style.padding = "12px 14px";
    div.style.marginBottom = "20px";
    div.style.fontSize = "14px";
    div.textContent = String(msg);
    if (formEl.firstChild) formEl.insertBefore(div, formEl.firstChild);
    else formEl.appendChild(div);
  }

  function clearFormError(formEl) {
    var existing = formEl.querySelector('[data-forms-error-summary="1"]');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  // Map a server error code (possibly "code: detail") to a friendly line.
  // Unknown codes fall through to the raw string so nothing is swallowed.
  function humanizeError(code) {
    var first = String(code).split(":")[0].trim();
    var map = {
      bad_origin: "Your session couldn't be verified. Reload the page and try again.",
      form_not_found: "This form is no longer available.",
      form_not_accepting_submissions: "This form is no longer accepting submissions.",
      form_has_no_published_version: "This form isn't published yet.",
      invalid_form_data: "Your submission couldn't be read. Please try again.",
      invalid_pending_id: "This form session expired. Reload the page and try again.",
      lookup_failed: "A looked-up value couldn't be resolved. Check your selections and try again.",
      too_many_files: "Too many files attached. Remove some and try again.",
      submission_too_large: "The attached files are too large. Remove some and try again.",
      session_expired: "Your login expired. Sign in again in a new tab, then click Submit.",
      turnstile_failed: "The anti-spam check failed. Please try again.",
      r2_head_failed: "A file couldn't be verified. Please try again.",
      missing_file: "An uploaded file is missing. Re-attach it and try again.",
      insert_failed: "We couldn't save your submission. Please try again."
    };
    return map[first] || (code ? String(code) : "Something went wrong. Please try again.");
  }

  // ---------------------------------------------------------------------
  // Error / status display helpers
  // ---------------------------------------------------------------------

  function showError(wrap, msg) {
    clearError(wrap);
    clearStatus(wrap);
    var div = document.createElement("div");
    div.className = "field-error";
    div.style.color = "var(--splash-error)";
    div.style.fontSize = "13px";
    div.style.marginTop = "4px";
    div.textContent = String(msg);
    div.setAttribute("data-field-error", "1");
    wrap.appendChild(div);
  }
  function clearError(wrap) {
    var existing = wrap.querySelector('[data-field-error="1"]');
    if (existing) existing.parentNode.removeChild(existing);
  }
  function showStatus(wrap, msg) {
    clearStatus(wrap);
    var div = document.createElement("div");
    div.style.fontSize = "13px";
    div.style.color = "#666";
    div.style.marginTop = "4px";
    div.textContent = String(msg);
    div.setAttribute("data-field-status", "1");
    wrap.appendChild(div);
  }
  function clearStatus(wrap) {
    var existing = wrap.querySelector('[data-field-status="1"]');
    if (existing) existing.parentNode.removeChild(existing);
  }
})();
