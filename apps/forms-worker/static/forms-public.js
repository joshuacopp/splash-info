/*!
 * Splash Forms — public-form client wiring (Brief 92 + Brief 93).
 *
 * Loaded via <script src="/forms/api/static/forms-public.js" defer> on every
 * public render. Wires:
 *   - signature canvases (signature_pad library, loaded separately)
 *   - file inputs (immediate POST to /forms/api/upload, hidden-input r2_key)
 *   - lookup fields — listen for changes on the configured key field and
 *     POST to /forms/api/lookup/{slug}; populate the dependent lookup UI
 *     (Brief 93)
 *   - per-field error/status display under each affected field wrapper
 *
 * No framework. Vanilla JS. Reads pending_submission_id from the form's
 * <input name="pending_submission_id"> hidden input written by the Brief 90
 * renderer.
 */
(function () {
  "use strict";

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
      var pendingId = pending.value;
      // Form action is /forms/api/submit/{slug} — slug is the last path segment.
      var actionUrl = formEl.getAttribute("action") || "";
      var slug = actionUrl.split("/").pop();
      if (!slug) return;

      var sigWraps = formEl.querySelectorAll('[data-field-type="signature"]');
      Array.prototype.forEach.call(sigWraps, function (wrap) {
        wireSignature(wrap, slug, pendingId);
      });
      var fileWraps = formEl.querySelectorAll('[data-field-type="file"]');
      Array.prototype.forEach.call(fileWraps, function (wrap) {
        wireFile(wrap, slug, pendingId);
      });
      wireLookups(formEl, slug);
    });
  }

  // ---------------------------------------------------------------------
  // Signature
  // ---------------------------------------------------------------------

  function wireSignature(wrap, slug, pendingId) {
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

  function wireFile(wrap, slug, pendingId) {
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
      // browser-restored form state on back-button).
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
