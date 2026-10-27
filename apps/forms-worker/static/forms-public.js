
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
      
      var actionUrl = formEl.getAttribute("action") || "";
      var slug = actionUrl.split("/").pop();
      if (!slug) return;

      var sigWraps = formEl.querySelectorAll('[data-field-type="signature"]');
      Array.prototype.forEach.call(sigWraps, function (wrap) {
        wireSignature(wrap, slug, formEl);
      });
      var fileWraps = formEl.querySelectorAll('[data-field-type="file"]');
      Array.prototype.forEach.call(fileWraps, function (wrap) {
        wireFile(wrap, slug, formEl);
      });
      wireLookups(formEl, slug);
      wirePriceGrids(formEl, slug);
      wireMultiMax(formEl);
      wireConditionals(formEl);

      maybeRenderResumeBanner(formEl, slug);
      wireAutosave(formEl, slug);
      wireSubmitInterception(formEl, slug);
    });
  }

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

  function wireFile(wrap, slug, formEl) {
    if (wrap.getAttribute("data-multiple") === "1") {
      wireMultiFile(wrap, slug, formEl);
      return;
    }
    var input = wrap.querySelector('input[type="file"]');
    var fieldKey = wrap.getAttribute("data-field-key");
    if (!input || !fieldKey) return;

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

  // Multi-file field. Every picked file uploads on its own (one at a time, so
  // a slow connection shows steady progress instead of N stalled bars) and
  // joins a list the submitter can prune. The hidden `${key}_r2` input holds
  // the JSON array of {r2_key, name} the server reads; the picker is cleared
  // after each pick so the same file can be re-added after a Remove.
  function wireMultiFile(wrap, slug, formEl) {
    var input = wrap.querySelector('input[type="file"]');
    var hidden = wrap.querySelector('input[type="hidden"][data-r2-key="1"]');
    var list = wrap.querySelector('[data-file-list="1"]');
    var fieldKey = wrap.getAttribute("data-field-key");
    if (!input || !hidden || !list || !fieldKey) return;

    var files = []; // { r2_key, name }

    function sync() {
      hidden.value = files.length ? JSON.stringify(files) : "";
      try { hidden.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
    }
    function draw() {
      list.innerHTML = "";
      files.forEach(function (f, i) {
        var li = document.createElement("li");
        var name = document.createElement("span");
        name.textContent = f.name;
        var rm = document.createElement("button");
        rm.type = "button";
        rm.className = "field-file-remove";
        rm.textContent = "Remove";
        rm.addEventListener("click", function () {
          files.splice(i, 1);
          draw();
          sync();
        });
        li.appendChild(name);
        li.appendChild(rm);
        list.appendChild(li);
      });
    }
    function uploadOne(file) {
      var pendingId = currentPendingId(formEl);
      var fd = new FormData();
      fd.append("pending_submission_id", pendingId);
      fd.append("field_key", fieldKey);
      fd.append("file", file);
      return fetch("/forms/api/upload/" + encodeURIComponent(slug), { method: "POST", body: fd })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok || res.body.error) throw new Error(res.body.error || "Upload failed");
          files.push({ r2_key: res.body.r2_key, name: file.name });
          draw();
          sync();
        });
    }

    input.addEventListener("change", function () {
      var picked = Array.prototype.slice.call(input.files || []);
      input.value = "";
      if (!picked.length) return;
      clearError(wrap);
      var failed = [];
      var chain = Promise.resolve();
      picked.forEach(function (file, i) {
        chain = chain.then(function () {
          showStatus(wrap, "Uploading " + file.name + " (" + (i + 1) + " of " + picked.length + ")…");
          return uploadOne(file).catch(function (e) {
            failed.push(file.name + ": " + humanizeError(e && e.message));
          });
        });
      });
      chain.then(function () {
        clearStatus(wrap);
        if (failed.length) showError(wrap, "Not uploaded - " + failed.join("; "));
      });
    });

    // Draft resume rewrites the hidden value and fires `change` on it.
    hidden.addEventListener("change", function () {
      try {
        var v = JSON.parse(hidden.value || "[]");
        files = Array.isArray(v)
          ? v.filter(function (f) { return f && typeof f.r2_key === "string"; })
          : [];
      } catch (e) {
        files = [];
      }
      draw();
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

  // Brief 176 — conditional fields. A question that does not apply to this
  // site should not be asked: no Store rows at a site with no store.
  //
  // DISABLING MATTERS AS MUCH AS HIDING. A hidden-but-enabled input is still
  // submitted, so the answer to a question nobody was shown would ride along
  // in the payload. Disabled inputs are omitted by the browser, which is
  // exactly the behaviour the server's visibility check then agrees with.
  function wireConditionals(formEl) {
    var wraps = formEl.querySelectorAll("[data-visible-if-key]");
    if (!wraps.length) return;

    // Group by controlling key so each control is wired once however many
    // fields depend on it -- nine, for the Store and Exit Pad sections.
    var byKey = {};
    Array.prototype.forEach.call(wraps, function (wrap) {
      var key = wrap.getAttribute("data-visible-if-key");
      if (!key) return;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(wrap);
    });

    function controlValue(key) {
      var els = formEl.querySelectorAll('[name="' + cssAttrEscape(key) + '"]');
      if (!els.length) return null;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        // Radio groups share a name; only the checked one carries the answer.
        if (el.type === "radio" || el.type === "checkbox") {
          if (el.checked) return el.value;
        } else {
          return el.value;
        }
      }
      return null;
    }

    function apply(key) {
      var value = controlValue(key);
      byKey[key].forEach(function (wrap) {
        // JSON rather than a delimiter: option values are operator-authored
        // and any separator character could legitimately appear in one.
        var allowed = [];
        try {
          allowed = JSON.parse(wrap.getAttribute("data-visible-if-equals") || "[]");
        } catch (e) {
          allowed = [];
        }
        if (!Array.isArray(allowed)) allowed = [];
        var show = value != null && allowed.indexOf(value) !== -1;
        wrap.hidden = !show;
        var inputs = wrap.querySelectorAll("input, select, textarea");
        Array.prototype.forEach.call(inputs, function (input) {
          if (show) {
            // Only re-enable what WE disabled. A lookup in prefill_visible
            // mode renders a deliberately disabled input; blanket-enabling
            // would make it editable and submit a value the server is about
            // to re-resolve anyway.
            if (input.getAttribute("data-cond-off") === "1") {
              input.disabled = false;
              input.removeAttribute("data-cond-off");
            }
            if (input.getAttribute("data-cond-req") === "1") {
              input.required = true;
              input.removeAttribute("data-cond-req");
            }
          } else {
            // REQUIRED COMES OFF TOO, not just disabled.
            //
            // A required control that is hidden makes the browser refuse to
            // submit AND refuse to say why -- it cannot focus the field to
            // complain, so the button simply does nothing. Dropping `required`
            // removes that failure mode outright rather than depending on
            // `disabled` having been applied first.
            //
            // Nothing is lost: the SERVER enforces required for every field it
            // considers visible (submit/index.ts, isFieldVisible), and it
            // recomputes that from the payload rather than trusting the page.
            if (input.required) {
              input.required = false;
              input.setAttribute("data-cond-req", "1");
            }
            if (!input.disabled) {
              input.disabled = true;
              input.setAttribute("data-cond-off", "1");
            }
          }
        });
      });
    }

    Object.keys(byKey).forEach(function (key) {
      var els = formEl.querySelectorAll('[name="' + cssAttrEscape(key) + '"]');
      Array.prototype.forEach.call(els, function (el) {
        el.addEventListener("change", function () { apply(key); });
        el.addEventListener("input", function () { apply(key); });
      });
      // Run once at load so a resumed draft (Brief 122) shows the right
      // sections immediately rather than after the first keystroke.
      apply(key);
    });
  }

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
      
      enforce();
    });
  }

  function wireLookups(formEl, slug) {
    var lookupWraps = formEl.querySelectorAll('[data-field-type="lookup"]');
    if (!lookupWraps.length) return;

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
      
      if (resolutionMode === "display_only" && displayDiv) {
        displayDiv.innerHTML = "<em>Select to populate</em>";
      } else if (input) {
        input.value = "";
      }
      return;
    }

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

  // Package price grid. Rows depend on the site, so they are fetched from
  // /forms/api/packages/{slug} and drawn here. The submitted value is the
  // hidden JSON input; the visible boxes are unnamed (see
  // render/fields/package-price-grid.ts).
  //
  // Two modes:
  //   single-site -- reads the site from another field (data-grid-key-field);
  //                  value is an array of rows.
  //   multi-site  -- the grid adds its own sites ("+ Add site"); value is an
  //                  array of { site, rows }, one section per site.
  //
  // Prices go up as typed. The server normalises them, fills a blank new price
  // from the current one, and rejects any package or site that is not real --
  // this script only has to collect what was entered.
  function wirePriceGrids(formEl, slug) {
    var grids = formEl.querySelectorAll('[data-field-type="package_price_grid"]');
    Array.prototype.forEach.call(grids, function (wrap) {
      if (wrap.getAttribute("data-grid-multi") === "1") wireMultiSiteGrid(formEl, slug, wrap);
      else wireSingleSiteGrid(formEl, slug, wrap);
    });
  }

  function fetchSitePackages(slug, fieldKey, keyValue) {
    return fetch("/forms/api/packages/" + encodeURIComponent(slug), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_key: fieldKey, key_value: keyValue })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j || !Array.isArray(j.packages)) throw new Error("packages");
        return j;
      });
    });
  }

  function gridMessage(container, text) {
    container.innerHTML = "";
    var p = document.createElement("p");
    p.className = "price-grid-empty";
    p.textContent = text;
    container.appendChild(p);
  }

  function priceInput(code, isCurrent, value) {
    var input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.setAttribute("data-price", code);
    input.setAttribute("pattern", "\\$?[0-9,]{1,9}(\\.[0-9]{1,2})?");
    input.title = "A price, e.g. 24.99";
    input.value = value || "";
    if (isCurrent) input.placeholder = "0.00";
    return input;
  }

  // The new-price box shows the current price as its placeholder: blank MEANS
  // "same as current", and showing the number says so without retyping it.
  function syncPlaceholders(row) {
    [["cs", "ns"], ["cm", "nm"]].forEach(function (pair) {
      var cur = row.querySelector('[data-price="' + pair[0] + '"]');
      var next = row.querySelector('[data-price="' + pair[1] + '"]');
      if (cur && next) next.placeholder = cur.value.trim() || "Same as current";
    });
  }

  function setRowOn(row, on) {
    row.classList.toggle("is-on", on);
    var box = row.querySelector("[data-row-pick]");
    if (box) box.checked = on;
    syncRequired(row);
  }

  // Current prices are required on a ticked row -- unless it is being
  // discontinued, which asks nothing about price.
  function syncRequired(row) {
    var on = row.classList.contains("is-on");
    var disc = row.classList.contains("is-discontinued");
    var inputs = row.querySelectorAll('[data-price="cs"], [data-price="cm"]');
    Array.prototype.forEach.call(inputs, function (el) { el.required = on && !disc; });
  }

  function setRowDiscontinued(row, disc) {
    row.classList.toggle("is-discontinued", disc);
    var box = row.querySelector("[data-row-discontinue]");
    if (box) box.checked = disc;
    syncRequired(row);
  }

  /** One tickable package row. `onChange` runs after any edit. */
  function buildPriceRow(idPrefix, i, pkg, prior, onChange) {
    var row = document.createElement("div");
    row.className = "price-grid-row";
    row.setAttribute("data-pkg", pkg);

    var id = idPrefix + "_" + i;
    var pick = document.createElement("label");
    pick.className = "price-grid-pick";
    pick.htmlFor = id;
    var box = document.createElement("input");
    box.type = "checkbox";
    box.id = id;
    box.setAttribute("data-row-pick", "1");
    var name = document.createElement("span");
    // textContent: package names are data, not markup. Display label only;
    // data-pkg keeps the code, which is what the server matches on.
    name.textContent = packageLabel(pkg);
    pick.appendChild(box);
    pick.appendChild(name);
    row.appendChild(pick);

    var grid = document.createElement("div");
    grid.className = "price-grid-prices";
    var cell = function (cls, text) {
      var d = document.createElement("div");
      d.className = cls;
      d.textContent = text;
      return d;
    };
    grid.appendChild(cell("", ""));
    grid.appendChild(cell("col-head", "Current price"));
    grid.appendChild(cell("col-head", "New price"));
    grid.appendChild(cell("row-head", "Single"));
    grid.appendChild(priceInput("cs", true, prior && prior.current_single));
    grid.appendChild(priceInput("ns", false, prior && prior.new_single));
    grid.appendChild(cell("row-head", "Monthly"));
    grid.appendChild(priceInput("cm", true, prior && prior.current_monthly));
    grid.appendChild(priceInput("nm", false, prior && prior.new_monthly));
    row.appendChild(grid);

    // Menu changes. Shown only once the row is ticked (CSS), like the prices.
    var extras = document.createElement("div");
    extras.className = "price-grid-extras";
    var renameLabel = document.createElement("label");
    renameLabel.className = "price-grid-rename";
    var renameText = document.createElement("span");
    renameText.textContent = "Rename to";
    var rename = document.createElement("input");
    rename.type = "text";
    rename.maxLength = 100;
    rename.autocomplete = "off";
    rename.placeholder = "Leave blank to keep the name";
    rename.setAttribute("data-row-rename", "1");
    rename.value = (prior && prior.rename_to) || "";
    renameLabel.appendChild(renameText);
    renameLabel.appendChild(rename);
    var discLabel = document.createElement("label");
    discLabel.className = "price-grid-discontinue";
    var disc = document.createElement("input");
    disc.type = "checkbox";
    disc.setAttribute("data-row-discontinue", "1");
    var discText = document.createElement("span");
    discText.textContent = "Discontinue this package";
    discLabel.appendChild(disc);
    discLabel.appendChild(discText);
    extras.appendChild(renameLabel);
    extras.appendChild(discLabel);
    row.appendChild(extras);

    box.addEventListener("change", function () {
      setRowOn(row, box.checked);
      onChange();
    });
    grid.addEventListener("input", function () {
      syncPlaceholders(row);
      onChange();
    });
    rename.addEventListener("input", onChange);
    disc.addEventListener("change", function () {
      setRowDiscontinued(row, disc.checked);
      onChange();
    });
    setRowOn(row, !!prior);
    setRowDiscontinued(row, !!(prior && prior.discontinue));
    syncPlaceholders(row);
    return row;
  }

  /** Ticked rows in a container, as typed. */
  function readPriceRows(container) {
    var out = [];
    var rows = container.querySelectorAll(".price-grid-row.is-on");
    Array.prototype.forEach.call(rows, function (row) {
      var get = function (k) {
        var el = row.querySelector('[data-price="' + k + '"]');
        return el ? el.value.trim() : "";
      };
      var item = {
        pkg: row.getAttribute("data-pkg"),
        current_single: get("cs"),
        current_monthly: get("cm"),
        new_single: get("ns"),
        new_monthly: get("nm")
      };
      var rename = row.querySelector("[data-row-rename]");
      if (rename && rename.value.trim()) item.rename_to = rename.value.trim();
      if (row.classList.contains("is-discontinued")) item.discontinue = true;
      out.push(item);
    });
    return out;
  }

  function textInput(attr, value, placeholder, opts) {
    var el = document.createElement("input");
    el.type = "text";
    el.autocomplete = "off";
    el.setAttribute(attr, "1");
    el.value = value || "";
    if (placeholder) el.placeholder = placeholder;
    if (opts && opts.price) {
      el.inputMode = "decimal";
      el.setAttribute("pattern", "\\$?[0-9,]{1,9}(\\.[0-9]{1,2})?");
      el.title = "A price, e.g. 24.99";
    }
    if (opts && opts.maxLength) el.maxLength = opts.maxLength;
    if (opts && opts.label) el.setAttribute("aria-label", opts.label);
    return el;
  }

  function removeButton(onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "price-grid-link";
    b.textContent = "Remove";
    b.addEventListener("click", onClick);
    return b;
  }

  /** A package the site doesn't sell yet: name + single + monthly. */
  function buildNewPackageItem(prior, onChange) {
    var el = document.createElement("div");
    el.className = "price-grid-item price-grid-item-new";
    el.appendChild(textInput("data-np-name", prior && prior.name, "New package name", { maxLength: 100, label: "New package name" }));
    el.appendChild(textInput("data-np-single", prior && prior.single, "Single price", { price: true, label: "Single price" }));
    el.appendChild(textInput("data-np-monthly", prior && prior.monthly, "Monthly price", { price: true, label: "Monthly price" }));
    el.appendChild(removeButton(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      onChange();
    }));
    el.addEventListener("input", onChange);
    return el;
  }

  /** A lube or detail service: one price, current -> new. */
  function buildServiceItem(prior, onChange) {
    var el = document.createElement("div");
    el.className = "price-grid-item price-grid-item-service";
    var cat = document.createElement("select");
    cat.setAttribute("data-sv-category", "1");
    cat.setAttribute("aria-label", "Service type");
    [["", "Type…"], ["lube", "Lube"], ["detail", "Detail"]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      cat.appendChild(opt);
    });
    cat.value = (prior && prior.category) || "";
    var cur = textInput("data-sv-current", prior && prior.current, "Current price", { price: true, label: "Current price" });
    var next = textInput("data-sv-new", prior && prior.new, "New price", { price: true, label: "New price" });
    // Blank new = unchanged, shown the same way as package rows.
    var sync = function () { next.placeholder = cur.value.trim() || "Same as current"; };
    el.appendChild(cat);
    el.appendChild(textInput("data-sv-name", prior && prior.name, "Service name", { maxLength: 100, label: "Service name" }));
    el.appendChild(cur);
    el.appendChild(next);
    el.appendChild(removeButton(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      onChange();
    }));
    el.addEventListener("input", function () { sync(); onChange(); });
    el.addEventListener("change", onChange);
    sync();
    return el;
  }

  function readNewPackages(container) {
    var out = [];
    Array.prototype.forEach.call(container.querySelectorAll(".price-grid-item-new"), function (el) {
      var v = function (a) { var i = el.querySelector("[" + a + "]"); return i ? i.value.trim() : ""; };
      var item = { name: v("data-np-name"), single: v("data-np-single"), monthly: v("data-np-monthly") };
      if (item.name || item.single || item.monthly) out.push(item);
    });
    return out;
  }

  function readServices(container) {
    var out = [];
    Array.prototype.forEach.call(container.querySelectorAll(".price-grid-item-service"), function (el) {
      var v = function (a) { var i = el.querySelector("[" + a + "]"); return i ? i.value.trim() : ""; };
      var item = { category: v("data-sv-category"), name: v("data-sv-name"), current: v("data-sv-current"), new: v("data-sv-new") };
      if (item.name || item.current || item.new) out.push(item);
    });
    return out;
  }

  function parseJsonArray(s) {
    try {
      var v = JSON.parse(s || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  // ---- single-site --------------------------------------------------------
  function wireSingleSiteGrid(formEl, slug, wrap) {
    var fieldKey = wrap.getAttribute("data-field-key");
    var keyName = wrap.getAttribute("data-grid-key-field");
    var hidden = wrap.querySelector('[data-grid-value="1"]');
    var rowsEl = wrap.querySelector('[data-grid-rows="1"]');
    if (!fieldKey || !keyName || !hidden || !rowsEl) return;

    var packages = null; // null = not loaded for the current site
    var loadedFor = "";
    var seq = 0;
    var debounce;

    function keyEls() {
      return formEl.querySelectorAll('[name="' + cssAttrEscape(keyName) + '"]');
    }
    function keyValue() {
      var els = keyEls();
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if ((el.type === "radio" || el.type === "checkbox") && !el.checked) continue;
        return (el.value || "").trim();
      }
      return "";
    }
    function serialize() {
      var out = readPriceRows(rowsEl);
      hidden.value = out.length ? JSON.stringify(out) : "";
    }
    function render() {
      if (!packages || packages.length === 0) {
        gridMessage(rowsEl, "No packages found for that site. Check the site number.");
        serialize();
        return;
      }
      var prior = {};
      parseJsonArray(hidden.value).forEach(function (r) {
        if (r && typeof r.pkg === "string") prior[r.pkg] = r;
      });
      rowsEl.innerHTML = "";
      packages.forEach(function (pkg, i) {
        rowsEl.appendChild(buildPriceRow(fieldKey + "__pkg", i, pkg, prior[pkg], serialize));
      });
      serialize();
    }
    function load() {
      var kv = keyValue();
      if (kv === loadedFor && packages !== null) return;
      // Prices typed for one site are not prices for another. A CHANGE of
      // site clears them; the first load (and a draft resume, which arrives
      // as a change from blank) keeps whatever the hidden input holds.
      if (loadedFor && kv !== loadedFor) hidden.value = "";
      loadedFor = kv;
      packages = null;
      if (!kv) {
        gridMessage(rowsEl, "Choose a site above to list its packages.");
        return;
      }
      var mySeq = ++seq;
      gridMessage(rowsEl, "Loading packages…");
      fetchSitePackages(slug, fieldKey, kv)
        .then(function (j) {
          if (mySeq !== seq) return; // a newer site was picked meanwhile
          packages = j.packages;
          render();
        })
        .catch(function () {
          if (mySeq !== seq) return;
          loadedFor = "";
          gridMessage(rowsEl, "Couldn't load packages. Re-select the site to try again.");
        });
    }

    Array.prototype.forEach.call(keyEls(), function (el) {
      el.addEventListener("change", load);
      el.addEventListener("input", function () {
        clearTimeout(debounce);
        debounce = setTimeout(load, 400);
      });
    });
    // A draft resume rewrites the hidden value and fires `change` on it;
    // redraw so the restored ticks and prices appear.
    hidden.addEventListener("change", function () {
      if (packages) render();
    });
    load();
  }

  // ---- multi-site ---------------------------------------------------------
  // Each added site is a section with its own rows, a Remove button, and --
  // on every site after the first -- "Copy from {first site}", because a
  // regional rollout is usually the same change everywhere. Copying fills
  // ticks and all four prices; every box stays editable, and current prices
  // in particular should be checked, since they differ by site.
  function wireMultiSiteGrid(formEl, slug, wrap) {
    var fieldKey = wrap.getAttribute("data-field-key");
    var hidden = wrap.querySelector('[data-grid-value="1"]');
    var sitesEl = wrap.querySelector('[data-grid-sites="1"]');
    var addInput = wrap.querySelector("[data-grid-add-input]");
    var addBtn = wrap.querySelector("[data-grid-add-btn]");
    var addMsg = wrap.querySelector("[data-grid-add-msg]");
    if (!fieldKey || !hidden || !sitesEl || !addInput || !addBtn || !addMsg) return;

    var sections = []; // { site, siteName, label, el, rowsEl }
    var restoring = false;

    function serialize() {
      if (restoring) return; // don't overwrite a draft while it is rebuilt
      var out = sections.map(function (s) {
        return {
          site: s.site,
          rows: readPriceRows(s.rowsEl),
          new_packages: readNewPackages(s.npList),
          services: readServices(s.svList)
        };
      });
      hidden.value = out.length ? JSON.stringify(out) : "";
      // A Remove or Copy click fires no input event of its own, so autosave
      // (which listens on the form) would miss it. Nudge it.
      try { hidden.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
    }

    function refreshCopyButtons() {
      sections.forEach(function (s, i) {
        var btn = s.el.querySelector("[data-grid-copy]");
        if (!btn) return;
        btn.hidden = i === 0;
        if (i > 0) btn.textContent = "Copy from " + sections[0].label;
      });
      if (sections.length === 0) gridMessage(sitesEl, "No sites added yet.");
    }

    function copyFromFirst(target) {
      var first = sections[0];
      if (!first || first === target) return;
      var source = {};
      readPriceRows(first.rowsEl).forEach(function (r) { source[r.pkg] = r; });
      var rows = target.rowsEl.querySelectorAll(".price-grid-row");
      var missing = 0;
      Object.keys(source).forEach(function (pkg) {
        var hit = false;
        Array.prototype.forEach.call(rows, function (row) {
          if (row.getAttribute("data-pkg") !== pkg) return;
          hit = true;
          var r = source[pkg];
          [["cs", r.current_single], ["cm", r.current_monthly], ["ns", r.new_single], ["nm", r.new_monthly]]
            .forEach(function (pair) {
              var el = row.querySelector('[data-price="' + pair[0] + '"]');
              if (el) el.value = pair[1];
            });
          var rn = row.querySelector("[data-row-rename]");
          if (rn) rn.value = r.rename_to || "";
          setRowOn(row, true);
          setRowDiscontinued(row, !!r.discontinue);
          syncPlaceholders(row);
        });
        if (!hit) missing += 1;
      });
      // New packages and services are REPLACED, not appended: copying twice
      // must not double them.
      target.npList.innerHTML = "";
      readNewPackages(first.npList).forEach(function (p) {
        target.npList.appendChild(buildNewPackageItem(p, serialize));
      });
      target.svList.innerHTML = "";
      readServices(first.svList).forEach(function (s) {
        target.svList.appendChild(buildServiceItem(s, serialize));
      });
      var note = target.el.querySelector("[data-grid-copy-note]");
      if (note) {
        note.textContent = missing
          ? missing + " package(s) from " + first.label + " aren't sold here and were skipped. Check the current prices for this site."
          : "Copied. Check the current prices for this site.";
      }
      serialize();
    }

    function addSection(site, siteName, packages, priorRows, priorNew, priorServices) {
      if (sections.length === 0) sitesEl.innerHTML = "";
      var label = siteName ? siteName + " (" + site + ")" : site;
      var el = document.createElement("div");
      el.className = "price-grid-site";

      var head = document.createElement("div");
      head.className = "price-grid-site-head";
      var title = document.createElement("strong");
      title.textContent = label;
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "price-grid-link";
      copy.setAttribute("data-grid-copy", "1");
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "price-grid-link";
      remove.textContent = "Remove site";
      head.appendChild(title);
      head.appendChild(copy);
      head.appendChild(remove);
      el.appendChild(head);

      var note = document.createElement("p");
      note.className = "price-grid-hint";
      note.setAttribute("data-grid-copy-note", "1");
      el.appendChild(note);

      var rowsEl = document.createElement("div");
      el.appendChild(rowsEl);
      var prior = {};
      (priorRows || []).forEach(function (r) {
        if (r && typeof r.pkg === "string") prior[r.pkg] = r;
      });
      packages.forEach(function (pkg, i) {
        rowsEl.appendChild(
          buildPriceRow(fieldKey + "__" + site + "_pkg", i, pkg, prior[pkg], serialize)
        );
      });

      // New packages + lube/detail services: per site, each an add-list.
      function addList(title, addText, build, priors) {
        var h = document.createElement("p");
        h.className = "price-grid-subhead";
        h.textContent = title;
        var list = document.createElement("div");
        (priors || []).forEach(function (p) { list.appendChild(build(p, serialize)); });
        var add = document.createElement("button");
        add.type = "button";
        add.className = "price-grid-link";
        add.textContent = addText;
        add.addEventListener("click", function () {
          var item = build(null, serialize);
          list.appendChild(item);
          var first = item.querySelector("input, select");
          if (first) first.focus();
        });
        el.appendChild(h);
        el.appendChild(list);
        el.appendChild(add);
        return list;
      }
      var npList = addList("New packages", "+ Add new package", buildNewPackageItem, priorNew);
      var svList = addList("Lube & detail services", "+ Add lube/detail service", buildServiceItem, priorServices);

      var section = { site: site, siteName: siteName, label: label, el: el, rowsEl: rowsEl, npList: npList, svList: svList };
      copy.addEventListener("click", function () { copyFromFirst(section); });
      remove.addEventListener("click", function () {
        sections = sections.filter(function (s) { return s !== section; });
        if (el.parentNode) el.parentNode.removeChild(el);
        refreshCopyButtons();
        serialize();
      });
      sections.push(section);
      sitesEl.appendChild(el);
      refreshCopyButtons();
    }

    function setAddMsg(text) {
      addMsg.textContent = text || "";
      addMsg.hidden = !text;
    }

    function addTyped() {
      var typed = (addInput.value || "").trim();
      if (!typed) return;
      setAddMsg("Looking up site " + typed + "…");
      addBtn.disabled = true;
      fetchSitePackages(slug, fieldKey, typed)
        .then(function (j) {
          if (!j.packages.length || !j.site_name) {
            setAddMsg("Site " + typed + " isn't a known site. Check the number.");
            return;
          }
          var site = j.site || typed;
          var dup = sections.some(function (s) { return s.site === site; });
          if (dup) {
            setAddMsg(j.site_name + " (" + site + ") is already added.");
            return;
          }
          addSection(site, j.site_name, j.packages, null);
          addInput.value = "";
          setAddMsg("");
          serialize();
        })
        .catch(function () {
          setAddMsg("Couldn't look that site up. Please try again.");
        })
        .then(function () {
          addBtn.disabled = false;
        });
    }

    addBtn.addEventListener("click", addTyped);
    addInput.addEventListener("keydown", function (e) {
      // Enter would submit the whole form; here it means "add this site".
      if (e.key === "Enter") {
        e.preventDefault();
        addTyped();
      }
    });

    // Rebuild from the hidden value -- draft resume. Sites are looked up
    // again because the package list lives on the server, not in the draft.
    function rebuildFromHidden() {
      if (restoring) return;
      var saved = parseJsonArray(hidden.value).filter(function (s) {
        return s && typeof s.site === "string" && s.site;
      });
      if (!saved.length) return;
      restoring = true;
      sections.forEach(function (s) { if (s.el.parentNode) s.el.parentNode.removeChild(s.el); });
      sections = [];
      gridMessage(sitesEl, "Restoring sites…");
      var results = saved.map(function () { return null; });
      Promise.all(
        saved.map(function (s, i) {
          return fetchSitePackages(slug, fieldKey, s.site).then(
            function (j) { results[i] = j; },
            function () { results[i] = null; }
          );
        })
      ).then(function () {
        sitesEl.innerHTML = "";
        saved.forEach(function (s, i) {
          var j = results[i];
          // A site that no longer resolves is dropped rather than shown
          // empty; the rest of the draft still comes back.
          if (j && j.packages.length && j.site_name) {
            addSection(j.site || s.site, j.site_name, j.packages, s.rows, s.new_packages, s.services);
          }
        });
        restoring = false;
        refreshCopyButtons();
        serialize();
      });
    }
    hidden.addEventListener("change", rebuildFromHidden);

    setAddMsg("");
    if (hidden.value) rebuildFromHidden();
    else refreshCopyButtons();
  }

  // Mirror of packageLabel in packages/forms-schema/src/package-price.ts --
  // this file cannot import it. "college_bubble_bath" -> "College Bubble Bath".
  function packageLabel(code) {
    return String(code).split(/[_\s]+/).filter(Boolean).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function cssAttrEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

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
      try { console.warn("[forms.autosave] saveDraft failed", e); } catch (_) {}
    }
  }

  function clearDraft(slug) {
    try {
      window.localStorage.removeItem(DRAFT_KEY_PREFIX + slug);
    } catch (e) {
    }
  }

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
    formEl.addEventListener("input", scheduleSave);
    formEl.addEventListener("change", scheduleSave);
  }

  function maybeRenderResumeBanner(formEl, slug) {
    var draft = loadDraft(slug);
    if (!draft) return;
    var age = Date.now() - draft.savedAt;
    if (age < 0 || age > DRAFT_TTL_MS) {
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
