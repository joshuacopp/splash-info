// Splash Vehicle Damage Claim Worker
// - Public form for damage claims (no auth required)
// - Two sections: Customer fills first, Employee assessment after
// - Photos stored in R2, form data POSTed to Power Automate
// - R2 fallback on Power Automate failure

// ===================== CONFIGURATION =====================
const R2_BUCKET_NAME = "splash-vehicle-claims";
const POWER_AUTOMATE_URL = "https://defaultb06b330875fc4e6f87b706c658378b.1d.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/8d078c51066a4a9fb7d72d9515410751/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=iQ-71n7F1n7jngRxN8_Q6wviWbxL1ab_1kmZnJ7o7E8";

// Equipment choices for the form
const EQUIPMENT_CHOICES = [
  "Top Brush",
  "Side Wraps",
  "Conveyor",
  "Dryer",
  "Wheel Blaster",
  "Other",
  "N/A"
];

// Determination choices for the form
const DETERMINATION_CHOICES = [
  { value: "no_responsibility", label: "No Responsibility" },
  { value: "requires_gm_review", label: "Requires GM Review" },
  { value: "customer_get_quotes", label: "Requested Customer Get Quote(s)", managersOnly: true }
];

export default {
  async fetch(request, env, ctx) {
    return handle(request, env);
  }
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, "");
  const parts = path.split("/");

  // Routes:
  // /damage/{siteName} - Show the form
  // /api/submit-claim - Handle form submission

  if (path === "claims-api/submit-claim" && request.method === "POST") {
    return handleClaimSubmission(request, env);
  }

  // Serve photos from R2
  if (parts[0] === "claims-api" && parts[1] === "photo" && parts[2]) {
    const photoPath = parts.slice(2).join("/");
    return serveR2Photo(photoPath, env);
  }

  // Check for damage route
  if (parts[0] === "claims" && parts[1]) {
    const siteName = decodeURIComponent(parts[1]);
    return new Response(renderDamageForm(siteName), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  // Root or unknown route
  if (!path || path === "claims") {
    return new Response(renderLandingPage(), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  // /manage/* — manager interface (auth-gated)
  if (parts[0] === "manage") {
    return handleManageRoutes(request, env, parts);
  }

  return new Response("Not found", { status: 404 });
}

// ===================== FORM SUBMISSION HANDLER =====================

async function handleClaimSubmission(request, env) {
  try {
    const formData = await request.formData();
    
    // Extract all form fields
    const claimData = {
      // Customer info
      customerName: formData.get("customerName") || "",
      customerPhone: formData.get("customerPhone") || "",
      customerEmail: formData.get("customerEmail") || "",
      mailingAddress: formData.get("mailingAddress") || "",
      licensePlate: formData.get("licensePlate") || "",
      vehicleMake: formData.get("vehicleMake") || "",
      vehicleModel: formData.get("vehicleModel") || "",
      vehicleYear: formData.get("vehicleYear") || "",
      vehicleColor: formData.get("vehicleColor") || "",
      issueDescription: formData.get("issueDescription") || "",
      
      // Employee assessment
      employeeName: formData.get("employeeName") || "",
      location: formData.get("location") || "",
      locationPretty: formData.get("locationPretty") || "",
      membershipNumber: formData.get("membershipNumber") || "",
      preExistingDamage: formData.get("preExistingDamage") || "",
      equipmentInvolved: formData.get("equipmentInvolved") || "",
      equipmentMalfunction: formData.get("equipmentMalfunction") === "true",
      determination: formData.get("determination") || "",
      customerTold: formData.get("customerTold") || "",
      customerDemeanor: formData.get("customerDemeanor") || "",
      
      // Metadata
      submittedAt: new Date().toISOString(),
      ipAddress: request.headers.get("CF-Connecting-IP") || "Unknown",
      userAgent: request.headers.get("User-Agent") || "Unknown"
    };

    // Generate claim ID
    const claimId = generateClaimId(claimData.location);
    claimData.claimId = claimId;

    // Process and upload photos to R2
    const photoCategories = [
      { field: "fourCornersPhotos", type: "Vehicle Overview" },
      { field: "vinPhoto", type: "VIN" },
      { field: "damagePhotos", type: "Damage" },
      { field: "platePhoto", type: "License Plate" }
    ];

    const uploadedPhotos = [];

    for (const category of photoCategories) {
      const files = formData.getAll(category.field);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file && file.size > 0) {
          const uploadResult = await uploadToR2(file, claimId, category.type, i, env);
          if (uploadResult) {
            const { key, contentType, ext } = uploadResult;
            const sanitizedType = category.type.replace(/\s+/g, "_").toLowerCase();
            uploadedPhotos.push({
              r2Key: key,
              photoType: category.type,
              fileName: `${claimId}_${sanitizedType}_${i + 1}.${ext}`,
              fileSize: file.size,
              contentType
            });
          }
        }
      }
    }

    claimData.photos = uploadedPhotos;

    // Save full submission JSON to R2 unconditionally (permanent record regardless of downstream success)
    await saveSubmissionToR2(claimData, env);

    // Write to D1 (parallel record alongside SharePoint). Failures are logged but do not break the flow.
    let d1Success = false;
    try {
      await writeClaimToD1(claimData, env);
      d1Success = true;
    } catch (d1Error) {
      console.error("D1 write failed:", d1Error);
    }

    // POST to Power Automate (writes to SharePoint).
    let powerAutomateSuccess = false;
    if (POWER_AUTOMATE_URL) {
      try {
        const paResponse = await fetch(POWER_AUTOMATE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(claimData)
        });
        if (paResponse.ok) {
          powerAutomateSuccess = true;
        } else {
          console.error("Power Automate POST failed:", paResponse.status);
        }
      } catch (paError) {
        console.error("Power Automate POST error:", paError);
      }
    }
    if (!powerAutomateSuccess) {
      await saveFailedSubmission(claimData, env);
    }

    return new Response(JSON.stringify({
      success: true,
      claimId,
      powerAutomateSuccess,
      d1Success,
      photosUploaded: uploadedPhotos.length
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Claim submission error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// ==================== DATE FORMATTING ====================
function formatAbsoluteDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  } catch (e) {
    return iso;
  }
}

function formatAge(claim) {
  if (!claim.submitted_at) return null;
  const submitted = new Date(claim.submitted_at).getTime();
  const isClosed = claim.lifecycle_state === "Closed";

  // For closed claims, age = submitted_at to status_updated_at (best proxy for closure time)
  const endTime = isClosed && claim.status_updated_at
    ? new Date(claim.status_updated_at).getTime()
    : Date.now();

  const days = Math.floor((endTime - submitted) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;

  if (isClosed) {
    return days === 0 ? "Closed same day" : `Closed after ${days} day${days === 1 ? "" : "s"}`;
  } else {
    return days === 0 ? "Submitted today" : `Open for ${days} day${days === 1 ? "" : "s"}`;
  }
}
// ===================== R2 HELPERS =====================

function generateClaimId(location) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const locCode = (location || "UNK").substring(0, 3).toUpperCase();
  return `${locCode}-${dateStr}-${timeStr}-${random}`;
}

function isHeicFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return ext === "heic" || ext === "heif"
    || type === "image/heic" || type === "image/heif"
    || type === "image/heic-sequence" || type === "image/heif-sequence";
}

async function uploadToR2(file, claimId, photoType, index, env) {
  try {
    let ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const sanitizedType = photoType.replace(/\s+/g, "_").toLowerCase();

    let body;
    let contentType = file.type || "application/octet-stream";

    if (isHeicFile(file)) {
      try {
        const result = await env.IMAGES.input(file.stream()).output({ format: "image/jpeg" });
        body = await result.response().arrayBuffer();
        ext = "jpg";
        contentType = "image/jpeg";
      } catch (convErr) {
        console.error("HEIC->JPEG conversion failed for", file.name, convErr);
        body = await file.arrayBuffer();
      }
    } else {
      body = await file.arrayBuffer();
    }

    const key = `claims/${claimId}/${sanitizedType}_${index + 1}.${ext}`;

    await env.R2_BUCKET.put(key, body, {
      httpMetadata: { contentType },
      customMetadata: {
        claimId,
        photoType,
        originalName: file.name,
        uploadedAt: new Date().toISOString()
      }
    });

    return { key, contentType, ext };
  } catch (error) {
    console.error("R2 upload error:", error);
    return null;
  }
}

async function saveFailedSubmission(claimData, env) {
  try {
    const key = `failed_submissions/${claimData.claimId}.json`;
    await env.R2_BUCKET.put(key, JSON.stringify(claimData, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        failedAt: new Date().toISOString(),
        reason: "Power Automate POST failed"
      }
    });
    console.log("Saved failed submission to R2:", key);
  } catch (error) {
    console.error("Failed to save submission to R2:", error);
  }
}

// Save full submission JSON to R2 unconditionally (separate from saveFailedSubmission, which is PA-failure-specific)
async function saveSubmissionToR2(claimData, env) {
  try {
    const key = `submissions/${claimData.claimId}.json`;
    await env.R2_BUCKET.put(key, JSON.stringify(claimData, null, 2), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        savedAt: new Date().toISOString(),
        claimId: claimData.claimId
      }
    });
  } catch (error) {
    // Logged but not thrown — don't block the rest of the pipeline if R2 misbehaves
    console.error("Failed to save submission JSON to R2:", error);
  }
}

// Map form determination → initial claim_status (em-dash, U+2014). CHECK constraint will reject any mismatch.
function determinationToClaimStatus(determination) {
  switch (determination) {
    case "no_responsibility":  return "No Responsibility — Pending Review";
    case "requires_gm_review": return "Pending GM Review";
    case "customer_get_quotes":return "Approved — Pending Quotes";
    default:                   return "New — Pending Review";
  }
}

// Write claim + photos + initial activity row to D1. Throws on failure so caller can log and continue.
async function writeClaimToD1(claimData, env) {
  if (!env.DB) {
    throw new Error("D1 binding 'DB' not available");
  }

  // Resolve location_pretty from D1 locations table (do not trust form value).
  // location_code on the form is the URL slug, e.g. 'binghamton'.
  const locationCode = (claimData.location || "").toLowerCase();
  let locationPretty = claimData.locationPretty || locationCode;

  if (locationCode) {
    try {
      const locRow = await env.DB
        .prepare("SELECT location_pretty FROM locations WHERE location_code = ? AND is_active = 1")
        .bind(locationCode)
        .first();
      if (locRow && locRow.location_pretty) {
        locationPretty = locRow.location_pretty;
        // Overwrite on claimData so SharePoint sees the canonical value too
        claimData.locationPretty = locationPretty;
      } else {
        console.warn("Location not found in D1 locations table:", locationCode);
      }
    } catch (lookupErr) {
      console.warn("D1 location lookup failed, using form value:", lookupErr);
    }
  }

  // Field derivations
  const phoneDigits = (claimData.customerPhone || "").replace(/\D/g, "") || null;

  const yearInt = claimData.vehicleYear && /^\d+$/.test(String(claimData.vehicleYear).trim())
    ? parseInt(String(claimData.vehicleYear).trim(), 10)
    : null;

  const equipmentInvolved = claimData.equipmentInvolved || null;
  const equipmentRelated = (equipmentInvolved && equipmentInvolved !== "N/A") ? 1 : 0;

  const staffNotesParts = [];
  if (claimData.customerTold && claimData.customerTold.trim()) {
    staffNotesParts.push(`Told customer: ${claimData.customerTold.trim()}`);
  }
  if (claimData.customerDemeanor && claimData.customerDemeanor.trim()) {
    staffNotesParts.push(`Customer demeanor: ${claimData.customerDemeanor.trim()}`);
  }
  const staffNotes = staffNotesParts.length > 0 ? staffNotesParts.join("\n\n") : null;

  const initialStatus = determinationToClaimStatus(claimData.determination);
  const submittedBy = claimData.employeeName || "Unknown";

  // Insert claim row
  const claimInsert = env.DB.prepare(`
    INSERT INTO claims (
      claim_id,
      location_code,
      location_pretty,
      customer_name,
      customer_phone,
      customer_email,
      customer_mailing_address,
      vehicle_year,
      vehicle_make,
      vehicle_model,
      vehicle_color,
      license_plate,
      damage_description,
      preexisting_damage,
      staff_notes,
      determination,
      submitted_by,
      equipment_related,
      equipment_piece,
      lifecycle_state,
      claim_status,
      status_updated_by,
      submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?)
  `).bind(
    claimData.claimId,
    locationCode,
    locationPretty,
    claimData.customerName || "",
    phoneDigits,
    claimData.customerEmail || null,
    claimData.mailingAddress || null,
    yearInt,
    claimData.vehicleMake || null,
    claimData.vehicleModel || null,
    claimData.vehicleColor || null,
    claimData.licensePlate || null,
    claimData.issueDescription || null,
    claimData.preExistingDamage || null,
    staffNotes,
    claimData.determination || null,
    submittedBy,
    equipmentRelated,
    equipmentInvolved,
    initialStatus,
    submittedBy,
    claimData.submittedAt
  );

  // Insert photo rows
  const photoStmt = env.DB.prepare(`
    INSERT INTO claim_photos (
      claim_id, photo_type, filename, r2_key, content_type, size_bytes, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const photoInserts = (claimData.photos || []).map(p =>
    photoStmt.bind(
      claimData.claimId,
      p.photoType,
      p.fileName,
      p.r2Key,
      p.contentType || null,
      p.fileSize || null,
      submittedBy
    )
  );

  // Insert initial activity row
  const activityInsert = env.DB.prepare(`
    INSERT INTO claim_activity (
      claim_id, activity_type, status_from, status_to, notes, actor_name
    ) VALUES (?, 'status_change', NULL, ?, 'Initial submission', ?)
  `).bind(claimData.claimId, initialStatus, submittedBy);

  // Run as a batch (D1 batches are atomic per-statement but not transactional across the batch;
  // for our purposes that's acceptable — partial writes are recoverable from the R2 submission JSON).
  await env.DB.batch([claimInsert, ...photoInserts, activityInsert]);
}

// ===================== RENDER FUNCTIONS =====================

function renderLandingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
  <title>Splash Car Wash - Vehicle Issue Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { overflow: hidden; height: 100%; width: 100%; position: fixed; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
      height: 100%; width: 100%; margin: 0; padding: 0;
      overflow: hidden; position: fixed;
    }
    .scroll-wrapper {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: 20px; display: flex; justify-content: center; align-items: center;
    }
    .bubble {
      position: absolute; bottom: -100px;
      background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
      border-radius: 50%; opacity: 0.6;
      animation: rise linear infinite;
      box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.5), 0 0 20px rgba(255, 255, 255, 0.3);
      pointer-events: none; z-index: 1;
    }
    .bubble::before {
      content: ''; position: absolute; top: 10%; left: 10%;
      width: 40%; height: 40%;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.9), transparent);
      border-radius: 50%;
    }
    @keyframes rise {
      0% { bottom: -100px; transform: translateX(0) scale(1); }
      50% { transform: translateX(100px) scale(1.1); }
      100% { bottom: 110vh; transform: translateX(-100px) scale(0.8); }
    }
    .bubble:nth-child(1) { left: 10%; width: 60px; height: 60px; animation-duration: 8s; animation-delay: 0s; }
    .bubble:nth-child(2) { left: 20%; width: 40px; height: 40px; animation-duration: 6s; animation-delay: 1s; }
    .bubble:nth-child(3) { left: 35%; width: 80px; height: 80px; animation-duration: 10s; animation-delay: 2s; }
    .bubble:nth-child(4) { left: 50%; width: 50px; height: 50px; animation-duration: 7s; animation-delay: 0.5s; }
    .bubble:nth-child(5) { left: 65%; width: 70px; height: 70px; animation-duration: 9s; animation-delay: 1.5s; }
    .bubble:nth-child(6) { left: 80%; width: 45px; height: 45px; animation-duration: 6.5s; animation-delay: 0.8s; }
    .container {
      max-width: 500px; width: 100%; background: white;
      border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden; position: relative; z-index: 10; text-align: center;
      padding: 40px 30px;
    }
    .logo { max-width: 200px; height: auto; margin-bottom: 30px; }
    h1 { color: #1e3a8a; font-size: 28px; margin-bottom: 15px; }
    p { color: #64748b; font-size: 16px; line-height: 1.6; }
    .info-box {
      background: #fef3c7; border: 2px solid #fbbf24;
      border-radius: 12px; padding: 20px; margin-top: 30px; text-align: left;
    }
    .info-box h3 { color: #92400e; margin-bottom: 10px; }
    .info-box p { color: #78350f; font-size: 14px; margin: 0; }
  </style>
</head>
<body>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>

  <div class="scroll-wrapper">
    <div class="container">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full (1) 1.png" alt="Splash Car Wash" class="logo">
      <h1>Vehicle Issue Report</h1>
      <p>This form should be accessed from a location-specific URL provided by your site manager.</p>
      <div class="info-box">
        <h3>📋 For Splash Staff</h3>
        <p>Use the bookmarked link on your site tablet to access the form for your location.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderDamageForm(siteName) {
  const escHtml = s => String(s ?? "").replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  
  // Convert siteName to display format (e.g., "bedford-wash" -> "Bedford Wash")
  const locationPretty = siteName
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  const equipmentOptions = EQUIPMENT_CHOICES.map(eq => 
    `<option value="${escHtml(eq)}">${escHtml(eq)}</option>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
  <title>Vehicle Issue Report - ${escHtml(locationPretty)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { overflow: hidden; height: 100%; width: 100%; position: fixed; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(to bottom, #e0f2fe 0%, #bae6fd 100%);
      height: 100%; width: 100%; margin: 0; padding: 0;
      overflow: hidden; position: fixed;
    }
    .scroll-wrapper {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      overflow-y: auto; overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: 20px; display: flex; justify-content: center; align-items: flex-start;
    }
    
    /* Bubbles */
    .bubble {
      position: absolute; bottom: -100px;
      background: radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.3));
      border-radius: 50%; opacity: 0.6;
      animation: rise linear infinite;
      box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.5), 0 0 20px rgba(255, 255, 255, 0.3);
      pointer-events: none; z-index: 1;
    }
    .bubble::before {
      content: ''; position: absolute; top: 10%; left: 10%;
      width: 40%; height: 40%;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.9), transparent);
      border-radius: 50%;
    }
    @keyframes rise {
      0% { bottom: -100px; transform: translateX(0) scale(1); }
      50% { transform: translateX(100px) scale(1.1); }
      100% { bottom: 110vh; transform: translateX(-100px) scale(0.8); }
    }
    .bubble:nth-child(1) { left: 10%; width: 60px; height: 60px; animation-duration: 8s; animation-delay: 0s; }
    .bubble:nth-child(2) { left: 20%; width: 40px; height: 40px; animation-duration: 6s; animation-delay: 1s; }
    .bubble:nth-child(3) { left: 35%; width: 80px; height: 80px; animation-duration: 10s; animation-delay: 2s; }
    .bubble:nth-child(4) { left: 50%; width: 50px; height: 50px; animation-duration: 7s; animation-delay: 0.5s; }
    .bubble:nth-child(5) { left: 65%; width: 70px; height: 70px; animation-duration: 9s; animation-delay: 1.5s; }
    .bubble:nth-child(6) { left: 80%; width: 45px; height: 45px; animation-duration: 6.5s; animation-delay: 0.8s; }
    .bubble:nth-child(7) { left: 15%; width: 55px; height: 55px; animation-duration: 8.5s; animation-delay: 2.5s; }
    .bubble:nth-child(8) { left: 75%; width: 35px; height: 35px; animation-duration: 7.5s; animation-delay: 1.2s; }
    .bubble:nth-child(9) { left: 40%; width: 65px; height: 65px; animation-duration: 9.5s; animation-delay: 0.3s; }
    .bubble:nth-child(10) { left: 90%; width: 50px; height: 50px; animation-duration: 8s; animation-delay: 2s; }

    .container {
      max-width: 700px; width: 100%; background: white;
      border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden; position: relative; z-index: 10;
      margin-bottom: 40px;
    }
    
    .header {
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      padding: 30px 20px; text-align: center;
    }
    .logo { max-width: 200px; height: auto; margin-bottom: 10px; }
    .location-title { color: white; font-size: 24px; font-weight: bold; margin-top: 15px; }
    .form-type { color: rgba(255,255,255,0.9); font-size: 16px; margin-top: 8px; }
    
    /* Section styling */
    .section {
      padding: 25px 20px;
      border-bottom: 1px solid #e2e8f0;
    }
    .section:last-child { border-bottom: none; }
    
    .section-header {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 20px; padding-bottom: 15px;
      border-bottom: 2px solid #e2e8f0;
    }
    .section-number {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      color: white; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: bold; font-size: 18px; flex-shrink: 0;
    }
    .section-title { color: #1e3a8a; font-size: 20px; font-weight: 700; }
    .section-subtitle { color: #64748b; font-size: 14px; margin-top: 2px; }
    
    /* Employee section has different styling */
    .employee-section .section-header { border-bottom-color: #fbbf24; }
    .employee-section .section-number { background: linear-gradient(135deg, #d97706 0%, #f59e0b 100%); }
    .employee-section .section-title { color: #92400e; }
    .employee-warning {
      background: #fef3c7; border: 2px solid #fbbf24;
      border-radius: 8px; padding: 12px 16px;
      margin-bottom: 20px; display: flex; align-items: center; gap: 10px;
    }
    .employee-warning-icon { font-size: 24px; }
    .employee-warning-text { color: #78350f; font-size: 14px; font-weight: 600; }
    
    /* Form elements */
    .form-group { margin-bottom: 20px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 500px) { .form-row { grid-template-columns: 1fr; } }
    
    label {
      display: block; font-weight: 600; color: #334155;
      margin-bottom: 8px; font-size: 14px;
    }
    .required { color: #dc2626; }
    .label-hint { font-weight: 400; color: #64748b; font-size: 12px; display: block; margin-top: 2px; }
    
    input[type="text"],
    input[type="tel"],
    input[type="email"],
    input[type="number"],
    select,
    textarea {
      width: 100%; padding: 14px 16px; font-size: 16px;
      border: 2px solid #e2e8f0; border-radius: 8px;
      transition: all 0.3s ease; font-family: inherit;
      background: white;
    }
    input:focus, select:focus, textarea:focus {
      outline: none; border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
    input.error, select.error, textarea.error { border-color: #dc2626; }
    
    textarea { resize: vertical; min-height: 100px; }
    
    .error-message {
      color: #dc2626; font-size: 13px; margin-top: 6px; display: none;
    }
    .error-message.show { display: block; }
    
    /* File upload styling */
    .file-upload-area {
      border: 2px dashed #cbd5e1; border-radius: 12px;
      padding: 30px 20px; text-align: center;
      background: #f8fafc; cursor: pointer;
      transition: all 0.3s ease;
    }
    .file-upload-area:hover { border-color: #3b82f6; background: #eff6ff; }
    .file-upload-area.dragover { border-color: #3b82f6; background: #dbeafe; }
    .file-upload-area.has-files { border-color: #22c55e; background: #f0fdf4; }
    
    .file-upload-icon { font-size: 48px; margin-bottom: 12px; }
    .file-upload-text { color: #64748b; font-size: 14px; }
    .file-upload-text strong { color: #3b82f6; }
    .file-upload-hint { color: #94a3b8; font-size: 12px; margin-top: 8px; }
    
    .file-input { display: none; }
    
    .file-preview {
      display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px;
    }
    .file-preview-item {
      position: relative; width: 80px; height: 80px;
      border-radius: 8px; overflow: hidden;
      border: 2px solid #e2e8f0;
    }
    .file-preview-item img {
      width: 100%; height: 100%; object-fit: cover;
    }
    .file-preview-remove {
      position: absolute; top: -8px; right: -8px;
      width: 24px; height: 24px; background: #ef4444;
      color: white; border: none; border-radius: 50%;
      cursor: pointer; font-size: 14px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    }
    .file-count {
      background: #e0f2fe; color: #0369a1;
      padding: 8px 16px; border-radius: 20px;
      font-size: 14px; font-weight: 600; margin-top: 10px;
      display: inline-block;
    }
    
    /* Radio/Checkbox styling */
    .radio-group { display: flex; flex-direction: column; gap: 10px; }
    .radio-option {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 14px 16px; border: 2px solid #e2e8f0;
      border-radius: 10px; cursor: pointer;
      transition: all 0.2s ease;
    }
    .radio-option:hover { border-color: #3b82f6; background: #f8fafc; }
    .radio-option.selected { border-color: #3b82f6; background: #eff6ff; }
    .radio-option input { margin-top: 2px; width: 20px; height: 20px; cursor: pointer; }
    .radio-label { font-size: 15px; color: #334155; font-weight: 500; }
    .radio-hint { font-size: 12px; color: #64748b; margin-top: 2px; }
    .managers-only-badge {
      background: #fef3c7; color: #92400e;
      font-size: 10px; font-weight: 700;
      padding: 2px 8px; border-radius: 10px;
      margin-left: 8px; text-transform: uppercase;
    }
    
    /* Toggle switch */
    .toggle-container {
      display: flex; align-items: center; gap: 12px;
      padding: 14px 16px; background: #f8fafc;
      border-radius: 10px; border: 2px solid #e2e8f0;
    }
    .toggle-switch {
      position: relative; width: 52px; height: 28px;
      background: #cbd5e1; border-radius: 14px;
      cursor: pointer; transition: background 0.3s ease;
      flex-shrink: 0;
    }
    .toggle-switch.active { background: #22c55e; }
    .toggle-switch::after {
      content: ''; position: absolute;
      top: 3px; left: 3px; width: 22px; height: 22px;
      background: white; border-radius: 50%;
      transition: transform 0.3s ease;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .toggle-switch.active::after { transform: translateX(24px); }
    .toggle-label { font-size: 15px; color: #334155; }
    
    /* Navigation buttons */
    .nav-buttons {
      display: flex; gap: 12px; margin-top: 25px;
      padding-top: 20px; border-top: 1px solid #e2e8f0;
    }
    .btn {
      flex: 1; padding: 16px; font-size: 16px;
      font-weight: bold; border: none; border-radius: 10px;
      cursor: pointer; transition: all 0.3s ease;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .btn-secondary {
      background: #e2e8f0; color: #475569;
    }
    .btn-secondary:hover { background: #cbd5e1; }
    .btn-primary {
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);
      color: white;
    }
    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(59, 130, 246, 0.3);
    }
    .btn-primary:disabled { background: #cbd5e1; cursor: not-allowed; opacity: 0.6; }
    .btn-submit {
      background: linear-gradient(135deg, #059669 0%, #10b981 100%);
      color: white;
    }
    .btn-submit:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(16, 185, 129, 0.3);
    }
    
    /* Section visibility */
    .section.hidden { display: none; }
    
    /* Progress indicator */
    .progress-bar {
      display: flex; justify-content: center; gap: 8px;
      padding: 20px; background: #f8fafc;
    }
    .progress-step {
      width: 12px; height: 12px; border-radius: 50%;
      background: #cbd5e1; transition: all 0.3s ease;
    }
    .progress-step.active { background: #3b82f6; transform: scale(1.2); }
    .progress-step.complete { background: #22c55e; }
  </style>
</head>
<body>
  <!-- Animated bubbles -->
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>
  <div class="bubble"></div>

  <div class="scroll-wrapper">
    <div class="container">
      <div class="header">
        <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/Splash_logo_full (1) 1.png" alt="Splash Car Wash" class="logo">
        <div class="location-title">${escHtml(locationPretty)}</div>
        <div class="form-type">Vehicle Issue Report</div>
      </div>
      
      <div class="progress-bar">
        <div class="progress-step active" data-step="1"></div>
        <div class="progress-step" data-step="2"></div>
      </div>

      <form id="damageForm" enctype="multipart/form-data">
        <!-- Hidden location fields -->
        <input type="hidden" name="location" value="${escHtml(siteName)}">
        <input type="hidden" name="locationPretty" value="${escHtml(locationPretty)}">
        
        <!-- ==================== SECTION 1: CUSTOMER INFO ==================== -->
        <div class="section customer-section" id="section1">
          <div class="section-header">
            <div class="section-number">1</div>
            <div>
              <div class="section-title">Customer Information</div>
              <div class="section-subtitle">Please provide your contact and vehicle details</div>
            </div>
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label for="customerName">Your Name <span class="required">*</span></label>
              <input type="text" id="customerName" name="customerName" required autocomplete="name">
              <div class="error-message" id="customerNameError">Please enter your name</div>
            </div>
            <div class="form-group">
              <label for="customerPhone">Phone Number <span class="required">*</span></label>
              <input type="tel" id="customerPhone" name="customerPhone" placeholder="(555) 555-5555" required autocomplete="tel">
              <div class="error-message" id="customerPhoneError">Please enter a valid phone number</div>
            </div>
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label for="customerEmail">Email Address</label>
              <input type="email" id="customerEmail" name="customerEmail" autocomplete="email">
            </div>
            <div class="form-group">
              <label for="mailingAddress">Mailing Address <span class="required">*</span>
                <span class="label-hint">Required for payment if claim is approved</span>
              </label>
              <input type="text" id="mailingAddress" name="mailingAddress" required autocomplete="street-address">
              <div class="error-message" id="mailingAddressError">Please enter your mailing address</div>
            </div>
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label for="licensePlate">License Plate <span class="required">*</span></label>
              <input type="text" id="licensePlate" name="licensePlate" required style="text-transform: uppercase;">
              <div class="error-message" id="licensePlateError">Please enter your license plate</div>
            </div>
            <div class="form-group">
              <label for="vehicleYear">Vehicle Year <span class="required">*</span></label>
              <input type="number" id="vehicleYear" name="vehicleYear" min="1900" max="2030" required>
              <div class="error-message" id="vehicleYearError">Please enter a valid year</div>
            </div>
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label for="vehicleMake">Vehicle Make <span class="required">*</span></label>
              <input type="text" id="vehicleMake" name="vehicleMake" placeholder="e.g., Toyota" required>
              <div class="error-message" id="vehicleMakeError">Please enter the vehicle make</div>
            </div>
            <div class="form-group">
              <label for="vehicleModel">Vehicle Model <span class="required">*</span></label>
              <input type="text" id="vehicleModel" name="vehicleModel" placeholder="e.g., Camry" required>
              <div class="error-message" id="vehicleModelError">Please enter the vehicle model</div>
            </div>
          </div>
          
          <div class="form-group">
            <label for="vehicleColor">Vehicle Color <span class="required">*</span></label>
            <input type="text" id="vehicleColor" name="vehicleColor" required>
            <div class="error-message" id="vehicleColorError">Please enter the vehicle color</div>
          </div>
          
          <div class="form-group">
            <label for="issueDescription">Description of Issue <span class="required">*</span>
              <span class="label-hint">Please describe what happened in your own words</span>
            </label>
            <textarea id="issueDescription" name="issueDescription" required 
              placeholder="Please describe the issue you experienced..."></textarea>
            <div class="error-message" id="issueDescriptionError">Please describe the issue</div>
          </div>
          
          <div class="nav-buttons">
            <button type="button" class="btn btn-primary" onclick="goToSection(2)">
              Continue to Staff Section →
            </button>
          </div>
        </div>

        <!-- ==================== SECTION 2: EMPLOYEE ASSESSMENT ==================== -->
        <div class="section employee-section hidden" id="section2">
          <div class="section-header">
            <div class="section-number">2</div>
            <div>
              <div class="section-title">Staff Assessment</div>
              <div class="section-subtitle">For Splash employees only</div>
            </div>
          </div>
          
          <div class="employee-warning">
            <span class="employee-warning-icon">⚠️</span>
            <span class="employee-warning-text">This section is for Splash staff only. Please hand the tablet to an employee.</span>
          </div>
          
          <div class="form-row">
            <div class="form-group">
              <label for="employeeName">Employee Name <span class="required">*</span></label>
              <input type="text" id="employeeName" name="employeeName" required>
              <div class="error-message" id="employeeNameError">Please enter your name</div>
            </div>
            <div class="form-group">
              <label for="membershipNumber">Membership/Barcode Number
                <span class="label-hint">If customer is a member</span>
              </label>
              <input type="text" id="membershipNumber" name="membershipNumber">
            </div>
          </div>
          
          <!-- Photo Uploads -->
          <div class="form-group">
            <label>Four Corners / Full Vehicle Photos <span class="required">*</span>
              <span class="label-hint">Photos of all four corners showing overall vehicle condition</span>
            </label>
            <div class="file-upload-area" data-input="fourCornersPhotos">
              <div class="file-upload-icon">📷</div>
              <div class="file-upload-text"><strong>Tap to take photos</strong> or select from gallery</div>
              <div class="file-upload-hint">Take photos of front, back, and both sides</div>
            </div>
            <input type="file" class="file-input" id="fourCornersPhotos" name="fourCornersPhotos" 
              accept="image/*,video/*" multiple capture="environment">
            <div class="file-preview" id="fourCornersPhotos-preview"></div>
            <div class="error-message" id="fourCornersPhotosError">Please upload vehicle photos</div>
          </div>
          
          <div class="form-group">
            <label>Photo of VIN Number <span class="required">*</span>
              <span class="label-hint">Usually on driver's side dashboard or door jamb</span>
            </label>
            <div class="file-upload-area" data-input="vinPhoto">
              <div class="file-upload-icon">🔢</div>
              <div class="file-upload-text"><strong>Tap to take photo</strong> of VIN</div>
              <div class="file-upload-hint">Ensure VIN is clearly readable</div>
            </div>
            <input type="file" class="file-input" id="vinPhoto" name="vinPhoto" 
              accept="image/*" capture="environment">
            <div class="file-preview" id="vinPhoto-preview"></div>
            <div class="error-message" id="vinPhotoError">Please upload VIN photo</div>
          </div>
          
          <div class="form-group">
            <label>Detailed Photos of Damage <span class="required">*</span>
              <span class="label-hint">Close-up photos and/or video of the damage (up to 10)</span>
            </label>
            <div class="file-upload-area" data-input="damagePhotos">
              <div class="file-upload-icon">🔍</div>
              <div class="file-upload-text"><strong>Tap to take photos</strong> of damage</div>
              <div class="file-upload-hint">Get close-up shots of all damage areas</div>
            </div>
            <input type="file" class="file-input" id="damagePhotos" name="damagePhotos" 
              accept="image/*,video/*" multiple capture="environment">
            <div class="file-preview" id="damagePhotos-preview"></div>
            <div class="error-message" id="damagePhotosError">Please upload damage photos</div>
          </div>
          
          <div class="form-group">
            <label>Photo of License Plate/Tag <span class="required">*</span></label>
            <div class="file-upload-area" data-input="platePhoto">
              <div class="file-upload-icon">🚗</div>
              <div class="file-upload-text"><strong>Tap to take photo</strong> of plate</div>
              <div class="file-upload-hint">Ensure plate number is clearly visible</div>
            </div>
            <input type="file" class="file-input" id="platePhoto" name="platePhoto" 
              accept="image/*" capture="environment">
            <div class="file-preview" id="platePhoto-preview"></div>
            <div class="error-message" id="platePhotoError">Please upload plate photo</div>
          </div>
          
          <div class="form-group">
            <label for="preExistingDamage">Pre-Existing Damage Noted
              <span class="label-hint">Describe any damage visible before the wash</span>
            </label>
            <textarea id="preExistingDamage" name="preExistingDamage" 
              placeholder="e.g., Scratch on rear bumper, dent on driver door..."></textarea>
          </div>
          
          <div class="form-group">
            <label for="equipmentInvolved">Equipment Involved <span class="required">*</span></label>
            <select id="equipmentInvolved" name="equipmentInvolved" required>
              <option value="">Select equipment...</option>
              ${equipmentOptions}
            </select>
            <div class="error-message" id="equipmentInvolvedError">Please select equipment</div>
          </div>
          
          <div class="form-group">
            <label>Equipment Malfunction?</label>
            <div class="toggle-container">
              <div class="toggle-switch" id="malfunctionToggle" onclick="toggleMalfunction()"></div>
              <span class="toggle-label">Was there an equipment malfunction?</span>
            </div>
            <input type="hidden" id="equipmentMalfunction" name="equipmentMalfunction" value="false">
          </div>
          
          <div class="form-group">
            <label>Determination <span class="required">*</span></label>
            <div class="radio-group">
              <label class="radio-option">
                <input type="radio" name="determination" value="no_responsibility" required>
                <div>
                  <div class="radio-label">No Responsibility</div>
                  <div class="radio-hint">Damage is pre-existing or not caused by the wash</div>
                </div>
              </label>
              <label class="radio-option">
                <input type="radio" name="determination" value="requires_gm_review" required>
                <div>
                  <div class="radio-label">Requires GM Review</div>
                  <div class="radio-hint">Needs General Manager evaluation</div>
                </div>
              </label>
              <label class="radio-option">
                <input type="radio" name="determination" value="customer_get_quotes" required>
                <div>
                  <div class="radio-label">Requested Customer Get Quote(s)
                    <span class="managers-only-badge">Managers Only</span>
                  </div>
                  <div class="radio-hint">Customer will obtain repair estimates</div>
                </div>
              </label>
            </div>
            <div class="error-message" id="determinationError">Please select a determination</div>
          </div>
          
          <div class="form-group">
            <label for="customerTold">What Was the Customer Told? <span class="required">*</span>
              <span class="label-hint">Document exactly what you communicated to the customer</span>
            </label>
            <textarea id="customerTold" name="customerTold" required
              placeholder="e.g., Explained that a manager will review and contact them within 48 hours..."></textarea>
            <div class="error-message" id="customerToldError">Please describe what you told the customer</div>
          </div>
          
          <div class="form-group">
            <label for="customerDemeanor">Notes on Customer Interaction and Demeanor
              <span class="label-hint">Optional but helpful for claim review</span>
            </label>
            <textarea id="customerDemeanor" name="customerDemeanor"
              placeholder="e.g., Customer was calm and understanding, or Customer was upset and demanded immediate resolution..."></textarea>
          </div>
          
          <div class="nav-buttons">
            <button type="button" class="btn btn-secondary" onclick="goToSection(1)">
              ← Back
            </button>
            <button type="submit" class="btn btn-submit" id="submitBtn">
              Submit Claim
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>

  <script>
    // ==================== NAVIGATION ====================
    let currentSection = 1;
    let staffUnlocked = false;

    async function goToSection(section) {
      // Validate current section before moving forward
      if (section > currentSection && !validateSection(currentSection)) {
        return;
      }

      // Staff password gate for Section 2
      if (section === 2 && currentSection === 1 && !staffUnlocked) {
        const ok = await promptForStaffPassword();
        if (!ok) return;
        staffUnlocked = true;
      }

      // Hide all sections
      document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
      
      // Show target section
      document.getElementById('section' + section).classList.remove('hidden');
      
      // Update progress
      document.querySelectorAll('.progress-step').forEach((step, i) => {
        step.classList.remove('active', 'complete');
        if (i + 1 < section) step.classList.add('complete');
        if (i + 1 === section) step.classList.add('active');
      });
      
      currentSection = section;
      
      // Scroll to top
      document.querySelector('.scroll-wrapper').scrollTop = 0;
    }
    
    // ==================== VALIDATION ====================
    function validateSection(section) {
      let isValid = true;
      const fieldsToValidate = section === 1 ? [
        'customerName', 'customerPhone', 'mailingAddress', 'licensePlate',
        'vehicleYear', 'vehicleMake', 'vehicleModel', 'vehicleColor', 'issueDescription'
      ] : [
        'employeeName', 'equipmentInvolved', 'customerTold'
      ];
      
      fieldsToValidate.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        const error = document.getElementById(fieldId + 'Error');
        
        if (field && !field.value.trim()) {
          field.classList.add('error');
          if (error) error.classList.add('show');
          isValid = false;
        } else if (field) {
          field.classList.remove('error');
          if (error) error.classList.remove('show');
        }
      });
      
      // Phone validation
      if (section === 1) {
        const phone = document.getElementById('customerPhone');
        const digits = phone.value.replace(/\\D/g, '');
        if (digits.length < 10) {
          phone.classList.add('error');
          document.getElementById('customerPhoneError').classList.add('show');
          isValid = false;
        }
      }
      
      // Photo validation for section 2
      if (section === 2) {
        const photoFields = ['fourCornersPhotos', 'vinPhoto', 'damagePhotos', 'platePhoto'];
        photoFields.forEach(fieldId => {
          const input = document.getElementById(fieldId);
          const error = document.getElementById(fieldId + 'Error');
          if (!input.files || input.files.length === 0) {
            if (error) error.classList.add('show');
            isValid = false;
          } else {
            if (error) error.classList.remove('show');
          }
        });
        
        // Determination validation
        const determination = document.querySelector('input[name="determination"]:checked');
        if (!determination) {
          document.getElementById('determinationError').classList.add('show');
          isValid = false;
        } else {
          document.getElementById('determinationError').classList.remove('show');
        }
      }
      
      return isValid;
    }
    
    // ==================== PHONE FORMATTING ====================
    const phoneInput = document.getElementById('customerPhone');
    phoneInput.addEventListener('input', function(e) {
      let value = e.target.value.replace(/\\D/g, '');
      if (value.length > 10) value = value.slice(0, 10);
      
      let formatted = '';
      if (value.length > 0) formatted = '(' + value.substring(0, 3);
      if (value.length >= 4) formatted += ') ' + value.substring(3, 6);
      if (value.length >= 7) formatted += '-' + value.substring(6, 10);
      
      e.target.value = formatted;
    });
    
    // ==================== FILE UPLOAD HANDLING ====================
    document.querySelectorAll('.file-upload-area').forEach(area => {
      const inputId = area.getAttribute('data-input');
      const input = document.getElementById(inputId);
      
      area.addEventListener('click', () => input.click());
      
      area.addEventListener('dragover', (e) => {
        e.preventDefault();
        area.classList.add('dragover');
      });
      
      area.addEventListener('dragleave', () => {
        area.classList.remove('dragover');
      });
      
      area.addEventListener('drop', (e) => {
        e.preventDefault();
        area.classList.remove('dragover');
        input.files = e.dataTransfer.files;
        updateFilePreview(inputId);
      });
      
      input.addEventListener('change', () => updateFilePreview(inputId));
    });
    
    function updateFilePreview(inputId) {
      const input = document.getElementById(inputId);
      const preview = document.getElementById(inputId + '-preview');
      const area = document.querySelector('[data-input="' + inputId + '"]');
      const error = document.getElementById(inputId + 'Error');
      
      preview.innerHTML = '';
      
      if (input.files && input.files.length > 0) {
        area.classList.add('has-files');
        if (error) error.classList.remove('show');
        
        Array.from(input.files).forEach((file, index) => {
          if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (e) => {
              const item = document.createElement('div');
              item.className = 'file-preview-item';
              item.innerHTML = '<img src="' + e.target.result + '" alt="Preview">' +
                '<button type="button" class="file-preview-remove" onclick="removeFile(\\'' + inputId + '\\', ' + index + ')">×</button>';
              preview.appendChild(item);
            };
            reader.readAsDataURL(file);
          }
        });
        
        const count = document.createElement('div');
        count.className = 'file-count';
        count.textContent = input.files.length + ' file' + (input.files.length > 1 ? 's' : '') + ' selected';
        preview.appendChild(count);
      } else {
        area.classList.remove('has-files');
      }
    }
    
    function removeFile(inputId, index) {
      const input = document.getElementById(inputId);
      const dt = new DataTransfer();
      
      Array.from(input.files).forEach((file, i) => {
        if (i !== index) dt.items.add(file);
      });
      
      input.files = dt.files;
      updateFilePreview(inputId);
    }
    
    // ==================== TOGGLE HANDLING ====================
    function toggleMalfunction() {
      const toggle = document.getElementById('malfunctionToggle');
      const input = document.getElementById('equipmentMalfunction');
      
      toggle.classList.toggle('active');
      input.value = toggle.classList.contains('active') ? 'true' : 'false';
    }
    
    // ==================== RADIO SELECTION STYLING ====================
    document.querySelectorAll('.radio-option input').forEach(radio => {
      radio.addEventListener('change', function() {
        document.querySelectorAll('.radio-option').forEach(opt => opt.classList.remove('selected'));
        this.closest('.radio-option').classList.add('selected');
      });
    });
    
    // ==================== FORM SUBMISSION ====================
    document.getElementById('damageForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      
      if (!validateSection(2)) return;
      
      const submitBtn = document.getElementById('submitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      
      try {
        const formData = new FormData(this);
        
        const response = await fetch('/claims-api/submit-claim', {
          method: 'POST',
          body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
          showSuccessModal(result.claimId);
        } else {
          showErrorModal(result.error || 'Submission failed. Please try again.');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Claim';
        }
      } catch (error) {
        console.error('Submission error:', error);
        showErrorModal('Network error. Please check your connection and try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Claim';
      }
    });
    
    // ==================== MODALS ====================
    function createModalOverlay() {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;animation:fadeIn 0.2s ease;';
      return overlay;
    }
    
    const modalBaseStyle = 'background:white;border-radius:20px;padding:50px 40px;text-align:center;max-width:500px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.4);animation:slideUp 0.3s ease;';
    
    function buttonStyle(gradient) {
      return 'width:100%;padding:18px;font-size:18px;font-weight:bold;color:white;background:' + gradient + ';border:none;border-radius:12px;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;transition:transform 0.2s ease,box-shadow 0.2s ease;';
    }
    
    function showSuccessModal(claimId) {
      const overlay = createModalOverlay();
      const modal = document.createElement('div');
      modal.style.cssText = modalBaseStyle;
      
      modal.innerHTML =
        '<div style="font-size:80px;margin-bottom:20px;color:#059669;">✓</div>' +
        '<h2 style="color:#059669;font-size:32px;margin-bottom:15px;font-weight:bold;">Claim Submitted</h2>' +
        '<p style="color:#64748b;font-size:16px;margin-bottom:10px;">Your claim has been recorded.</p>' +
        '<p style="color:#1e3a8a;font-size:18px;font-weight:bold;margin-bottom:35px;">Claim ID: ' + claimId + '</p>' +
        '<button id="newClaimBtn" style="' + buttonStyle('linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)') + '">Submit Another Claim</button>';
      
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      
      document.getElementById('newClaimBtn').addEventListener('click', function() {
        window.location.reload();
      });
    }
    
    function showErrorModal(message) {
      const overlay = createModalOverlay();
      const modal = document.createElement('div');
      modal.style.cssText = modalBaseStyle;
      
      modal.innerHTML =
        '<div style="font-size:80px;margin-bottom:20px;color:#dc2626;">✕</div>' +
        '<h2 style="color:#dc2626;font-size:32px;margin-bottom:15px;font-weight:bold;">Submission Error</h2>' +
        '<p style="color:#64748b;font-size:16px;margin-bottom:35px;">' + message + '</p>' +
        '<button id="errorOkBtn" style="' + buttonStyle('linear-gradient(135deg, #dc2626 0%, #ef4444 100%)') + '">Try Again</button>';
      
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      
      document.getElementById('errorOkBtn').addEventListener('click', function() {
        document.body.removeChild(overlay);
      });
    }

    function promptForStaffPassword() {
      return new Promise(function(resolve) {
        const overlay = createModalOverlay();
        const modal = document.createElement('div');
        modal.style.cssText = modalBaseStyle;

        modal.innerHTML =
          '<div style="font-size:64px;margin-bottom:15px;">🔒</div>' +
          '<h2 style="color:#1e3a8a;font-size:26px;margin-bottom:10px;font-weight:bold;">Staff Access Required</h2>' +
          '<p style="color:#64748b;font-size:15px;margin-bottom:25px;">Please hand the tablet to a Splash employee.</p>' +
          '<input type="password" id="staffPasswordInput" inputmode="numeric" autocomplete="off" ' +
            'placeholder="Password" ' +
            'style="width:100%;padding:14px 16px;font-size:18px;border:2px solid #e2e8f0;border-radius:8px;font-family:inherit;background:white;text-align:center;letter-spacing:6px;">' +
          '<div id="staffPasswordError" style="color:#dc2626;font-size:13px;min-height:18px;margin:8px 0 20px;"></div>' +
          '<div style="display:flex;gap:12px;">' +
            '<button type="button" id="staffCancelBtn" style="flex:1;padding:16px;font-size:15px;font-weight:bold;background:#e2e8f0;color:#475569;border:none;border-radius:10px;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;">Cancel</button>' +
            '<button type="button" id="staffUnlockBtn" style="flex:1;padding:16px;font-size:15px;font-weight:bold;color:white;background:linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%);border:none;border-radius:10px;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;">Unlock</button>' +
          '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const input = document.getElementById('staffPasswordInput');
        const errorDiv = document.getElementById('staffPasswordError');
        const unlockBtn = document.getElementById('staffUnlockBtn');
        const cancelBtn = document.getElementById('staffCancelBtn');

        setTimeout(function() { input.focus(); }, 50);

        function close(result) {
          document.removeEventListener('keydown', onEsc);
          if (overlay.parentNode) document.body.removeChild(overlay);
          resolve(result);
        }

        function attempt() {
          if (input.value === '1981') {
            close(true);
          } else {
            errorDiv.textContent = 'Incorrect password. Please try again.';
            input.style.borderColor = '#dc2626';
            input.value = '';
            input.focus();
          }
        }

        function onEsc(e) {
          if (e.key === 'Escape') close(false);
        }

        unlockBtn.addEventListener('click', attempt);
        cancelBtn.addEventListener('click', function() { close(false); });
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            attempt();
          }
        });
        input.addEventListener('input', function() {
          input.style.borderColor = '#e2e8f0';
          errorDiv.textContent = '';
        });
        overlay.addEventListener('click', function(e) {
          if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onEsc);
      });
    }

    // Add animations
    const animStyle = document.createElement('style');
    animStyle.textContent =
      '@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }' +
      '@keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }';
    document.head.appendChild(animStyle);
  </script>
</body>
</html>`;
}
// ==================== CLAIM QUERIES ====================
async function fetchClaimsForUser(env, auth, filters) {
  if (!env.DB) {
    console.error("D1 binding 'DB' not available");
    return [];
  }

  const where = ["deleted_at IS NULL"];
  const params = [];

  // Location scoping: admins see all, others restricted to their assigned locations
  if (!auth.isAdmin) {
    const userLocCodes = (auth.locations || []).map(l => l.location_code);
    if (userLocCodes.length === 0) {
      // User has no location assignments — they see nothing
      return [];
    }
    where.push(`location_code IN (${userLocCodes.map(() => "?").join(",")})`);
    params.push(...userLocCodes);
  }

  // Optional filters
  if (filters.lifecycle && filters.lifecycle !== "All") {
    where.push("lifecycle_state = ?");
    params.push(filters.lifecycle);
  }

  if (filters.location && filters.location !== "All") {
    where.push("location_code = ?");
    params.push(filters.location);
  }

  if (filters.status && filters.status !== "All") {
    where.push("claim_status = ?");
    params.push(filters.status);
  }

  if (filters.search && filters.search.trim()) {
    where.push("customer_name LIKE ?");
    params.push(`%${filters.search.trim()}%`);
  }

  const sql = `
    SELECT
      claim_id,
      location_code,
      location_pretty,
      customer_name,
      vehicle_year,
      vehicle_make,
      vehicle_model,
      submitted_at,
      claim_status,
      lifecycle_state,
      contact_status
    FROM claims
    WHERE ${where.join(" AND ")}
    ORDER BY submitted_at DESC
    LIMIT 100
  `;

  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch (err) {
    console.error("fetchClaimsForUser query failed:", err, "SQL:", sql, "params:", params);
    return [];
  }
}

// POST /manage/claim/{id}/note — append a note to the activity timeline.
// Returns a redirect back to the claim detail page on success.
async function handleAddNote(request, env, auth, claimId) {
  if (!checkOrigin(request)) {
    return manageHtml(403, renderManagePageWrap("<p>Bad origin. Refusing to process write.</p>"));
  }

  // Pull the claim once to check authorization (reuse fetchClaimDetail for consistency)
  const detail = await fetchClaimDetail(env, auth, claimId);
  if (detail.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
  if (detail.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
  if (detail.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));

  const form = await readManageForm(request);
  const noteText = (form.get("note") || "").trim();

  if (!noteText) {
    // Re-render the detail page with an inline error rather than 400ing
    return manageHtml(400, renderClaimDetail(
      auth, detail.claim, detail.photos, detail.activity,
      { error: "Note cannot be empty." }
    ));
  }
  if (noteText.length > 5000) {
    return manageHtml(400, renderClaimDetail(
      auth, detail.claim, detail.photos, detail.activity,
      { error: "Note is too long (max 5000 characters)." }
    ));
  }

  const actorEmail = auth.user.email || null;

  try {
    // Insert the activity row
    await env.DB.prepare(`
      INSERT INTO claim_activity (
        claim_id, activity_type, notes, actor_email, actor_name
      ) VALUES (?, 'note', ?, ?, ?)
    `).bind(claimId, noteText, actorEmail, actorEmail).run();

    // Bump claims.updated_at so the parent record reflects activity
    await env.DB.prepare(
      "UPDATE claims SET updated_at = datetime('now') WHERE claim_id = ?"
    ).bind(claimId).run();
  } catch (err) {
    console.error("handleAddNote failed:", err);
    return manageHtml(500, renderClaimDetail(
      auth, detail.claim, detail.photos, detail.activity,
      { error: "Failed to save note. Please try again." }
    ));
  }

  // Redirect back to detail (PRG pattern — prevents double-submit on refresh)
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/manage/claim/${encodeURIComponent(claimId)}`, 303);
}

// ==================== STATUS TRANSITION STATE MACHINE ====================
// Role hierarchy (lowest to highest privilege).
// "Higher roles can do anything lower roles can do."
const ROLE_HIERARCHY = ["viewer", "gm", "am", "rm", "admin", "super_admin"];

function roleAtLeast(userRole, requiredRole) {
  const userIdx = ROLE_HIERARCHY.indexOf(userRole);
  const reqIdx = ROLE_HIERARCHY.indexOf(requiredRole);
  if (userIdx < 0 || reqIdx < 0) return false;
  return userIdx >= reqIdx;
}

// CEO auto-routing threshold. If a transition that records an approved amount
// produces a value above this, the destination is overridden to "Approved — Pending CEO Approval".
const CEO_APPROVAL_THRESHOLD = 1000;

// All defined transitions. Each entry:
//   from:               source claim_status (must match exactly, em-dashes included)
//   to:                 destination claim_status
//   label:              button text shown to the user
//   role:               minimum role required to perform this transition
//   prominent:          if true, render as a prominent button; otherwise dropdown-only
//   requiresNote:       if true, the form must include a non-empty note
//   noteLabel:          label for the note field (optional override)
//   notePlaceholder:    placeholder text for the note field
//   requiresAmount:     if true, the form must include an approved_amount (number > 0)
//   amountLabel:        label for the amount field
//   stamps:             which audit columns to set (gm | rm | ceo). Always stamps status_updated_*.
//   ceoEligible:        if true, the CEO threshold check applies — if amount > CEO_APPROVAL_THRESHOLD,
//                       destination is rerouted to "Approved — Pending CEO Approval".
//   deferred:           if set, the transition is recognized but not yet implemented (renders as a notice).
//                       Value is the substep that will deliver it (e.g. "6c").
//   reopen:             if true, this is a reopen-from-closed transition (groups under "Reopen").
const CLAIM_TRANSITIONS = [
  // ===== From New — Pending Review =====
  // (Currently unused — schema default but no determination produces this. Kept for completeness.)
  { from: "New — Pending Review", to: "Pending GM Review", label: "Send to GM Review", role: "gm", prominent: true },
  { from: "New — Pending Review", to: "No Responsibility — Pending Review", label: "Mark No Responsibility", role: "gm", prominent: true },
  { from: "New — Pending Review", to: "Closed — Denied", label: "Deny", role: "gm", prominent: true, requiresNote: false, noteLabel: "Denial reason (optional)" },

  // ===== From No Responsibility — Pending Review =====
  { from: "No Responsibility — Pending Review", to: "Closed — Denied", label: "Confirm Denial (Close)", role: "gm", prominent: true, requiresNote: false, noteLabel: "Denial reason (optional)" },
  { from: "No Responsibility — Pending Review", to: "Pending GM Review", label: "Override — Send to GM Review", role: "rm", prominent: true, requiresNote: true, noteLabel: "Override reason (required)" },

  // ===== From Pending GM Review =====
  { from: "Pending GM Review", to: "Approved — Pending Quotes", label: "Approve — Customer Gets Quotes", role: "gm", prominent: true, requiresNote: false, noteLabel: "Notes (optional)" },
  { from: "Pending GM Review", to: "Approved — In House — Parts Ordered", label: "Approve — In House Repair", role: "gm", prominent: true, optionalInputs: ["parts", "vendor"] },
  { from: "Pending GM Review", to: "Pending RM Review", label: "Escalate to RM", role: "gm", prominent: true, requiresNote: false, noteLabel: "Escalation note (optional)" },
  { from: "Pending GM Review", to: "Closed — Denied", label: "Deny", role: "gm", prominent: true, requiresNote: false, noteLabel: "Denial reason (optional)" },

  // ===== From Pending RM Review =====
  { from: "Pending RM Review", to: "Approved — Pending Quotes", label: "Approve — Customer Gets Quotes", role: "rm", prominent: true, requiresNote: false, noteLabel: "Notes (optional)" },
  { from: "Pending RM Review", to: "Approved — In House — Parts Ordered", label: "Approve — In House Repair", role: "rm", prominent: true, optionalInputs: ["parts", "vendor"] },
  { from: "Pending RM Review", to: "Closed — Denied", label: "Deny", role: "rm", prominent: true, requiresNote: false, noteLabel: "Denial reason (optional)" },
  { from: "Pending RM Review", to: "Pending GM Review", label: "Kick Back to GM", role: "rm", prominent: true, requiresNote: true, noteLabel: "Reason for kickback (required)" },

  // ===== From Approved — Pending Quotes =====
  { from: "Approved — Pending Quotes", to: "Pending RM Quote Approval", label: "Quotes Received — Send to RM", role: "gm", prominent: true, requiresNote: false, noteLabel: "Notes about quotes (optional)" },
  { from: "Approved — Pending Quotes", to: "Closed — Approved/No Response", label: "Customer No Response — Close", role: "gm", prominent: true, requiresNote: false, noteLabel: "Notes (optional)" },

  // ===== From Pending RM Quote Approval =====
  // Approve quote: requires explicit selection of an uploaded quote.
  // The selected quote's amount becomes claim.approved_amount; if > $1000, routes to CEO.
  { from: "Pending RM Quote Approval", to: "Approved — Check Request Submitted", label: "Approve Quote", role: "rm", prominent: true, requiresQuoteSelection: true },
  { from: "Pending RM Quote Approval", to: "Closed — Denied", label: "Deny", role: "rm", prominent: true, requiresNote: false, noteLabel: "Denial reason (optional)" },

  // ===== From Approved — In House — Parts Ordered =====
  { from: "Approved — In House — Parts Ordered", to: "Closed — Paid", label: "Mark Repaired & Close", role: "gm", prominent: true, requiresNote: false, noteLabel: "Repair notes (optional) — repaired by, what was done", requiresReceiptOnFile: true },

  // ===== From Approved — In House — Repaired =====
  { from: "Approved — In House — Repaired", to: "Closed — Paid", label: "Close — Paid", role: "gm", prominent: true, requiresNote: false, noteLabel: "Notes (optional)" },

  // ===== From Approved — Check Request Submitted =====
  // Incidents reviews the auto-generated check request PDF, then forwards to AP.
  // Transition stamps the Approval line on the second PDF generation.
  { from: "Approved — Check Request Submitted", to: "Approved — Submitted for Payment", label: "Submit for Payment", role: "admin", prominent: true, requiresNote: false, noteLabel: "Notes (optional)" },

  // ===== From Approved — Submitted for Payment =====
  // AP cuts the check; either AP or incidents marks it paid in the tool.
  { from: "Approved — Submitted for Payment", to: "Closed — Paid", label: "Mark Paid", role: "admin", prominent: true, requiresNote: false, noteLabel: "Check # / payment details (optional)" },

  // ===== From Approved — Pending CEO Approval (vestigial — only reachable via admin dropdown) =====
  { from: "Approved — Pending CEO Approval", to: "Approved — Check Request Submitted", label: "CEO Approved — Submit Check Request", role: "admin", prominent: true, requiresNote: false, noteLabel: "Notes (optional)", stamps: ["ceo"] },
  { from: "Approved — Pending CEO Approval", to: "Closed — Denied", label: "CEO Denied", role: "admin", prominent: true, requiresNote: false, noteLabel: "Reason (optional)", stamps: ["ceo"] },

  // ===== From Approved — Check Issued =====
  { from: "Approved — Check Issued", to: "Closed — Paid", label: "Close — Paid", role: "rm", prominent: true, requiresNote: false, noteLabel: "Notes (optional)" },

  // ===== Admin escape hatches: kick mid-workflow states back to GM/RM Review =====
  // Only admin/super_admin see these (prominent: false), via the dropdown.
  { from: "Approved — Pending Quotes", to: "Pending GM Review", label: "Send back to GM Review", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — Pending Quotes", to: "Pending RM Review", label: "Send back to RM Review", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Pending RM Quote Approval", to: "Pending GM Review", label: "Send back to GM Review", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Pending RM Quote Approval", to: "Approved — Pending Quotes", label: "Send back to Pending Quotes", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — In House — Parts Ordered", to: "Pending GM Review", label: "Send back to GM Review", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — In House — Repaired", to: "Approved — In House — Parts Ordered", label: "Send back to Parts Ordered", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — Check Request Submitted", to: "Pending RM Quote Approval", label: "Send back to RM Quote Approval", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — Submitted for Payment", to: "Approved — Check Request Submitted", label: "Send back to Incidents Review", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — Submitted for Payment", to: "Pending RM Quote Approval", label: "Send back to RM Quote Approval", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  { from: "Approved — Check Issued", to: "Approved — Check Request Submitted", label: "Send back to Check Request Submitted", role: "admin", prominent: false, requiresNote: true, noteLabel: "Reason (required)" },
  
  // ===== Reopen transitions =====
  // Only super_admin and admin can reopen closed claims.
  { from: "Closed — Paid", to: "Pending GM Review", label: "Reopen → GM Review", role: "admin", prominent: false, reopen: true, requiresNote: true, noteLabel: "Reason for reopen (required)" },
  { from: "Closed — Paid", to: "Pending RM Review", label: "Reopen → RM Review", role: "admin", prominent: false, reopen: true, requiresNote: true, noteLabel: "Reason for reopen (required)" },
  { from: "Closed — Denied", to: "Pending GM Review", label: "Reopen → GM Review", role: "admin", prominent: false, reopen: true, requiresNote: true, noteLabel: "Reason for reopen (required)" },
  { from: "Closed — Denied", to: "Pending RM Review", label: "Reopen → RM Review", role: "admin", prominent: false, reopen: true, requiresNote: true, noteLabel: "Reason for reopen (required)" },
  { from: "Closed — Approved/No Response", to: "Pending RM Quote Approval", label: "Reopen → RM Quote Approval", role: "admin", prominent: false, reopen: true, requiresNote: true, noteLabel: "Reason for reopen (required)" },
  { from: "Closed — Approved/No Response", to: "Approved — Check Request Submitted", label: "Reopen → Check Request Submitted", role: "admin", prominent: false, reopen: true, requiresNote: true, noteLabel: "Reason for reopen (required)" },
];

// Returns transitions visible to the user given the claim's current status and the user's role.
// Splits into { prominent: [...], dropdown: [...] } for UI rendering.
function getValidTransitionsForUser(claim, auth) {
  const fromStatus = claim.claim_status;
  const userRole = auth.dc_role;
  if (!userRole) return { prominent: [], dropdown: [], deferred: [] };

  const matching = CLAIM_TRANSITIONS.filter(t => t.from === fromStatus && roleAtLeast(userRole, t.role));

  const prominent = [];
  const dropdown = [];
  const deferred = [];

  for (const t of matching) {
    if (t.deferred) {
      deferred.push(t);
      continue;
    }
    if (t.prominent) {
      prominent.push(t);
    } else if (auth.isAdmin) {
      // Non-prominent transitions only shown to admin/super_admin
      dropdown.push(t);
    }
  }

  return { prominent, dropdown, deferred };
}

// Find a transition definition by from + to (or null if not found / not allowed for this user).
function findTransition(fromStatus, toStatus, userRole) {
  const t = CLAIM_TRANSITIONS.find(x => x.from === fromStatus && x.to === toStatus);
  if (!t) return null;
  if (!roleAtLeast(userRole, t.role)) return null;
  return t;
}

// Compute lifecycle_state for a destination status.
function lifecycleForStatus(status) {
  return status.startsWith("Closed") ? "Closed" : "Open";
}

// Determine which audit columns a transition writes, based on the transition definition + role.
// If the transition explicitly declares stamps, use those. Otherwise infer from the source status:
//   "Pending GM Review" → gm
//   "Pending RM Review" or "Pending RM Quote Approval" → rm
//   "Pending CEO Approval" → ceo
function computeAuditStamps(transition) {
  if (transition.stamps) return transition.stamps;
  const f = transition.from;
  if (f === "Pending GM Review") return ["gm"];
  if (f === "Pending RM Review" || f === "Pending RM Quote Approval") return ["rm"];
  if (f === "Approved — Pending CEO Approval") return ["ceo"];
  return [];
}

// POST /manage/claim/{id}/transition — perform a status change.
async function handleStatusTransition(request, env, auth, claimId) {
  if (!checkOrigin(request)) {
    return manageHtml(403, renderManagePageWrap("<p>Bad origin. Refusing to process write.</p>"));
  }

  const detail = await fetchClaimDetail(env, auth, claimId);
  if (detail.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
  if (detail.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
  if (detail.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));

  const claim = detail.claim;
  const form = await readManageForm(request);
  const requestedTo = (form.get("to_status") || "").trim();
  const noteText = (form.get("note") || "").trim();
  const amountStr = (form.get("approved_amount") || "").trim();

  // Validate transition exists and user is allowed
  const transition = findTransition(claim.claim_status, requestedTo, auth.dc_role);
  if (!transition) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: `Transition from "${claim.claim_status}" to "${requestedTo}" is not allowed for your role.` }
    ));
  }

  // Block deferred transitions
  if (transition.deferred) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: `This action is not yet available — coming in step ${transition.deferred}.` }
    ));
  }

  // Validate required note
  if (transition.requiresNote && !noteText) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: `A note is required for "${transition.label}".` }
    ));
  }
  if (noteText.length > 5000) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Note is too long (max 5000 characters)." }
    ));
  }

  // Validate amount if required, and apply CEO threshold logic
  let approvedAmount = null;
  let finalTo = transition.to;
  if (transition.requiresAmount) {
    const parsed = parseFloat(amountStr);
    if (isNaN(parsed) || parsed <= 0) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "A valid approved amount is required." }
      ));
    }
    approvedAmount = parsed;
    if (transition.ceoEligible && approvedAmount > CEO_APPROVAL_THRESHOLD) {
      finalTo = "Approved — Pending CEO Approval";
    }
  }

  // ===== Step 6c additions: structured-input transitions =====

  // requiresInputs / optionalInputs: form field names captured into the claim row.
  // requiresInputs blocks the transition if missing; optionalInputs accepts blank.
  const inputsCollected = {};
  const allInputFields = [
    ...(transition.requiresInputs || []),
    ...(transition.optionalInputs || [])
  ];
  for (const fieldName of allInputFields) {
    const val = (form.get(fieldName) || "").trim();
    if (!val) {
      if (transition.requiresInputs && transition.requiresInputs.includes(fieldName)) {
        return manageHtml(400, renderClaimDetail(
          auth, claim, detail.photos, detail.activity,
          { error: `"${fieldName}" is required for ${transition.label}.` }
        ));
      }
      // Optional + blank — skip writing this column
      continue;
    }
    if (val.length > 1000) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: `"${fieldName}" is too long (max 1000 characters).` }
      ));
    }
    inputsCollected[fieldName] = val;
  }

  // requiresReceiptOnFile: at least one active Receipt must exist on this claim
  if (transition.requiresReceiptOnFile) {
    const hasReceipt = detail.photos.some(p => p.photo_type === "Receipt" && !p.deleted_at);
    if (!hasReceipt) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Upload a receipt before approving in-house repair." }
      ));
    }
  }

  // requiresQuoteSelection: form must include a quote_id that points to an active Quote on this claim.
  // Quote must have amount AND pay_to_type AND (if vendor) vendor_address.
  // selectedQuote retained in outer scope for the post-write check-request PDF trigger.
  let selectedQuoteId = null;
  let selectedQuote = null;
  if (transition.requiresQuoteSelection) {
    const qIdStr = (form.get("quote_id") || "").trim();
    const qIdNum = parseInt(qIdStr, 10);
    if (!qIdStr || isNaN(qIdNum)) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Select a quote to approve." }
      ));
    }
    const quote = detail.photos.find(p =>
      p.id === qIdNum && p.photo_type === "Quote" && !p.deleted_at
    );
    if (!quote) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Selected quote was not found on this claim." }
      ));
    }
    // Required fields on the quote
    const missing = [];
    if (quote.amount === null || quote.amount === undefined) missing.push("amount");
    if (!quote.pay_to_type) missing.push("pay-to selection");
    if (quote.pay_to_type === "vendor" && !quote.vendor_address) missing.push("vendor address");
    if (missing.length > 0) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: `Selected quote is missing: ${missing.join(", ")}. Edit the quote in the Documents card to add these before approving.` }
      ));
    }
    selectedQuoteId = qIdNum;
    selectedQuote = quote;
    approvedAmount = quote.amount;
    // CEO auto-routing dropped per 6d. Incidents handles CEO conversation offline.
  }

  // Build the UPDATE for claims
  const nowIso = new Date().toISOString();
  const actorEmail = auth.user.email || null;
  const stamps = computeAuditStamps(transition);

  const setParts = [
    "claim_status = ?",
    "lifecycle_state = ?",
    "status_updated_at = datetime('now')",
    "status_updated_by = ?",
    "updated_at = datetime('now')"
  ];
  const params = [finalTo, lifecycleForStatus(finalTo), actorEmail];

  if (stamps.includes("gm")) {
    setParts.push("gm_approved_at = datetime('now')");
    setParts.push("gm_approved_by = ?");
    params.push(actorEmail);
  }
  if (stamps.includes("rm")) {
    setParts.push("rm_approved_at = datetime('now')");
    setParts.push("rm_approved_by = ?");
    params.push(actorEmail);
  }
  if (stamps.includes("ceo")) {
    setParts.push("ceo_approved_at = datetime('now')");
    setParts.push("ceo_approved_by = ?");
    params.push(actorEmail);
  }
  if (approvedAmount !== null) {
    setParts.push("approved_amount = ?");
    params.push(approvedAmount);
  }
  // 6c: structured inputs land in dedicated columns (parts_ordered, vendor_name).
  if (inputsCollected.parts !== undefined) {
    setParts.push("parts_ordered = ?");
    params.push(inputsCollected.parts);
  }
  if (inputsCollected.vendor !== undefined) {
    setParts.push("vendor_name = ?");
    params.push(inputsCollected.vendor);
  }
  if (selectedQuoteId !== null) {
    setParts.push("approved_quote_id = ?");
    params.push(selectedQuoteId);
  }

  const updateSql = `UPDATE claims SET ${setParts.join(", ")} WHERE claim_id = ?`;
  params.push(claimId);

  try {
    // Run claim update + activity insert as a batch (atomic-ish per statement)
    const updateStmt = env.DB.prepare(updateSql).bind(...params);
    const activityStmt = env.DB.prepare(`
      INSERT INTO claim_activity (
        claim_id, activity_type, status_from, status_to, notes, actor_email, actor_name
      ) VALUES (?, 'status_change', ?, ?, ?, ?, ?)
    `).bind(
      claimId,
      claim.claim_status,
      finalTo,
      noteText || null,
      actorEmail,
      actorEmail
    );
    await env.DB.batch([updateStmt, activityStmt]);
  } catch (err) {
    console.error("handleStatusTransition failed:", err);
    return manageHtml(500, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Failed to apply status change. Please try again." }
    ));
  }

  // ===== Step 6d: Check Request side-effects =====
  // After the status commit, generate the appropriate PDF and fire the appropriate email.
  // These run best-effort: failures are logged to activity but do not roll back the status change.
  // The user gets the page reload regardless; if email failed they can see the activity log
  // and re-trigger via an admin reset / kickback.
  if (finalTo === "Approved — Check Request Submitted" && selectedQuote) {
    // RM just approved a quote. Generate PDF #1 (Requestor signed, Approval blank) → email incidents.
    await runCheckRequestPdfStep(
      env, claim, selectedQuote,
      actorEmail,                 // requestor = the RM who approved
      null,                        // approval blank at this stage
      "Pending Incidents Review",
      env.INCIDENTS_WEBHOOK_URL,
      "incidents"
    );
  } else if (finalTo === "Approved — Submitted for Payment") {
    // Incidents just clicked Submit for Payment. Generate PDF #2 (Requestor + Approval signed) → email AP.
    // We need the originally approved quote. It's the most-recent active Quote on the claim that has
    // pay_to_type set; alternatively claim.approved_quote_id (which we set at RM approval time).
    let quoteForPdf = null;
    if (claim.approved_quote_id) {
      quoteForPdf = detail.photos.find(p =>
        p.id === claim.approved_quote_id && p.photo_type === "Quote" && !p.deleted_at
      );
    }
    if (!quoteForPdf) {
      // Fallback: find any active quote (shouldn't happen in practice)
      quoteForPdf = detail.photos.find(p => p.photo_type === "Quote" && !p.deleted_at);
    }
    if (quoteForPdf) {
      // The original Requestor signature comes from rm_approved_by on the claim row.
      // The fresh fetch is needed because actorEmail is incidents (the current user).
      const requestorEmail = claim.rm_approved_by || claim.gm_approved_by || "(unknown)";
      await runCheckRequestPdfStep(
        env, claim, quoteForPdf,
        requestorEmail,              // requestor = original RM
        actorEmail,                   // approval = incidents email (current user)
        "Submitted to AP",
        env.AP_WEBHOOK_URL,
        "AP"
      );
    } else {
      // Log a warning activity row but don't fail the transition
      await env.DB.prepare(`
        INSERT INTO claim_activity (
          claim_id, activity_type, notes, actor_email, actor_name
        ) VALUES (?, 'note', ?, ?, ?)
      `).bind(
        claimId,
        "[System] Submit for Payment: could not find approved quote on this claim. PDF + email to AP skipped.",
        actorEmail, actorEmail
      ).run();
    }
  }

  // PRG redirect
  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/manage/claim/${encodeURIComponent(claimId)}`, 303);
}

// Wrapper around storeCheckRequestPdf + sendCheckRequestEmail.
// Logs an activity row indicating the outcome. Never throws.
async function runCheckRequestPdfStep(env, claim, quote, requestorEmail, approvalEmail, stageLabel, webhookUrl, recipientLabel) {
  let stored = null;
  try {
    stored = await storeCheckRequestPdf(env, claim, quote, requestorEmail, approvalEmail, stageLabel);
  } catch (err) {
    console.error("runCheckRequestPdfStep: PDF generation/storage failed:", err);
    try {
      await env.DB.prepare(`
        INSERT INTO claim_activity (
          claim_id, activity_type, notes, actor_email, actor_name
        ) VALUES (?, 'note', ?, ?, ?)
      `).bind(
        claim.claim_id,
        `[System] Failed to generate Check Request PDF (${stageLabel}): ${err.message || err}`,
        "system", "system"
      ).run();
    } catch (_) { /* swallow */ }
    return;
  }

  // Fire email
  const emailResult = await sendCheckRequestEmail(
    webhookUrl, claim, quote, stored.pdfBytes, stored.filename, requestorEmail
  );
  // Log outcome as an activity row
  const noteText = emailResult.ok
    ? `Generated Check Request (${stageLabel}) and emailed to ${recipientLabel}.`
    : `Generated Check Request (${stageLabel}). Email to ${recipientLabel} FAILED: ${emailResult.error || ("status " + emailResult.status)}.`;
  try {
    await env.DB.prepare(`
      INSERT INTO claim_activity (
        claim_id, activity_type, notes, actor_email, actor_name
      ) VALUES (?, 'document_added', ?, ?, ?)
    `).bind(
      claim.claim_id, noteText, "system", "system"
    ).run();
  } catch (err) {
    console.error("runCheckRequestPdfStep: failed to log activity row:", err);
  }
}

// GET /manage/claim/{id}/quote/{quoteId}/preview-check-request.pdf
// Returns PDF bytes inline. Pure preview — no DB write, no R2 storage, no email.
// Permission: any user with access to the claim (same as fetchClaimDetail).
async function handleCheckRequestPreview(request, env, auth, claimId, quoteId) {
  const detail = await fetchClaimDetail(env, auth, claimId);
  if (detail.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
  if (detail.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
  if (detail.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));

  const claim = detail.claim;
  const qIdNum = parseInt(quoteId, 10);
  if (isNaN(qIdNum)) {
    return manageHtml(400, renderManagePageWrap("<p>Invalid quote id.</p>"));
  }
  const quote = detail.photos.find(p =>
    p.id === qIdNum && p.photo_type === "Quote" && !p.deleted_at
  );
  if (!quote) {
    return manageHtml(404, renderManagePageWrap("<p>Quote not found.</p>"));
  }
  // Check the quote has the data needed for a meaningful preview
  if (quote.amount === null || quote.amount === undefined || !quote.pay_to_type) {
    return manageHtml(400, renderManagePageWrap(
      "<p>Quote needs an amount and pay-to selection before preview. Edit the quote to add them.</p>"
    ));
  }
  if (quote.pay_to_type === "vendor" && !quote.vendor_address) {
    return manageHtml(400, renderManagePageWrap(
      "<p>Quote pay-to is set to vendor but no vendor address is on file. Edit the quote to add one.</p>"
    ));
  }

  // Build the preview fields. Requestor and Approval are intentionally not the
  // current user — this is a draft, not the real signed copy. Approval gets a
  // visible DRAFT marker so a printed preview can't be mistaken for the real thing.
  const fields = buildCheckRequestFields(claim, quote, "(preview — not signed)", "DRAFT — NOT FOR PAYMENT");

  let pdfBytes;
  try {
    pdfBytes = await generateCheckRequestPdf(env, fields);
  } catch (err) {
    console.error("handleCheckRequestPreview: PDF generation failed:", err);
    return manageHtml(500, renderManagePageWrap(
      `<p>Could not generate preview: ${escapeManage(err.message || String(err))}</p>`
    ));
  }

  return new Response(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="preview_check_request_claim_${claim.claim_id}.pdf"`,
      "Cache-Control": "no-store"
    }
  });
}

// ==================== CHECK REQUEST PDF GENERATION ====================
// Generates a filled-in Check Request PDF using pdf-lib + the AcroForm template
// stored at R2 key "templates/check-request.pdf".
//
// Two distinct generation moments:
//   1. RM Approve Quote → Requestor signed (RM email), Approval blank
//   2. Incidents Submit for Payment → Requestor + Approval signed
//
// Both produce a fresh PDF stored as a separate claim_photos row with
// photo_type='Check Request'. The notes field carries the stage label.

import { PDFDocument } from "pdf-lib";

const CHECK_REQUEST_TEMPLATE_KEY = "templates/check-request.pdf";

// Fill the AcroForm template and return the resulting PDF bytes.
// fields:
//   date, location, email, phone, amount, makeOutTo, addressLines (array of up to 4),
//   explanation, incidentNumber, requestorSignature, approvalSignature
async function generateCheckRequestPdf(env, fields) {
  // Load template from R2
  const templateObj = await env.R2_BUCKET.get(CHECK_REQUEST_TEMPLATE_KEY);
  if (!templateObj) {
    throw new Error("Check request template not found in R2 at " + CHECK_REQUEST_TEMPLATE_KEY);
  }
  const templateBytes = await templateObj.arrayBuffer();

  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();

  // Helper: set a text field by name, swallowing errors if the field is missing.
  const setIf = (name, value) => {
    if (value === null || value === undefined) return;
    try {
      const f = form.getTextField(name);
      f.setText(String(value));
    } catch (err) {
      console.warn(`generateCheckRequestPdf: could not set field "${name}":`, err.message);
    }
  };

  setIf("Date", fields.date);
  setIf("Location", fields.location);
  setIf("Email", fields.email);
  setIf("Phone Number", fields.phone);
  setIf("Dollar Amount", fields.amount);
  setIf("Check Made out to", fields.makeOutTo);

  const addrLines = fields.addressLines || [];
  setIf("Address Line 1", addrLines[0] || "");
  setIf("Address Line 2", addrLines[1] || "");
  setIf("Address Line 3", addrLines[2] || "");
  setIf("Address Line 4", addrLines[3] || "");

  setIf("Explanation", fields.explanation);
  setIf("Incident Number", fields.incidentNumber);
  setIf("Signature of Requestor", fields.requestorSignature);
  setIf("Approval", fields.approvalSignature);

  // Flatten the form so the PDF is non-editable when AP receives it.
  // This bakes the field values into the page content.
  try {
    form.flatten();
  } catch (err) {
    console.warn("generateCheckRequestPdf: flatten failed (continuing unflattened):", err.message);
  }

  return await pdfDoc.save();
}

// Split a single-line mailing address into up to 4 lines for the PDF.
// Heuristic: split on newlines first, then on commas if needed.
function splitAddressLines(address) {
  if (!address) return [];
  const trimmed = String(address).trim();
  if (!trimmed) return [];
  // Try newline split
  let lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // If still one line, try comma split
  if (lines.length === 1) {
    lines = trimmed.split(",").map(l => l.trim()).filter(Boolean);
  }
  return lines.slice(0, 4);
}

// Map a quote row (claim_photos with photo_type='Quote') + claim row into
// the field set used to fill the Check Request PDF.
function buildCheckRequestFields(claim, quote, requestorEmail, approvalEmail) {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit", day: "2-digit", year: "numeric"
  });

  // Resolve payee + address from the quote's pay_to_type
  let makeOutTo, addressLines;
  if (quote.pay_to_type === "vendor") {
    makeOutTo = quote.vendor || "";
    addressLines = splitAddressLines(quote.vendor_address);
  } else {
    // Default to customer
    makeOutTo = claim.customer_name || "";
    addressLines = splitAddressLines(claim.customer_mailing_address);
  }

  const vehicleDesc = [claim.vehicle_year, claim.vehicle_make, claim.vehicle_model]
    .filter(Boolean).join(" ");
  const vendorPart = quote.vendor ? `${quote.vendor} quote` : "Quote";
  const explanation =
    `Vehicle damage claim for ${vehicleDesc || "customer vehicle"}` +
    (claim.license_plate ? ` (plate ${claim.license_plate})` : "") +
    `. ${vendorPart}: $${Number(quote.amount || 0).toFixed(2)}.`;

  return {
    date: dateStr,
    location: claim.location_pretty || "",
    email: claim.customer_email || "",
    phone: claim.customer_phone || "",
    amount: quote.amount !== null && quote.amount !== undefined ? Number(quote.amount).toFixed(2) : "",
    makeOutTo,
    addressLines,
    explanation,
    incidentNumber: claim.claim_id,
    requestorSignature: requestorEmail || "",
    approvalSignature: approvalEmail || ""
  };
}

// Generate, save to R2, insert claim_photos row. Returns { id, r2_key, filename }.
// stageLabel goes in the notes column to indicate which step generated it.
async function storeCheckRequestPdf(env, claim, quote, requestorEmail, approvalEmail, stageLabel) {
  const fields = buildCheckRequestFields(claim, quote, requestorEmail, approvalEmail);
  const pdfBytes = await generateCheckRequestPdf(env, fields);

  // Filename: Req_{claim_id}_{stage-slug}.pdf
  // Stage slug derived from stageLabel ("Pending Incidents Review" / "Submitted to AP").
  // R2 sequence is appended only if the same claim+stage was generated more than once
  // (e.g., after an admin sent the claim back and re-approval re-fired the trigger).
  const stageSlug = stageLabel
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const baseFilename = `Req_${claim.claim_id}_${stageSlug}`;
  // Check for existing files with this exact stage on this claim — if so, append a sequence
  const existingResult = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM claim_photos
     WHERE claim_id = ? AND photo_type = 'Check Request' AND filename LIKE ?
     AND (deleted_at IS NULL)`
  ).bind(claim.claim_id, baseFilename + "%").first();
  const existingCount = existingResult?.n || 0;
  const filename = existingCount > 0
    ? `${baseFilename}_${existingCount + 1}.pdf`
    : `${baseFilename}.pdf`;
  const r2Key = `claims/${claim.claim_id}/${filename}`;

  await env.R2_BUCKET.put(r2Key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" }
  });

  const insertResult = await env.DB.prepare(`
    INSERT INTO claim_photos (
      claim_id, photo_type, r2_key, filename, content_type,
      vendor, amount, notes, uploaded_by
    ) VALUES (?, 'Check Request', ?, ?, 'application/pdf', NULL, ?, ?, ?)
  `).bind(
    claim.claim_id, r2Key, filename,
    quote.amount, stageLabel, requestorEmail || "system"
  ).run();

  return {
    id: insertResult.meta?.last_row_id || null,
    r2_key: r2Key,
    filename,
    pdfBytes,
    fields
  };
}

// Fire a Power Automate webhook with the PDF + claim summary as JSON.
// Returns { ok: bool, status: number, error?: string }. Never throws.
async function sendCheckRequestEmail(webhookUrl, claim, quote, pdfBytes, pdfFilename, requestorEmail) {
  if (!webhookUrl) {
    console.warn("sendCheckRequestEmail: webhook URL not configured, skipping");
    return { ok: false, status: 0, error: "webhook URL not configured" };
  }

  // Convert pdfBytes (Uint8Array) to base64 for JSON transport
  let binary = "";
  for (let i = 0; i < pdfBytes.byteLength; i++) {
    binary += String.fromCharCode(pdfBytes[i]);
  }
  const pdfBase64 = btoa(binary);

  const payload = {
    claimId: claim.claim_id,
    customerName: claim.customer_name || "",
    locationPretty: claim.location_pretty || "",
    amount: Number(quote.amount || 0),
    vendorName: quote.vendor || "",
    rmEmail: requestorEmail || "",
    claimUrl: `https://splashcarwashes.info/manage/claim/${encodeURIComponent(claim.claim_id)}`,
    pdfBase64,
    pdfFilename
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error("sendCheckRequestEmail: webhook returned", response.status);
      return { ok: false, status: response.status, error: `webhook returned ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    console.error("sendCheckRequestEmail: fetch failed:", err);
    return { ok: false, status: 0, error: err.message || String(err) };
  }
}

// ==================== DOCUMENT UPLOAD / EDIT / DELETE ====================
// Documents (Quote / Receipt) live in the same claim_photos table and the same
// R2 bucket prefix as photos. Stored under photo_type='Quote' or 'Receipt'.
// Filename pattern: claims/{claimId}/{type}_{n}.{ext} — where {n} is the next
// available sequence number for that type on this claim.

const DOCUMENT_TYPES = ["Quote", "Receipt"];
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DOCUMENT_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence"
]);

// Decide if the current user is allowed to mutate (delete/edit) a particular
// document row. Rule: super_admin or admin always; uploader matches by email.
function canMutateDocument(auth, doc) {
  if (auth.isAdmin) return true;
  if (!doc.uploaded_by || !auth.user?.email) return false;
  return doc.uploaded_by.toLowerCase() === auth.user.email.toLowerCase();
}

// Compute the next sequence number for a given doc type on a claim.
// Sequencing is over BOTH active and soft-deleted rows so we never collide on R2 keys.
async function nextDocumentSequence(env, claimId, photoType) {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM claim_photos WHERE claim_id = ? AND photo_type = ?"
  ).bind(claimId, photoType).first();
  return ((result?.c) || 0) + 1;
}

// POST /manage/claim/{id}/document — upload a Quote or Receipt
async function handleDocumentUpload(request, env, auth, claimId) {
  if (!checkOrigin(request)) {
    return manageHtml(403, renderManagePageWrap("<p>Bad origin. Refusing to process write.</p>"));
  }

  const detail = await fetchClaimDetail(env, auth, claimId);
  if (detail.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
  if (detail.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
  if (detail.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));

  const claim = detail.claim;

  // Multipart only — readManageForm already handles that path
  const ctype = request.headers.get("content-type") || "";
  if (!ctype.includes("multipart/form-data")) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Document upload must be multipart/form-data." }
    ));
  }

  const form = await request.formData();
  const file = form.get("file");
  const docType = (form.get("doc_type") || "").trim();
  const vendor = (form.get("vendor") || "").trim() || null;
  const amountStr = (form.get("amount") || "").trim();
  const notesText = (form.get("notes") || "").trim() || null;
  const payToTypeRaw = (form.get("pay_to_type") || "").trim().toLowerCase();
  const vendorAddress = (form.get("vendor_address") || "").trim() || null;

  // Validate type
  if (!DOCUMENT_TYPES.includes(docType)) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Invalid document type. Must be Quote or Receipt." }
    ));
  }

  // Validate file present
  if (!file || typeof file === "string" || !file.name) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "No file selected." }
    ));
  }

  // Validate size
  if (file.size > DOCUMENT_MAX_BYTES) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: `File too large (max ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB).` }
    ));
  }
  if (file.size === 0) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "File is empty." }
    ));
  }

  // Validate MIME / extension
  const mime = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const extOk = ["pdf", "jpg", "jpeg", "png", "heic", "heif"].includes(ext);
  const mimeOk = DOCUMENT_ALLOWED_MIME.has(mime);
  if (!extOk && !mimeOk) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Unsupported file type. Allowed: PDF, JPG, PNG, HEIC." }
    ));
  }

  // Validate amount (optional, but if present must be a positive number)
  let amount = null;
  if (amountStr) {
    const parsed = parseFloat(amountStr);
    if (isNaN(parsed) || parsed < 0) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Amount must be a non-negative number." }
      ));
    }
    amount = parsed;
  }

  // Validate notes length
  if (notesText && notesText.length > 5000) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Notes are too long (max 5000 characters)." }
    ));
  }

  // Validate pay_to_type — only meaningful on Quote rows; ignored on Receipt.
  // Optional at upload time (the Approve Quote step blocks if missing).
  let payToType = null;
  let payToVendorAddress = null;
  if (docType === "Quote") {
    if (payToTypeRaw && payToTypeRaw !== "customer" && payToTypeRaw !== "vendor") {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Pay to must be 'customer' or 'vendor'." }
      ));
    }
    payToType = payToTypeRaw || null;
    if (payToType === "vendor") {
      if (!vendorAddress) {
        return manageHtml(400, renderClaimDetail(
          auth, claim, detail.photos, detail.activity,
          { error: "Vendor address is required when paying the vendor directly." }
        ));
      }
      if (vendorAddress.length > 1000) {
        return manageHtml(400, renderClaimDetail(
          auth, claim, detail.photos, detail.activity,
          { error: "Vendor address is too long (max 1000 characters)." }
        ));
      }
      payToVendorAddress = vendorAddress;
    }
  }

  // Upload to R2 using the existing helper. uploadToR2 handles HEIC->JPEG conversion.
  // Sequence number is over existing rows of this type on this claim.
  const seq = await nextDocumentSequence(env, claimId, docType);
  const r2Result = await uploadToR2(file, claimId, docType, seq - 1, env);
  if (!r2Result) {
    return manageHtml(500, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Upload to storage failed. Please try again." }
    ));
  }

  const actorEmail = auth.user.email || null;

  try {
    // Insert into claim_photos with the doc-specific columns
    const insertResult = await env.DB.prepare(`
      INSERT INTO claim_photos (
        claim_id, photo_type, r2_key, filename, content_type,
        vendor, amount, notes, uploaded_by, pay_to_type, vendor_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      claimId, docType, r2Result.key, file.name, r2Result.contentType,
      vendor, amount, notesText, actorEmail, payToType, payToVendorAddress
    ).run();

    const newId = insertResult.meta?.last_row_id || null;

    // Activity row + bump claims.updated_at
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO claim_activity (
          claim_id, activity_type, notes, actor_email, actor_name
        ) VALUES (?, 'document_added', ?, ?, ?)
      `).bind(
        claimId,
        `Uploaded ${docType}${vendor ? ` from ${vendor}` : ""}${amount !== null ? ` — $${amount.toFixed(2)}` : ""} (${file.name})`,
        actorEmail,
        actorEmail
      ),
      env.DB.prepare("UPDATE claims SET updated_at = datetime('now') WHERE claim_id = ?").bind(claimId)
    ]);

    void newId; // currently unused; reserved for future "approve quote inline" flow
  } catch (err) {
    console.error("handleDocumentUpload failed:", err);
    return manageHtml(500, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: `Failed to record upload: ${err && err.message ? err.message : String(err)}` }
    ));
  }

  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/manage/claim/${encodeURIComponent(claimId)}`, 303);
}

// POST /manage/claim/{id}/document/{docId}/delete — soft-delete a document row.
// Permission: uploader OR admin/super_admin.
async function handleDocumentDelete(request, env, auth, claimId, docId) {
  if (!checkOrigin(request)) {
    return manageHtml(403, renderManagePageWrap("<p>Bad origin. Refusing to process write.</p>"));
  }

  const detail = await fetchClaimDetail(env, auth, claimId);
  if (detail.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
  if (detail.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
  if (detail.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));

  const claim = detail.claim;
  const docIdNum = parseInt(docId, 10);
  if (isNaN(docIdNum)) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Invalid document id." }
    ));
  }

  // Find the doc row
  const doc = detail.photos.find(p => p.id === docIdNum);
  if (!doc) {
    return manageHtml(404, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Document not found." }
    ));
  }
  // Only quote/receipt rows can be deleted via this endpoint (no deleting customer photos)
  if (!DOCUMENT_TYPES.includes(doc.photo_type)) {
    return manageHtml(403, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Only Quote and Receipt documents can be deleted." }
    ));
  }
  if (!canMutateDocument(auth, doc)) {
    return manageHtml(403, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "You don't have permission to delete this document." }
    ));
  }

  // If this is the approved quote, block deletion (must be unapproved first)
  if (doc.photo_type === "Quote" && claim.approved_quote_id === docIdNum) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "This quote has already been approved and cannot be deleted." }
    ));
  }

  const actorEmail = auth.user.email || null;

  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE claim_photos SET deleted_at = datetime('now') WHERE id = ?").bind(docIdNum),
      env.DB.prepare(`
        INSERT INTO claim_activity (
          claim_id, activity_type, notes, actor_email, actor_name
        ) VALUES (?, 'document_added', ?, ?, ?)
      `).bind(
        claimId,
        `Deleted ${doc.photo_type}${doc.vendor ? ` from ${doc.vendor}` : ""} (${doc.filename || ""})`,
        actorEmail, actorEmail
      ),
      env.DB.prepare("UPDATE claims SET updated_at = datetime('now') WHERE claim_id = ?").bind(claimId)
    ]);
  } catch (err) {
    console.error("handleDocumentDelete failed:", err);
    return manageHtml(500, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Failed to delete document." }
    ));
  }

  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/manage/claim/${encodeURIComponent(claimId)}`, 303);
}

// POST /manage/claim/{id}/document/{docId}/edit — edit metadata only (vendor/amount/notes).
// To replace the file itself, delete and re-upload.
// Permission: uploader OR admin/super_admin.
async function handleDocumentEdit(request, env, auth, claimId, docId) {
  if (!checkOrigin(request)) {
    return manageHtml(403, renderManagePageWrap("<p>Bad origin. Refusing to process write.</p>"));
  }

  const detail = await fetchClaimDetail(env, auth, claimId);
  if (detail.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
  if (detail.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
  if (detail.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));

  const claim = detail.claim;
  const docIdNum = parseInt(docId, 10);
  if (isNaN(docIdNum)) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Invalid document id." }
    ));
  }

  const doc = detail.photos.find(p => p.id === docIdNum);
  if (!doc) {
    return manageHtml(404, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Document not found." }
    ));
  }
  if (!DOCUMENT_TYPES.includes(doc.photo_type)) {
    return manageHtml(403, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Only Quote and Receipt documents can be edited." }
    ));
  }
  if (!canMutateDocument(auth, doc)) {
    return manageHtml(403, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "You don't have permission to edit this document." }
    ));
  }

  const form = await readManageForm(request);
  const vendor = (form.get("vendor") || "").trim() || null;
  const amountStr = (form.get("amount") || "").trim();
  const notesText = (form.get("notes") || "").trim() || null;
  const payToTypeRaw = (form.get("pay_to_type") || "").trim().toLowerCase();
  const vendorAddress = (form.get("vendor_address") || "").trim() || null;

  let amount = null;
  if (amountStr) {
    const parsed = parseFloat(amountStr);
    if (isNaN(parsed) || parsed < 0) {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Amount must be a non-negative number." }
      ));
    }
    amount = parsed;
  }
  if (notesText && notesText.length > 5000) {
    return manageHtml(400, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Notes are too long (max 5000 characters)." }
    ));
  }

  // Validate pay_to_type — only on Quote rows, optional otherwise.
  let payToType = doc.pay_to_type || null;
  let payToVendorAddress = doc.vendor_address || null;
  if (doc.photo_type === "Quote") {
    if (payToTypeRaw && payToTypeRaw !== "customer" && payToTypeRaw !== "vendor") {
      return manageHtml(400, renderClaimDetail(
        auth, claim, detail.photos, detail.activity,
        { error: "Pay to must be 'customer' or 'vendor'." }
      ));
    }
    if (payToTypeRaw) {
      payToType = payToTypeRaw;
    }
    if (payToType === "vendor") {
      // If user blanked it but type is vendor, that's invalid
      if (!vendorAddress && !payToVendorAddress) {
        return manageHtml(400, renderClaimDetail(
          auth, claim, detail.photos, detail.activity,
          { error: "Vendor address is required when paying the vendor directly." }
        ));
      }
      // Take the new value if provided, else keep existing
      payToVendorAddress = vendorAddress || payToVendorAddress;
      if (payToVendorAddress.length > 1000) {
        return manageHtml(400, renderClaimDetail(
          auth, claim, detail.photos, detail.activity,
          { error: "Vendor address is too long (max 1000 characters)." }
        ));
      }
    } else if (payToType === "customer") {
      // Switching to customer clears any prior vendor address
      payToVendorAddress = null;
    }
  }

  const actorEmail = auth.user.email || null;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE claim_photos SET vendor = ?, amount = ?, notes = ?, pay_to_type = ?, vendor_address = ? WHERE id = ?"
      ).bind(vendor, amount, notesText, payToType, payToVendorAddress, docIdNum),
      env.DB.prepare(`
        INSERT INTO claim_activity (
          claim_id, activity_type, notes, actor_email, actor_name
        ) VALUES (?, 'document_added', ?, ?, ?)
      `).bind(
        claimId,
        `Edited ${doc.photo_type} (${doc.filename || ""})`,
        actorEmail, actorEmail
      ),
      env.DB.prepare("UPDATE claims SET updated_at = datetime('now') WHERE claim_id = ?").bind(claimId)
    ]);
  } catch (err) {
    console.error("handleDocumentEdit failed:", err);
    return manageHtml(500, renderClaimDetail(
      auth, claim, detail.photos, detail.activity,
      { error: "Failed to save edits." }
    ));
  }

  const url = new URL(request.url);
  return Response.redirect(`${url.origin}/manage/claim/${encodeURIComponent(claimId)}`, 303);
}

// ==================== CLAIM DETAIL FETCH ====================
async function fetchClaimDetail(env, auth, claimId) {
  if (!env.DB) {
    return { error: "D1 unavailable" };
  }

  // Pull the claim
  const claim = await env.DB
    .prepare("SELECT * FROM claims WHERE claim_id = ? AND deleted_at IS NULL")
    .bind(claimId)
    .first();

  if (!claim) {
    return { notFound: true };
  }

  // Authorization: non-admins must have this location in their scope
  if (!auth.isAdmin) {
    const userLocCodes = (auth.locations || []).map(l => l.location_code);
    if (!userLocCodes.includes(claim.location_code)) {
      return { forbidden: true };
    }
  }

  // Photos and activity
  const [photosResult, activityResult] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM claim_photos WHERE claim_id = ? AND deleted_at IS NULL ORDER BY id ASC"
    ).bind(claimId).all(),
    env.DB.prepare(
      "SELECT * FROM claim_activity WHERE claim_id = ? ORDER BY created_at DESC, id DESC"
    ).bind(claimId).all()
  ]);

  return {
    claim,
    photos: photosResult.results || [],
    activity: activityResult.results || []
  };
}

// Locations available to this user, for the filter dropdown.
// auth.locations is already populated and pre-sorted by checkClaimAuth; we re-sort
// defensively in case future callers ever populate it differently.
function getAvailableLocations(auth) {
  return [...(auth.locations || [])].sort((a, b) =>
    String(a.location_pretty || "").localeCompare(String(b.location_pretty || ""))
  );
}

// ==================== CLAIM STATUS CONSTANTS ====================
const CLAIM_STATUSES = [
  "New — Pending Review",
  "No Responsibility — Pending Review",
  "Pending GM Review",
  "Pending RM Review",
  "Approved — Pending Quotes",
  "Pending RM Quote Approval",
  "Approved — In House — Parts Ordered",
  "Approved — In House — Repaired",
  "Approved — Check Request Submitted",
  "Approved — Pending CEO Approval",
  "Approved — Check Issued",
  "Closed — Paid",
  "Closed — Denied",
  "Closed — Approved/No Response"
];

// Returns an HTML span for the claim's age, color-coded by how long it's been open.
// 1-2 days green, 3-6 days yellow, 7+ days red. Closed claims get a neutral gray.
function renderAgeBadge(claim) {
  if (!claim.submitted_at) return "—";
  const submitted = new Date(claim.submitted_at).getTime();
  const isClosed = claim.lifecycle_state === "Closed";
  const endTime = isClosed && claim.status_updated_at
    ? new Date(claim.status_updated_at).getTime()
    : Date.now();
  const days = Math.floor((endTime - submitted) / (1000 * 60 * 60 * 24));

  if (isClosed) {
    const label = days === 0 ? "Closed same day" : `Closed after ${days}d`;
    return `<span class="age-pill age-closed">${label}</span>`;
  }

  let tone;
  if (days <= 2)      tone = "green";
  else if (days <= 6) tone = "yellow";
  else                tone = "red";

  const label = days === 0 ? "<1d" : `${days}d`;
  return `<span class="age-pill age-${tone}">${label}</span>`;
}

// Returns array of attention flags for a claim. Empty array = nothing flagged.
function getAttentionFlags(claim) {
  const flags = [];

  if (claim.lifecycle_state === "Open" && claim.contact_status === "Not Started") {
    flags.push({ label: "No outreach", tone: "info", title: "Customer has not been contacted" });
  }

  return flags;
}

// CSRF defense: confirm the request came from our own origin.
// SameSite=Strict cookies are the primary protection; this is belt-and-suspenders.
function checkOrigin(request) {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  const url = new URL(request.url);
  const expected = `${url.protocol}//${url.host}`;

  if (origin) {
    return origin === expected;
  }
  if (referer) {
    try {
      return new URL(referer).origin === expected;
    } catch (e) {
      return false;
    }
  }
  // No Origin or Referer header — refuse rather than guess.
  return false;
}

// ==================== COOKIE UTILITY ====================
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach(cookie => {
    const [name, value] = cookie.trim().split("=");
    if (name) cookies[name] = value;
  });
  return cookies;
}

// ==================== AUTH ====================
async function checkClaimAuth(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const accessToken = cookies["sb-access-token"];

  if (!accessToken) {
    return { authenticated: false };
  }

  // Validate token with Supabase
  const userResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!userResponse.ok) {
    return { authenticated: false };
  }

  const user = await userResponse.json();

  // ============== TOOL ACCESS GATE (Phase 3.5) ==============
  // Verify user is allowed in this tool at all. Bypass for super_admins
  // (user_permissions.role = 'super_admin' — separate from damage_claim's dc_role
  // 'super_admin' which still gates inside-the-tool behavior). Otherwise require
  // a user_tool_access row for tool='claims'.
  // This gate fires BEFORE the dc_role lookup so the failure mode is distinct:
  // "no claims access at all" vs. "in claims but no dc_role".
  let bypassToolGate = false;
  const sysPermResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/user_permissions?user_id=eq.${user.id}&role=eq.super_admin&select=role`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (sysPermResp.ok) {
    const sysPerms = await sysPermResp.json();
    if (Array.isArray(sysPerms) && sysPerms.length > 0) bypassToolGate = true;
  }

  if (!bypassToolGate) {
    const toolGrantResp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_tool_access?user_id=eq.${user.id}&tool=eq.claims&select=tool`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      }
    );
    if (!toolGrantResp.ok) {
      console.error("user_tool_access lookup failed:", toolGrantResp.status);
      return { authenticated: false, reason: "tool_access_lookup_failed", user };
    }
    const grants = await toolGrantResp.json();
    if (!Array.isArray(grants) || grants.length === 0) {
      return { authenticated: false, reason: "tool_not_granted", user };
    }
  }

  // Look up dc_role + must_change_password from damage_claim_user_roles
  const roleResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/damage_claim_user_roles?user_id=eq.${user.id}&select=dc_role,must_change_password`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );

  if (!roleResponse.ok) {
    console.error("damage_claim_user_roles lookup failed:", roleResponse.status);
    return { authenticated: false };
  }

  const roleRows = await roleResponse.json();

  if (!roleRows || roleRows.length === 0) {
    return { authenticated: false, reason: "no_permissions" };
  }

  const { dc_role, must_change_password } = roleRows[0];
  const isSuperAdmin = dc_role === "super_admin";
  const isAdmin = dc_role === "admin" || isSuperAdmin;

  // Determine accessible D1 locations.
  // Admins → all rows from D1 locations.
  // Non-admins → resolve site_numbers from Supabase by email match,
  //              then look up matching D1 locations.
  let locations = [];

  if (isAdmin) {
    if (env.DB) {
      try {
        const result = await env.DB.prepare(
          "SELECT location_code, location_pretty, site_number FROM locations WHERE is_active = 1 ORDER BY location_pretty ASC"
        ).all();
        locations = result.results || [];
      } catch (err) {
        console.error("D1 locations fetch failed for admin:", err);
      }
    }
  } else {
    const userEmail = (user.email || "").toLowerCase();
    if (userEmail) {
      // Step A: site_numbers from Supabase locations matched by email
      const orClause = `or=(site_email.eq.${encodeURIComponent(userEmail)},am_email.eq.${encodeURIComponent(userEmail)},rm_email.eq.${encodeURIComponent(userEmail)})`;
      const sbResponse = await fetch(
        `${env.SUPABASE_URL}/rest/v1/locations?${orClause}&select=site_number`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
          }
        }
      );
      if (sbResponse.ok) {
        const sbRows = await sbResponse.json();
        const siteNumbers = [...new Set(sbRows.map(r => r.site_number).filter(n => n != null))];

        // Step B: D1 locations with those site_numbers
        if (siteNumbers.length > 0 && env.DB) {
          try {
            const placeholders = siteNumbers.map(() => "?").join(",");
            const result = await env.DB.prepare(
              `SELECT location_code, location_pretty, site_number FROM locations WHERE site_number IN (${placeholders}) AND is_active = 1 ORDER BY location_pretty ASC`
            ).bind(...siteNumbers).all();
            locations = result.results || [];
          } catch (err) {
            console.error("D1 locations fetch failed for user:", err);
          }
        }
      } else {
        console.error("Supabase locations email match failed:", sbResponse.status);
      }
    }
  }

  return {
    authenticated: true,
    user,
    dc_role,
    role: dc_role,  // alias for compatibility with step 3/4 code
    isSuperAdmin,
    isAdmin,
    mustChangePassword: must_change_password === true,
    locations
  };
}

// ==================== LOGIN / LOGOUT / CHANGE PASSWORD ====================
async function handleManageLogin(request, env) {
  const form = await readManageForm(request);
  const email = (form.get("email") || "").trim();
  const password = (form.get("password") || "").trim();

  if (!email || !password) {
    return manageHtml(400, renderManageLoginPage("Email and password are required"));
  }

  const authResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });

  if (!authResponse.ok) {
    return manageHtml(401, renderManageLoginPage("Invalid email or password"));
  }

  const authData = await authResponse.json();

  // Verify the user actually has damage claim permissions before issuing cookies
  const permResponse = await fetch(
    `${env.SUPABASE_URL}/rest/v1/damage_claim_user_roles?user_id=eq.${authData.user.id}&select=dc_role`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    }
  );

  if (!permResponse.ok) {
    return manageHtml(500, renderManageLoginPage("Permissions lookup failed"));
  }

  const perms = await permResponse.json();
  if (!perms || perms.length === 0) {
    return manageHtml(403, renderManageLoginPage(
      "Your account does not have access to the damage claim system. Contact an administrator."
    ));
  }

  return new Response("", {
    status: 302,
    headers: {
      "Location": "/manage",
      "Set-Cookie":
        `sb-access-token=${authData.access_token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600, ` +
        `sb-refresh-token=${authData.refresh_token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
    }
  });
}

async function handleManageLogout() {
  return new Response("", {
    status: 302,
    headers: {
      "Location": "/manage/login",
      "Set-Cookie":
        "sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0, " +
        "sb-refresh-token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    }
  });
}

async function handleManageChangePassword(request, env, auth) {
  const user = auth.user;
  const form = await readManageForm(request);
  const newPassword = (form.get("new_password") || "").trim();
  const confirmPassword = (form.get("confirm_password") || "").trim();

  if (!newPassword || newPassword.length < 8) {
    return manageHtml(400, renderManageChangePasswordPage("Password must be at least 8 characters", false, auth));
  }
  if (newPassword !== confirmPassword) {
    return manageHtml(400, renderManageChangePasswordPage("Passwords do not match", false, auth));
  }

  // Update the password via Supabase admin API
  const updateResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password: newPassword })
  });

  if (!updateResponse.ok) {
    const errData = await updateResponse.json().catch(() => ({}));
    const msg = errData.msg || "Password requirements not met";
    return manageHtml(400, renderManageChangePasswordPage(msg, false, auth));
  }

  // Clear must_change_password flag in damage_claim_user_roles
  await fetch(`${env.SUPABASE_URL}/rest/v1/damage_claim_user_roles?user_id=eq.${user.id}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ must_change_password: false, updated_at: new Date().toISOString() })
  });

  return manageHtml(200, renderManageChangePasswordPage("Password successfully updated! Redirecting...", true, auth));
}

// Form parser scoped to /manage routes (mirrors signup worker's readForm)
async function readManageForm(request) {
  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("application/x-www-form-urlencoded")) return new URLSearchParams(await request.text());
  if (ctype.includes("multipart/form-data")) return await request.formData();
  if (ctype.includes("application/json")) {
    const obj = await request.json().catch(() => ({}));
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) sp.set(k, String(v));
    return sp;
  }
  return new URLSearchParams(new URL(request.url).search);
}

function manageHtml(status, body) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

// ==================== /manage/* DISPATCHER ====================
async function handleManageRoutes(request, env, parts) {
  const url = new URL(request.url);

  // Login page (no auth required)
  if (parts[1] === "login" && request.method === "GET") {
    return manageHtml(200, renderManageLoginPage());
  }
  if (parts[1] === "login" && request.method === "POST") {
    return handleManageLogin(request, env);
  }

  // Logout (no auth required — clears cookies regardless)
  if (parts[1] === "logout") {
    return handleManageLogout();
  }

  // Everything below requires auth
  const auth = await checkClaimAuth(request, env);

  // Helper: did auth fail because tool access is denied (vs. invalid/missing token)?
  const isToolAccessFailure = (a) =>
    a && !a.authenticated && (a.reason === "tool_not_granted" || a.reason === "tool_access_lookup_failed");

  // Change password (requires valid auth, but not "must_change" satisfied yet)
  if (parts[1] === "change-password") {
    if (!auth.authenticated) {
      if (isToolAccessFailure(auth)) {
        return manageHtml(403, renderClaimsForbidden(auth.user && auth.user.email));
      }
      return Response.redirect(`${url.origin}/manage/login`, 302);
    }
    if (request.method === "GET") {
      return manageHtml(200, renderManageChangePasswordPage("", false, auth));
    }
    if (request.method === "POST") {
      return handleManageChangePassword(request, env, auth);
    }
  }

  // All other /manage/* routes require auth
  if (!auth.authenticated) {
    if (isToolAccessFailure(auth)) {
      return manageHtml(403, renderClaimsForbidden(auth.user && auth.user.email));
    }
    return Response.redirect(`${url.origin}/manage/login`, 302);
  }

  if (auth.mustChangePassword) {
    return Response.redirect(`${url.origin}/manage/change-password?required=true`, 302);
  }

  // /manage root → claim list
  if (!parts[1] || parts[1] === "") {
    const url2 = new URL(request.url);
    const filters = {
      search: url2.searchParams.get("search") || "",
      location: url2.searchParams.get("location") || "All",
      status: url2.searchParams.get("status") || "All",
      lifecycle: url2.searchParams.get("lifecycle") || "Open"
    };

    const claims = await fetchClaimsForUser(env, auth, filters);
    const locations = getAvailableLocations(auth);

    return manageHtml(200, renderClaimList(auth, claims, locations, filters));
  }

  // /manage/claim/{id}/note — POST add note (must be before the GET handler below)
  if (parts[1] === "claim" && parts[2] && parts[3] === "note" && request.method === "POST") {
    const claimId = decodeURIComponent(parts[2]);
    return handleAddNote(request, env, auth, claimId);
  }

  // /manage/claim/{id}/transition — POST status change
  if (parts[1] === "claim" && parts[2] && parts[3] === "transition" && request.method === "POST") {
    const claimId = decodeURIComponent(parts[2]);
    return handleStatusTransition(request, env, auth, claimId);
  }

  // /manage/claim/{id}/document — POST upload a Quote or Receipt
  if (parts[1] === "claim" && parts[2] && parts[3] === "document" && !parts[4] && request.method === "POST") {
    const claimId = decodeURIComponent(parts[2]);
    return handleDocumentUpload(request, env, auth, claimId);
  }

  // /manage/claim/{id}/document/{docId}/delete — POST soft-delete
  if (parts[1] === "claim" && parts[2] && parts[3] === "document" && parts[4] && parts[5] === "delete" && request.method === "POST") {
    const claimId = decodeURIComponent(parts[2]);
    const docId = decodeURIComponent(parts[4]);
    return handleDocumentDelete(request, env, auth, claimId, docId);
  }

  // /manage/claim/{id}/document/{docId}/edit — POST edit metadata
  if (parts[1] === "claim" && parts[2] && parts[3] === "document" && parts[4] && parts[5] === "edit" && request.method === "POST") {
    const claimId = decodeURIComponent(parts[2]);
    const docId = decodeURIComponent(parts[4]);
    return handleDocumentEdit(request, env, auth, claimId, docId);
  }

  // /manage/claim/{id}/quote/{quoteId}/preview-check-request.pdf — GET preview
  if (parts[1] === "claim" && parts[2] && parts[3] === "quote" && parts[4] && parts[5] === "preview-check-request.pdf" && request.method === "GET") {
    const claimId = decodeURIComponent(parts[2]);
    const quoteId = decodeURIComponent(parts[4]);
    return handleCheckRequestPreview(request, env, auth, claimId, quoteId);
  }

  // /manage/claim/{id} — detail page
  if (parts[1] === "claim" && parts[2] && !parts[3]) {
    const claimId = decodeURIComponent(parts[2]);
    const result = await fetchClaimDetail(env, auth, claimId);
    if (result.error)     return manageHtml(500, renderManagePageWrap("<p>Error loading claim.</p>"));
    if (result.notFound)  return manageHtml(404, renderClaimNotFound(claimId, auth));
    if (result.forbidden) return manageHtml(403, renderClaimForbidden(claimId, auth));
    return manageHtml(200, renderClaimDetail(auth, result.claim, result.photos, result.activity));
  }

  return manageHtml(404, renderManagePageWrap("<p>Not found.</p>"));
}

// ==================== PAGE RENDERERS ====================
// Shared CSS for all /manage/* pages.
// Single source of truth for the Splash brand palette and chrome.
const MANAGE_STYLES = `
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --sudsy-blue-soft: #d6f1fb;
    --splash-navy: #1c164e;
    --cream: #f5eedd;
    --yellow: #f1c61e;
    --racecar-red: #dc3e26;
    --gray-light: #dbdbdb;
    --gray-dark: #3a3f47;
    --white: #ffffff;
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: var(--font-body);
    color: var(--white);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    min-height: 100vh;
  }

  /* Page chrome */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 32px;
    flex-wrap: wrap;
    gap: 16px;
  }
  .page-header-left { display: flex; align-items: center; gap: 18px; }
  .page-header-brand {
    display: flex;
    align-items: center;
    gap: 18px;
    text-decoration: none;
    color: inherit;
    transition: opacity 0.15s ease;
  }
  .page-header-brand:hover { opacity: 0.85; }
  .page-header-logo { height: 56px; width: auto; }
  .page-nav-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    color: rgba(255,255,255,0.85);
    text-decoration: none;
    border: 1.5px solid rgba(255,255,255,0.25);
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    font-family: var(--font-body);
    font-weight: 600;
    font-size: 0.8125rem;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  .page-nav-back:hover {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.5);
    color: var(--white);
  }
  .page-nav-back svg { width: 14px; height: 14px; flex-shrink: 0; }
  .page-header-text { display: flex; flex-direction: column; gap: 2px; }
  .page-eyebrow {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--sudsy-blue);
  }
  .page-name {
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--white);
    margin: 0;
    line-height: 1.2;
  }
  .page-header-brand .page-name { color: var(--white); }
  .page-name-monospace {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1.05rem;
  }
  .page-name-meta {
    font-size: 0.8125rem;
    font-weight: 400;
    color: rgba(255,255,255,0.75);
    margin-top: 3px;
  }
  .page-header-right { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .page-user { color: rgba(255,255,255,0.85); font-size: 0.875rem; }
  .page-action-btn {
    padding: 8px 18px;
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--white);
    background: transparent;
    border: 1.5px solid rgba(255,255,255,0.5);
    border-radius: var(--radius-sm);
    text-decoration: none;
    transition: background 0.2s ease, border-color 0.2s ease;
    cursor: pointer;
    display: inline-block;
  }
  .page-action-btn:hover { background: rgba(255,255,255,0.1); border-color: var(--white); }

  .page-content {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 24px 48px;
  }

  /* Cards */
  .card {
    background: var(--white);
    color: var(--splash-navy);
    border-radius: var(--radius-lg);
    padding: 22px 24px;
    margin-bottom: 18px;
    box-shadow: var(--shadow-card);
  }
  .card h2.section-h {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--sudsy-blue);
    margin: 0 0 14px;
  }

  .mut { color: var(--gray-dark); font-size: 0.8125rem; }
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 20px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--sudsy-blue-soft);
    color: var(--splash-blue);
  }
  a.link {
    color: var(--sudsy-blue);
    text-decoration: none;
    font-size: 0.875rem;
  }
  a.link:hover { text-decoration: underline; }

  /* Generic primary button */
  .btn-primary {
    padding: 9px 18px;
    background: var(--splash-blue);
    color: var(--white);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 700;
    font-family: inherit;
    transition: background 0.2s ease;
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
  .btn-primary:disabled { background: var(--gray-light); cursor: not-allowed; }
`;

// Render a /manage/* page chrome.
// inner:    HTML string for the main content area
// opts:     { title, eyebrow, pageName, pageNameMeta, monospacePageName, auth, hideHeader }
function renderManagePageWrap(inner, opts = {}) {
  const t = (s) => String(s ?? "").replace(/[&<>"']/g, m => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
  ));

  // Backward-compat: if opts is a string, treat it as the page title (legacy callers).
  if (typeof opts === "string") opts = { title: opts };

  const title = opts.title || opts.pageName || "Damage Claims";
  const eyebrow = opts.eyebrow || "DAMAGE CLAIMS";
  const pageName = opts.pageName || "";
  const pageNameMeta = opts.pageNameMeta || "";
  const monospacePageName = !!opts.monospacePageName;
  const auth = opts.auth || null;

  let header = "";
  if (!opts.hideHeader && pageName) {
    const pageNameClass = monospacePageName ? "page-name page-name-monospace" : "page-name";
    const userInfoHtml = auth
      ? `
        <div class="page-header-right">
          <span class="page-user">${t(auth.user.email)}</span>
          <a href="/manage/change-password" class="page-action-btn">Change Password</a>
          <a href="/manage/logout" class="page-action-btn">Sign Out</a>
        </div>
      ` : "";
    header = `
      <div class="page-header">
        <div class="page-header-left">
          <a class="page-header-brand" href="/" title="Return to dashboard">
            <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Wash" class="page-header-logo"/>
            <div class="page-header-text">
              <span class="page-eyebrow">${t(eyebrow)}</span>
              <h1 class="${pageNameClass}">${t(pageName)}</h1>
              ${pageNameMeta ? `<div class="page-name-meta">${t(pageNameMeta)}</div>` : ""}
            </div>
          </a>
          <a class="page-nav-back" href="/" title="Return to dashboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            Dashboard
          </a>
        </div>
        ${userInfoHtml}
      </div>
    `;
  }

  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<title>${t(title)}</title>
<style>${MANAGE_STYLES}</style>
</head><body>
${header}
<div class="page-content">${inner}</div>
</body></html>`;
}

function renderManageLoginPage(error = "") {
  const errorHtml = error ? `<div class="login-error">${escapeManage(error)}</div>` : "";
  return `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<title>Damage Claims — Sign In</title>
<style>${MANAGE_STYLES}
  body { display: flex; align-items: center; justify-content: center; padding: 24px; }
  .login-card {
    width: 100%;
    max-width: 440px;
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--shadow-card);
    background: var(--white);
  }
  .login-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    padding: 36px 28px 28px;
    text-align: center;
    color: var(--white);
  }
  .login-logo {
    display: block;
    margin: 0 auto 14px;
    height: 78px;
    width: auto;
  }
  .login-eyebrow {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--sudsy-blue);
    margin-bottom: 4px;
  }
  .login-title {
    font-size: 1.375rem;
    font-weight: 700;
    color: var(--white);
    margin: 0;
  }
  .login-body {
    padding: 28px 32px 32px;
    background: var(--white);
    color: var(--splash-navy);
  }
  .login-intro {
    text-align: center;
    color: var(--gray-dark);
    font-size: 0.9375rem;
    margin: 0 0 22px;
    opacity: 0.85;
  }
  .login-field { margin-bottom: 14px; }
  .login-field label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--splash-navy);
    margin-bottom: 6px;
  }
  .login-field .req { color: var(--sudsy-blue); font-weight: 700; }
  .login-field input {
    width: 100%;
    height: 42px;
    padding: 8px 14px;
    font-size: 0.9375rem;
    color: var(--splash-navy);
    background: var(--white);
    border: 1.5px solid var(--gray-light);
    border-radius: var(--radius-sm);
    font-family: inherit;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  .login-field input::placeholder { color: #9aa0a6; }
  .login-field input:hover { border-color: var(--sudsy-blue); }
  .login-field input:focus {
    border-color: var(--splash-blue);
    box-shadow: 0 0 0 3px rgba(61, 190, 238, 0.25);
    outline: none;
  }
  .login-submit {
    width: 100%;
    height: 46px;
    margin-top: 10px;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--white);
    background: var(--splash-blue);
    border: none;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-btn);
    cursor: pointer;
    font-family: inherit;
    transition: background 0.2s ease;
  }
  .login-submit:hover { background: var(--splash-blue-dark); }
  .login-error {
    margin-top: 16px;
    padding: 10px 14px;
    background: var(--racecar-red);
    color: var(--white);
    font-size: 0.875rem;
    font-weight: 600;
    text-align: center;
    border-radius: var(--radius-sm);
  }
</style>
</head>
<body>
  <div class="login-card">
    <div class="login-header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Wash" class="login-logo"/>
      <div class="login-eyebrow">Internal Tools</div>
      <h1 class="login-title">Sign In</h1>
    </div>
    <div class="login-body">
      <p class="login-intro">Sign in with your Splash account to continue.</p>
      <form method="POST" action="/manage/login">
        <div class="login-field">
          <label for="email">Email Address <span class="req">*</span></label>
          <input type="email" id="email" name="email" placeholder="your.name@splashcarwashes.com" required autocomplete="email" autofocus/>
        </div>
        <div class="login-field">
          <label for="password">Password <span class="req">*</span></label>
          <input type="password" id="password" name="password" placeholder="Enter password" required autocomplete="current-password"/>
        </div>
        <button type="submit" class="login-submit">Sign In</button>
        ${errorHtml}
      </form>
    </div>
  </div>
</body>
</html>`;
}

function renderManageChangePasswordPage(message = "", success = false, auth = null) {
  const messageHtml = message
    ? `<div class="cp-${success ? "success" : "error"}">${escapeManage(message)}</div>`
    : "";
  const inner = `
    <div class="card cp-card">
      ${messageHtml}
      <form method="POST">
        <div class="cp-field">
          <label for="new_password">New Password <span class="req">*</span></label>
          <input type="password" id="new_password" name="new_password" placeholder="Min 8 characters" required minlength="8" autocomplete="new-password"/>
        </div>
        <div class="cp-field">
          <label for="confirm_password">Confirm New Password <span class="req">*</span></label>
          <input type="password" id="confirm_password" name="confirm_password" placeholder="Confirm new password" required minlength="8" autocomplete="new-password"/>
        </div>
        <button type="submit" class="cp-submit">Update Password</button>
      </form>
      <div class="cp-back"><a href="/manage" class="link">&larr; Back to claims</a></div>
    </div>
    <style>
      .cp-card { max-width: 480px; margin: 24px auto 0; }
      .cp-field { margin-bottom: 14px; }
      .cp-field label {
        display: block;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--splash-navy);
        margin-bottom: 6px;
      }
      .cp-field .req { color: var(--sudsy-blue); font-weight: 700; }
      .cp-field input {
        width: 100%;
        height: 42px;
        padding: 8px 14px;
        font-size: 0.9375rem;
        color: var(--splash-navy);
        background: var(--white);
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-family: inherit;
      }
      .cp-field input:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.25);
      }
      .cp-submit {
        width: 100%;
        height: 46px;
        margin-top: 8px;
        font-size: 1rem;
        font-weight: 700;
        color: var(--white);
        background: var(--splash-blue);
        border: none;
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-btn);
        cursor: pointer;
        font-family: inherit;
      }
      .cp-submit:hover { background: var(--splash-blue-dark); }
      .cp-error {
        margin-bottom: 14px;
        padding: 10px 14px;
        background: var(--racecar-red);
        color: var(--white);
        font-size: 0.875rem;
        font-weight: 600;
        text-align: center;
        border-radius: var(--radius-sm);
      }
      .cp-success {
        margin-bottom: 14px;
        padding: 10px 14px;
        background: #d1fae5;
        color: #065f46;
        font-size: 0.875rem;
        font-weight: 600;
        text-align: center;
        border: 1px solid #6ee7b7;
        border-radius: var(--radius-sm);
      }
      .cp-back { text-align: center; margin-top: 18px; }
    </style>
    ${success ? '<script>setTimeout(() => window.location.href = "/manage", 1800)</script>' : ""}
  `;
  return renderManagePageWrap(inner, {
    title: "Change Password",
    eyebrow: "INTERNAL TOOLS",
    pageName: "Change Password",
    auth,
  });
}

// ==================== PAGE RENDERER: CLAIM DETAIL ====================
// Render the status-transition section of the Actions card.
// Returns HTML for prominent buttons + (admin) dropdown + deferred notices.
function renderTransitionActions(claim, auth, photos = []) {
  const escFn = escapeManage;
  const { prominent, dropdown, deferred } = getValidTransitionsForUser(claim, auth);

  if (prominent.length === 0 && dropdown.length === 0 && deferred.length === 0) {
    return `<div class="no-actions mut">No status changes available from this state for your role.</div>`;
  }

  // Pull live quotes/receipts for guard checks + UI rendering
  const quotes = photos.filter(p => p.photo_type === "Quote" && !p.deleted_at);
  const receipts = photos.filter(p => p.photo_type === "Receipt" && !p.deleted_at);

  // Each prominent transition is its own form. The shape of the form depends on the
  // transition's required-inputs profile.
  const prominentHtml = prominent.map(t => {
    const reopenClass = t.reopen ? " trans-reopen" : "";
    const noteField = t.requiresNote || t.noteLabel
      ? `<textarea name="note" rows="2" maxlength="5000" ${t.requiresNote ? "required" : ""}
          placeholder="${escFn(t.notePlaceholder || "")}"></textarea>`
      : "";
    const noteLabel = (t.requiresNote || t.noteLabel)
      ? `<label class="trans-note-label">${escFn(t.noteLabel || "Note")}</label>`
      : "";

    // ---- Approve — In House Repair: requires parts + vendor + receipt on file
    const inputsList = t.requiresInputs || t.optionalInputs;
    if (inputsList && inputsList.includes("parts")) {
      const isOptional = !!t.optionalInputs;
      const reqAttr = isOptional ? "" : "required";
      const labelSuffix = isOptional ? "(optional)" : "(required)";
      return `
        <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/transition" class="trans-form${reopenClass}">
          <input type="hidden" name="to_status" value="${escFn(t.to)}"/>
          <button type="submit" class="btn-trans">${escFn(t.label)}</button>
          <label class="trans-note-label">Parts ${labelSuffix}</label>
          <input type="text" name="parts" maxlength="1000" ${reqAttr} placeholder="e.g. Front bumper, headlight assembly"/>
          <label class="trans-note-label">Vendor ${labelSuffix}</label>
          <input type="text" name="vendor" maxlength="1000" ${reqAttr} placeholder="Vendor / supplier"/>
        </form>
      `;
    }

    // ---- Approve Quote: explicit selection of one uploaded quote
    if (t.requiresQuoteSelection) {
      if (quotes.length === 0) {
        return `
          <div class="trans-form trans-gated">
            <button type="button" class="btn-trans btn-trans-gated" disabled title="Upload a quote before approving">${escFn(t.label)}</button>
            <div class="trans-gated-msg"><strong>Quote required.</strong> Upload at least one quote in the Documents section below to enable this action.</div>
          </div>
        `;
      }
      const quoteOptions = quotes.map(q => {
        const amt = q.amount !== null && q.amount !== undefined ? `$${Number(q.amount).toFixed(2)}` : "no amount";
        const vend = q.vendor || "unknown vendor";
        return `<option value="${q.id}">${escFn(vend)} — ${escFn(amt)}${q.filename ? ` (${escFn(q.filename)})` : ""}</option>`;
      }).join("");
      return `
        <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/transition" class="trans-form${reopenClass}">
          <input type="hidden" name="to_status" value="${escFn(t.to)}"/>
          <button type="submit" class="btn-trans">${escFn(t.label)}</button>
          <label class="trans-note-label">Select quote (required)</label>
          <select name="quote_id" required>
            <option value="">Choose a quote…</option>
            ${quoteOptions}
          </select>
          <span class="trans-blocked-note">If quote amount &gt; $${CEO_APPROVAL_THRESHOLD}, status routes to CEO Approval.</span>
        </form>
      `;
    }

    // ---- Default: simple transition with optional note. Honor requiresReceiptOnFile here too.
    if (t.requiresReceiptOnFile && receipts.length === 0) {
      return `
        <div class="trans-form trans-gated">
          <button type="button" class="btn-trans btn-trans-gated" disabled title="Upload a receipt before this action">${escFn(t.label)}</button>
          <div class="trans-gated-msg"><strong>Receipt required.</strong> Upload one in the Documents section below to enable this action.</div>
        </div>
      `;
    }
    return `
      <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/transition" class="trans-form${reopenClass}">
        <input type="hidden" name="to_status" value="${escFn(t.to)}"/>
        <button type="submit" class="btn-trans">${escFn(t.label)}</button>
        ${noteLabel}
        ${noteField}
      </form>
    `;
  }).join("");

  // Deferred transitions render as disabled tiles
  const deferredHtml = deferred.map(t =>
    `<div class="trans-deferred">
      <span class="trans-deferred-label">${escFn(t.label)}</span>
      <span class="trans-deferred-note">Coming in step ${escFn(t.deferred)} — requires file upload</span>
    </div>`
  ).join("");

  // Dropdown for admin/super_admin: any non-prominent valid transition
  let dropdownHtml = "";
  if (dropdown.length > 0 && auth.isAdmin) {
    const opts = dropdown.map(t =>
      `<option value="${escFn(t.to)}">${escFn(t.label)} (→ ${escFn(t.to)})</option>`
    ).join("");
    dropdownHtml = `
      <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/transition" class="trans-dropdown-form">
        <label class="trans-note-label">Other transitions <span class="admin-tag">admin</span></label>
        <select name="to_status" required>
          <option value="">Choose…</option>
          ${opts}
        </select>
        <textarea name="note" rows="2" maxlength="5000" placeholder="Optional note"></textarea>
        <button type="submit" class="btn-trans-secondary">Apply</button>
      </form>
    `;
  }

  return `
    <div class="trans-section">
      ${prominent.length > 0 ? `<div class="trans-grid">${prominentHtml}</div>` : ""}
      ${deferredHtml ? `<div class="trans-deferred-grid">${deferredHtml}</div>` : ""}
      ${dropdownHtml}
    </div>
  `;
}

// Render the Documents card (Quote/Receipt management).
// Lists existing docs, shows upload form, allows edit/delete of own uploads + admin override.
function renderDocumentsCard(claim, auth, photos) {
  const escFn = escapeManage;
  const quotes = photos.filter(p => p.photo_type === "Quote" && !p.deleted_at);
  const receipts = photos.filter(p => p.photo_type === "Receipt" && !p.deleted_at);
  const checkRequests = photos.filter(p => p.photo_type === "Check Request" && !p.deleted_at);

  const renderDocRow = (doc) => {
    const isPdf = (doc.content_type || "").toLowerCase().includes("pdf");
    const url = `/claims-api/photo/${(doc.r2_key || "").replace(/^claims\//, "")}`;
    const tile = isPdf
      ? `<a class="doc-tile doc-tile-pdf" href="${escFn(url)}" target="_blank" rel="noopener">PDF</a>`
      : `<div class="doc-tile doc-tile-img" data-src="${escFn(url)}" data-caption="${escFn(doc.photo_type + (doc.vendor ? ' — ' + doc.vendor : ''))}">
          <img src="${escFn(url)}" alt="${escFn(doc.photo_type)}" loading="lazy"/>
        </div>`;

    const amount = doc.amount !== null && doc.amount !== undefined
      ? `$${Number(doc.amount).toFixed(2)}`
      : "—";

    const isApprovedQuote = doc.photo_type === "Quote" && claim.approved_quote_id === doc.id;
    const canMutate = canMutateDocument(auth, doc);

    // Preview Check Request button — appears on Quote rows that have all required fields.
    // Anyone with claim access can preview (not gated by canMutate).
    let previewButton = "";
    if (doc.photo_type === "Quote" && !isApprovedQuote) {
      const hasAmount = doc.amount !== null && doc.amount !== undefined;
      const hasPayTo = !!doc.pay_to_type;
      const hasVendorAddrIfNeeded = doc.pay_to_type !== "vendor" || !!doc.vendor_address;
      if (hasAmount && hasPayTo && hasVendorAddrIfNeeded) {
        const previewUrl = `/manage/claim/${escFn(claim.claim_id)}/quote/${doc.id}/preview-check-request.pdf`;
        previewButton = `<a class="doc-action-btn doc-action-preview" href="${previewUrl}" target="_blank" rel="noopener">Preview Check Request</a>`;
      }
    }

    const actions = canMutate && !isApprovedQuote ? `
      <div class="doc-actions">
        ${previewButton}
        <button type="button" class="doc-action-btn" data-edit-id="${doc.id}">Edit</button>
        <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/document/${doc.id}/delete" style="display:inline" onsubmit="return confirm('Delete this ${escFn(doc.photo_type.toLowerCase())}?');">
          <button type="submit" class="doc-action-btn doc-action-delete">Delete</button>
        </form>
      </div>
    ` : isApprovedQuote ? `<div class="doc-approved-tag">Approved</div>`
      : previewButton ? `<div class="doc-actions">${previewButton}</div>` : "";

    // Pay-to summary (only for Quotes)
    let payToSummary = "";
    if (doc.photo_type === "Quote") {
      if (doc.pay_to_type === "vendor") {
        payToSummary = `<div class="doc-pay-to mut">Pay to: <strong>Vendor directly</strong>${doc.vendor_address ? ` · ${escFn(doc.vendor_address.replace(/\n/g, ", "))}` : ""}</div>`;
      } else if (doc.pay_to_type === "customer") {
        payToSummary = `<div class="doc-pay-to mut">Pay to: <strong>Customer</strong></div>`;
      } else {
        payToSummary = `<div class="doc-pay-to mut" style="color:var(--racecar-red)">Pay to: <strong>not set</strong> — required before approval</div>`;
      }
    }

    return `
      <div class="doc-row${isApprovedQuote ? ' doc-row-approved' : ''}">
        ${tile}
        <div class="doc-meta">
          <div class="doc-vendor">${escFn(doc.vendor || "(no vendor)")}</div>
          <div class="doc-amount">${escFn(amount)}</div>
          <div class="doc-filename mut">${escFn(doc.filename || "")}</div>
          ${doc.notes ? `<div class="doc-notes">${escFn(doc.notes)}</div>` : ""}
          ${payToSummary}
          <div class="doc-uploader mut">${escFn(doc.uploaded_by || "—")}</div>
          ${actions}
        </div>
        ${canMutate && !isApprovedQuote ? `
          <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/document/${doc.id}/edit" class="doc-edit-form" id="doc-edit-${doc.id}" style="display:none">
            <label class="trans-note-label">Vendor</label>
            <input type="text" name="vendor" value="${escFn(doc.vendor || "")}" maxlength="500" placeholder="Vendor"/>
            <label class="trans-note-label">Amount</label>
            <input type="number" name="amount" value="${doc.amount !== null && doc.amount !== undefined ? Number(doc.amount).toFixed(2) : ""}" min="0" step="0.01" placeholder="0.00"/>
            <label class="trans-note-label">Notes</label>
            <textarea name="notes" rows="2" maxlength="5000" placeholder="Optional notes">${escFn(doc.notes || "")}</textarea>
            ${doc.photo_type === "Quote" ? `
              <label class="trans-note-label">Pay to</label>
              <div class="doc-pay-to-radios">
                <label class="doc-radio"><input type="radio" name="pay_to_type" value="customer" ${doc.pay_to_type !== "vendor" ? "checked" : ""}/> Customer (default)</label>
                <label class="doc-radio"><input type="radio" name="pay_to_type" value="vendor" ${doc.pay_to_type === "vendor" ? "checked" : ""}/> Vendor directly</label>
              </div>
              <div class="doc-edit-vendor-addr-wrap" id="doc-edit-vendor-addr-${doc.id}" style="display:${doc.pay_to_type === "vendor" ? "" : "none"}">
                <label class="trans-note-label">Vendor address</label>
                <textarea name="vendor_address" rows="3" maxlength="1000" placeholder="Street, city, state, zip">${escFn(doc.vendor_address || "")}</textarea>
              </div>
              <script>
                (function(){
                  document.querySelectorAll('#doc-edit-${doc.id} input[name="pay_to_type"]').forEach(r => {
                    r.addEventListener('change', () => {
                      const wrap = document.getElementById('doc-edit-vendor-addr-${doc.id}');
                      if (wrap) wrap.style.display = (r.value === 'vendor' && r.checked) ? '' : 'none';
                    });
                  });
                })();
              </script>
            ` : ""}
            <div class="doc-edit-actions">
              <button type="submit" class="btn-trans">Save</button>
              <button type="button" class="doc-action-btn" data-cancel-id="${doc.id}">Cancel</button>
            </div>
          </form>
        ` : ""}
      </div>
    `;
  };

  const quotesHtml = quotes.length > 0
    ? `<div class="doc-group-title">Quotes <span class="photo-count">${quotes.length}</span></div>
       <div class="doc-list">${quotes.map(renderDocRow).join("")}</div>`
    : `<div class="doc-group-title">Quotes <span class="photo-count">0</span></div>
       <div class="empty-section">No quotes uploaded.</div>`;

  const receiptsHtml = receipts.length > 0
    ? `<div class="doc-group-title">Receipts <span class="photo-count">${receipts.length}</span></div>
       <div class="doc-list">${receipts.map(renderDocRow).join("")}</div>`
    : `<div class="doc-group-title">Receipts <span class="photo-count">0</span></div>
       <div class="empty-section">No receipts uploaded.</div>`;

  // Check Request PDFs are auto-generated by the system. No edit/delete in the UI.
  // Sorted oldest-first so the most recent is at the bottom (matches workflow ordering).
  const renderCheckRequestRow = (doc) => {
    const url = `/claims-api/photo/${(doc.r2_key || "").replace(/^claims\//, "")}`;
    const stage = doc.notes || "Generated";
    const ts = doc.uploaded_at
      ? new Date(doc.uploaded_at + "Z").toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short", day: "numeric", year: "numeric",
          hour: "numeric", minute: "2-digit"
        })
      : "";
    return `
      <div class="doc-row">
        <a class="doc-tile doc-tile-pdf" href="${escFn(url)}" target="_blank" rel="noopener">PDF</a>
        <div class="doc-meta">
          <div class="doc-vendor">${escFn(stage)}</div>
          <div class="doc-filename mut">${escFn(doc.filename || "")}</div>
          ${doc.amount !== null && doc.amount !== undefined
            ? `<div class="doc-amount">$${Number(doc.amount).toFixed(2)}</div>` : ""}
          <div class="doc-uploader mut">${escFn(ts)}</div>
        </div>
      </div>
    `;
  };
  const checkRequestsHtml = checkRequests.length > 0
    ? `<div class="doc-group-title">Check Requests <span class="photo-count">${checkRequests.length}</span></div>
       <div class="doc-list">${checkRequests.map(renderCheckRequestRow).join("")}</div>`
    : "";  // Hide section entirely until at least one is generated

  // Upload form (anyone with access to the claim can upload)
  const uploadFormHtml = `
    <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/document"
          enctype="multipart/form-data" class="doc-upload-form" id="docUploadForm">
      <div class="doc-upload-grid">
        <div>
          <label class="trans-note-label">Type (required)</label>
          <select name="doc_type" id="docUploadType" required>
            <option value="">Choose…</option>
            <option value="Quote">Quote</option>
            <option value="Receipt">Receipt</option>
          </select>
        </div>
        <div>
          <label class="trans-note-label">File (required)</label>
          <input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic,image/heif" required/>
        </div>
        <div>
          <label class="trans-note-label">Vendor</label>
          <input type="text" name="vendor" maxlength="500" placeholder="Vendor / supplier"/>
        </div>
        <div>
          <label class="trans-note-label">Amount</label>
          <input type="number" name="amount" min="0" step="0.01" placeholder="0.00"/>
        </div>
        <div class="doc-upload-notes">
          <label class="trans-note-label">Notes (optional)</label>
          <textarea name="notes" rows="2" maxlength="5000" placeholder="e.g. Quote includes parts only, labor TBD"></textarea>
        </div>
        <!-- Pay To section: only meaningful for Quote uploads -->
        <div class="doc-pay-to-section doc-upload-notes" id="docPayToSection" style="display:none">
          <label class="trans-note-label">Pay to (required for Approve Quote later)</label>
          <div class="doc-pay-to-radios">
            <label class="doc-radio"><input type="radio" name="pay_to_type" value="customer" checked/> Customer (default)</label>
            <label class="doc-radio"><input type="radio" name="pay_to_type" value="vendor"/> Vendor directly</label>
          </div>
          <div id="docVendorAddressWrap" style="display:none;margin-top:8px">
            <label class="trans-note-label">Vendor address (required if paying vendor)</label>
            <textarea name="vendor_address" rows="3" maxlength="1000" placeholder="Street, city, state, zip"></textarea>
          </div>
        </div>
      </div>
      <div class="doc-upload-actions">
        <span class="mut">Max 10 MB · PDF, JPG, PNG, HEIC</span>
        <button type="submit" class="btn-primary">Upload Document</button>
      </div>
    </form>
    <script>
      (function(){
        const typeSel = document.getElementById('docUploadType');
        const payToSec = document.getElementById('docPayToSection');
        const vendorAddrWrap = document.getElementById('docVendorAddressWrap');
        if (!typeSel || !payToSec) return;
        function update(){
          payToSec.style.display = typeSel.value === 'Quote' ? '' : 'none';
        }
        typeSel.addEventListener('change', update);
        update();
        // Vendor address visibility within Pay To section
        document.querySelectorAll('input[name="pay_to_type"]').forEach(r => {
          r.addEventListener('change', () => {
            if (vendorAddrWrap) vendorAddrWrap.style.display = (r.value === 'vendor' && r.checked) ? '' : 'none';
          });
        });
      })();
    </script>
  `;

  return `
    <div class="card">
      <h2 class="section-h">Documents</h2>
      <div class="doc-section">
        ${quotesHtml}
        ${receiptsHtml}
        ${checkRequestsHtml}
      </div>
      ${uploadFormHtml}
    </div>
  `;
}

function renderClaimDetail(auth, claim, photos, activity, opts = {}) {
  const escFn = escapeManage;

  // Group photos by photo_type — but exclude Quote/Receipt rows (those render in the Documents card)
  const photoGroups = {};
  photos.forEach(p => {
    const type = p.photo_type || "Other";
    if (type === "Quote" || type === "Receipt") return;
    if (!photoGroups[type]) photoGroups[type] = [];
    photoGroups[type].push(p);
  });
  // Preferred display order
  const photoTypeOrder = ["Vehicle Overview", "VIN", "Damage", "License Plate"];
  const orderedTypes = [
    ...photoTypeOrder.filter(t => photoGroups[t]),
    ...Object.keys(photoGroups).filter(t => !photoTypeOrder.includes(t))
  ];

  // Vehicle string
  const vehicle = [claim.vehicle_year, claim.vehicle_make, claim.vehicle_model, claim.vehicle_color]
    .filter(Boolean).join(" ") || "—";

  // Phone formatting for display + tel: link
  const phoneDigits = claim.customer_phone || "";
  const phonePretty = phoneDigits.length === 10
    ? `(${phoneDigits.slice(0,3)}) ${phoneDigits.slice(3,6)}-${phoneDigits.slice(6)}`
    : phoneDigits || "—";

  // Age indicator
  const ageText = formatAge(claim);

  // Photo HTML — grouped by type
  const photoSectionsHtml = orderedTypes.length === 0
    ? `<div class="empty-section">No photos uploaded.</div>`
    : orderedTypes.map(type => {
        const items = photoGroups[type];
        const tiles = items.map((p, i) => {
          // Strip "claims/" prefix from r2_key — the photo endpoint adds it back
          const photoUrl = `/claims-api/photo/${(p.r2_key || "").replace(/^claims\//, "")}`;
          return `
            <div class="photo-tile" data-src="${escFn(photoUrl)}" data-caption="${escFn(type + " " + (i+1))}">
              <img src="${escFn(photoUrl)}" alt="${escFn(type)}" loading="lazy"/>
            </div>
          `;
        }).join("");
        return `
          <div class="photo-group">
            <h3 class="photo-group-title">${escFn(type)} <span class="photo-count">${items.length}</span></h3>
            <div class="photo-grid">${tiles}</div>
          </div>
        `;
      }).join("");

  // Activity timeline
  const activityHtml = activity.length === 0
    ? `<div class="empty-section">No activity recorded.</div>`
    : activity.map(a => {
        const ts = formatAbsoluteDate(a.created_at);
        const actor = a.actor_name || a.actor_email || "—";
        let body;
        if (a.activity_type === "status_change") {
          const fromTo = a.status_from
            ? `${escFn(a.status_from)} → ${escFn(a.status_to)}`
            : escFn(a.status_to || "");
          body = `<div class="activity-status">${fromTo}</div>`;
        } else {
          const prettyType = a.activity_type
            ? a.activity_type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
            : "";
          body = `<div class="activity-type">${escFn(prettyType)}</div>`;
        }
        const notes = a.notes ? `<div class="activity-notes">${escFn(a.notes)}</div>` : "";
        return `
          <div class="activity-row">
            <div class="activity-time">${escFn(ts)}</div>
            <div class="activity-body">
              ${body}
              ${notes}
              <div class="activity-actor">by ${escFn(actor)}</div>
            </div>
          </div>
        `;
      }).join("");

  // Optional fields, only render if present
  const optionalRow = (label, value) =>
    value ? `<div class="kv"><div class="k">${escFn(label)}</div><div class="v">${escFn(value)}</div></div>` : "";

  // Helper that preserves newlines in long-form fields (staff_notes especially)
  const preRow = (label, value) =>
    value ? `<div class="kv"><div class="k">${escFn(label)}</div><div class="v"><pre class="prose">${escFn(value)}</pre></div></div>` : "";

  const inner = `
    <div class="back-link-row">
      <a href="/manage" class="back-link">&larr; Back to claims</a>
      <span class="claim-id-tag">${escFn(claim.claim_id)}</span>
    </div>

    <div class="claim-header card">
      <div class="header-left">
        <span class="status-badge status-${(claim.lifecycle_state || "").toLowerCase()}">${escFn(claim.claim_status)}</span>
        ${ageText ? `<span class="age-badge">${escFn(ageText)}</span>` : ""}
      </div>
      <div class="header-meta">
        <div><strong>${escFn(claim.location_pretty)}</strong></div>
        <div class="mut">Submitted ${escFn(formatAbsoluteDate(claim.submitted_at))}</div>
        <div class="mut">By ${escFn(claim.submitted_by || "—")}</div>
      </div>
    </div>

    <div class="card">
      <h2 class="section-h">Actions</h2>
      ${opts.error ? `<div class="action-error">${escFn(opts.error)}</div>` : ""}
      ${renderTransitionActions(claim, auth, photos)}
      <form method="POST" action="/manage/claim/${escFn(claim.claim_id)}/note" class="note-form">
        <label for="noteInput" class="note-label">Add a note to the activity timeline</label>
        <textarea id="noteInput" name="note" rows="3" maxlength="5000" placeholder="e.g. Called customer, left voicemail. Will retry tomorrow." required></textarea>
        <div class="note-actions">
          <button type="submit" class="btn-primary">Add Note</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h2 class="section-h">Customer & Vehicle</h2>
      <div class="grid-2col">
        <div class="kv"><div class="k">Name</div><div class="v">${escFn(claim.customer_name || "—")}</div></div>
        <div class="kv"><div class="k">Phone</div><div class="v">${phoneDigits ? `<a href="tel:${escFn(phoneDigits)}">${escFn(phonePretty)}</a>` : "—"}</div></div>
        ${optionalRow("Email", claim.customer_email)}
        ${optionalRow("Mailing Address", claim.customer_mailing_address)}
        <div class="kv"><div class="k">Vehicle</div><div class="v">${escFn(vehicle)}</div></div>
        <div class="kv"><div class="k">License Plate</div><div class="v">${escFn(claim.license_plate || "—")}</div></div>
      </div>
      ${preRow("Customer Description", claim.damage_description)}
      ${preRow("Pre-Existing Damage", claim.preexisting_damage)}
    </div>

    <div class="card">
      <h2 class="section-h">Staff Assessment</h2>
      <div class="grid-2col">
        <div class="kv"><div class="k">Determination</div><div class="v">${escFn(claim.determination ? claim.determination.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : "—")}</div></div>
        ${optionalRow("Membership Number", claim.membership_number)}
        <div class="kv"><div class="k">Equipment Involved</div><div class="v">${escFn(claim.equipment_piece || "—")}</div></div>
        <div class="kv"><div class="k">Equipment Related</div><div class="v">${claim.equipment_related ? "Yes" : "No"}</div></div>
      </div>
      ${preRow("Staff Notes", claim.staff_notes)}
    </div>

    <div class="card">
      <h2 class="section-h">Photos</h2>
      ${photoSectionsHtml}
    </div>

    ${renderDocumentsCard(claim, auth, photos)}

    <div class="card">
      <h2 class="section-h">Activity</h2>
      ${activityHtml}
    </div>

    <!-- Lightbox overlay -->
    <div class="lightbox" id="lightbox">
      <div class="lightbox-controls">
        <button type="button" class="lb-btn" id="lbZoomOut" title="Zoom out">−</button>
        <button type="button" class="lb-btn" id="lbReset" title="Reset zoom">⟲</button>
        <button type="button" class="lb-btn" id="lbZoomIn" title="Zoom in">+</button>
        <button type="button" class="lb-btn lb-close" id="lbClose" title="Close">×</button>
      </div>
      <div class="lightbox-img-wrap" id="lbImgWrap">
        <img id="lbImg" src="" alt=""/>
      </div>
      <div class="lightbox-caption" id="lbCaption"></div>
    </div>

    <style>
      .back-link-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 14px;
      }
      .back-link {
        color: rgba(255,255,255,0.8);
        text-decoration: none;
        font-size: 0.875rem;
        font-weight: 600;
      }
      .back-link:hover { color: var(--white); text-decoration: underline; }
      .claim-id-tag {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8125rem;
        color: rgba(255,255,255,0.6);
        padding: 2px 10px;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 12px;
      }

      .claim-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 16px;
      }
      .header-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .header-meta {
        text-align: right;
        font-size: 0.875rem;
        color: var(--splash-navy);
      }
      .header-meta .mut { color: var(--gray-dark); }

      .status-badge {
        display: inline-block;
        padding: 6px 14px;
        border-radius: 20px;
        font-size: 0.8125rem;
        font-weight: 600;
        background: var(--sudsy-blue-soft);
        color: var(--splash-blue);
      }
      .status-closed { background: #e5e7eb; color: var(--gray-dark); }
      .age-badge {
        display: inline-block;
        padding: 5px 12px;
        border-radius: 20px;
        font-size: 0.75rem;
        font-weight: 600;
        background: #fef3c7;
        color: #92400e;
      }

      .grid-2col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px 24px;
        margin-bottom: 14px;
      }
      @media (max-width: 600px) { .grid-2col { grid-template-columns: 1fr; } }

      .kv { font-size: 0.875rem; }
      .kv .k {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--gray-dark);
        margin-bottom: 3px;
        font-weight: 700;
      }
      .kv .v { color: var(--splash-navy); }
      .kv .v a { color: var(--splash-blue); text-decoration: none; }
      .kv .v a:hover { text-decoration: underline; color: var(--splash-blue-dark); }
      .kv pre.prose {
        font-family: inherit;
        white-space: pre-wrap;
        word-wrap: break-word;
        background: #f8fafc;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        line-height: 1.5;
        margin: 0;
        border: 1px solid #e5e7eb;
        color: var(--splash-navy);
      }

      .photo-group { margin-bottom: 22px; }
      .photo-group:last-child { margin-bottom: 0; }
      .photo-group-title {
        font-size: 0.8125rem;
        font-weight: 700;
        color: var(--splash-navy);
        margin: 0 0 10px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .photo-count {
        display: inline-block;
        background: var(--sudsy-blue-soft);
        color: var(--splash-blue);
        font-size: 0.6875rem;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 10px;
      }
      .photo-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px;
      }
      .photo-tile {
        aspect-ratio: 1;
        cursor: zoom-in;
        border-radius: var(--radius-sm);
        overflow: hidden;
        border: 1px solid #e5e7eb;
        background: #f9fafb;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .photo-tile:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(28, 22, 78, 0.18);
      }
      .photo-tile img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .activity-row {
        display: grid;
        grid-template-columns: 160px 1fr;
        gap: 16px;
        padding: 12px 0;
        border-bottom: 1px solid #f3f4f6;
      }
      .activity-row:last-child { border-bottom: none; }
      .activity-time { font-size: 0.75rem; color: var(--gray-dark); }
      .activity-status {
        font-weight: 700;
        font-size: 0.875rem;
        color: var(--splash-blue);
      }
      .activity-type {
        font-weight: 700;
        font-size: 0.875rem;
        color: var(--splash-navy);
        text-transform: capitalize;
      }
      .activity-notes {
        font-size: 0.8125rem;
        color: var(--splash-navy);
        margin-top: 4px;
      }
      .activity-actor {
        font-size: 0.75rem;
        color: var(--gray-dark);
        margin-top: 4px;
      }
      @media (max-width: 600px) {
        .activity-row { grid-template-columns: 1fr; gap: 4px; }
      }

      .empty-section {
        font-size: 0.8125rem;
        color: var(--gray-dark);
        font-style: italic;
        padding: 8px 0;
      }

      /* Action card */
      .action-error {
        background: #fef2f2;
        border: 1px solid #fecaca;
        color: #991b1b;
        padding: 10px 14px;
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        margin-bottom: 14px;
      }
      .note-form {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .note-label {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--gray-dark);
        font-weight: 700;
      }
      .note-form textarea {
        padding: 10px 12px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.875rem;
        font-family: inherit;
        resize: vertical;
        min-height: 70px;
        color: var(--splash-navy);
        background: var(--white);
      }
      .note-form textarea:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.20);
      }
      .note-actions { display: flex; justify-content: flex-end; }

      /* Transition actions */
      .trans-section {
        margin-bottom: 18px;
        padding-bottom: 18px;
        border-bottom: 1px solid #f3f4f6;
      }
      .trans-section:empty {
        margin-bottom: 0;
        padding-bottom: 0;
        border: none;
      }
      .no-actions { padding: 8px 0; font-size: 0.8125rem; color: var(--gray-dark); }
      .trans-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      @media (min-width: 700px) {
        .trans-grid { grid-template-columns: 1fr 1fr; }
      }
      .trans-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: #f8fafc;
        padding: 14px;
        border-radius: var(--radius-sm);
        border: 1px solid #e5e7eb;
      }
      .trans-form.trans-reopen {
        background: #fef3c7;
        border-color: #fbbf24;
      }
      .trans-note-label {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--gray-dark);
        font-weight: 700;
      }
      .trans-form textarea {
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        font-family: inherit;
        resize: vertical;
        min-height: 50px;
        background: var(--white);
        color: var(--splash-navy);
      }
      .trans-form textarea:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.20);
      }
      .btn-trans {
        padding: 9px 16px;
        background: var(--splash-blue);
        color: var(--white);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 700;
        align-self: flex-start;
        font-family: inherit;
        transition: background 0.2s ease;
      }
      .btn-trans:hover { background: var(--splash-blue-dark); }
      .trans-form.trans-reopen .btn-trans { background: #92400e; }
      .trans-form.trans-reopen .btn-trans:hover { background: #78350f; }

      .trans-deferred-grid {
        margin-top: 10px;
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }
      @media (min-width: 700px) {
        .trans-deferred-grid { grid-template-columns: 1fr 1fr; }
      }
      .trans-deferred {
        padding: 12px 14px;
        background: #f3f4f6;
        border-radius: var(--radius-sm);
        border: 1px dashed var(--gray-light);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .trans-deferred-label {
        font-size: 0.8125rem;
        color: var(--gray-dark);
        font-weight: 700;
      }
      .trans-deferred-note {
        font-size: 0.6875rem;
        color: #9ca3af;
        font-style: italic;
      }

      .trans-dropdown-form {
        margin-top: 14px;
        padding: 14px;
        background: #fef3c7;
        border: 1px solid #fbbf24;
        border-radius: var(--radius-sm);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .trans-dropdown-form select {
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        background: var(--white);
        color: var(--splash-navy);
        font-family: inherit;
      }
      .trans-dropdown-form textarea {
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        font-family: inherit;
        resize: vertical;
        min-height: 50px;
        background: var(--white);
        color: var(--splash-navy);
      }
      .btn-trans-secondary {
        padding: 9px 16px;
        background: #92400e;
        color: var(--white);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 0.8125rem;
        font-weight: 700;
        align-self: flex-start;
        font-family: inherit;
      }
      .btn-trans-secondary:hover { background: #78350f; }
      .admin-tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 8px;
        background: var(--splash-blue);
        color: var(--white);
        font-size: 0.5625rem;
        font-weight: 700;
        margin-left: 4px;
        vertical-align: 1px;
      }

      /* Step 6c: extra inputs in transition forms (Approve - In House: parts + vendor) */
      .trans-form input[type="text"],
      .trans-form select {
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        font-family: inherit;
        background: var(--white);
        color: var(--splash-navy);
      }
      .trans-form input[type="text"]:focus,
      .trans-form select:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.20);
      }

      /* Gated next-step transition (action needs a prerequisite — visually loud, not faded) */
      .trans-gated {
        border-left: 4px solid var(--racecar-red);
        background: #fff7f5;
      }
      .btn-trans-gated {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-trans-gated:hover {
        background: var(--splash-blue);
      }
      .trans-gated-msg {
        font-size: 0.8125rem;
        color: var(--racecar-red);
        margin-top: 4px;
      }
      .trans-gated-msg strong { font-weight: 700; }
        padding: 14px;
        background: #f3f4f6;
        border-radius: var(--radius-sm);
        border: 1px dashed var(--gray-light);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .trans-blocked-label {
        font-size: 0.8125rem;
        color: var(--gray-dark);
        font-weight: 700;
      }
      .trans-blocked-note {
        font-size: 0.6875rem;
        color: #9ca3af;
        font-style: italic;
      }

      /* Documents card */
      .doc-section {
        margin-bottom: 18px;
      }
      .doc-group-title {
        font-size: 0.8125rem;
        font-weight: 700;
        color: var(--splash-navy);
        margin: 12px 0 8px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .doc-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 8px;
      }
      .doc-row {
        display: grid;
        grid-template-columns: 90px 1fr;
        gap: 14px;
        padding: 12px;
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        border-radius: var(--radius-sm);
        align-items: start;
      }
      .doc-row-approved {
        background: #d1fae5;
        border-color: #6ee7b7;
      }
      .doc-tile {
        width: 90px;
        height: 90px;
        border-radius: var(--radius-sm);
        overflow: hidden;
        background: var(--white);
        border: 1px solid #e5e7eb;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: zoom-in;
        text-decoration: none;
      }
      .doc-tile-img img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .doc-tile-pdf {
        font-size: 0.875rem;
        font-weight: 700;
        color: var(--racecar-red);
        background: var(--white);
      }
      .doc-tile-pdf:hover {
        background: #fef2f2;
      }
      .doc-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 0.8125rem;
        color: var(--splash-navy);
      }
      .doc-vendor { font-weight: 700; }
      .doc-amount {
        color: var(--splash-blue);
        font-weight: 700;
        font-size: 0.9375rem;
      }
      .doc-filename {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.6875rem;
      }
      .doc-notes {
        font-style: italic;
        color: var(--gray-dark);
        font-size: 0.75rem;
        margin-top: 2px;
      }
      .doc-uploader {
        font-size: 0.6875rem;
        margin-top: 2px;
      }
      .doc-actions {
        display: flex;
        gap: 8px;
        margin-top: 6px;
      }
      .doc-action-btn {
        padding: 4px 10px;
        background: var(--white);
        color: var(--splash-blue);
        border: 1px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      .doc-action-btn:hover {
        border-color: var(--splash-blue);
      }
      .doc-action-delete {
        color: var(--racecar-red);
      }
      .doc-action-delete:hover {
        border-color: var(--racecar-red);
      }
      a.doc-action-btn {
        display: inline-block;
        text-decoration: none;
        line-height: normal;
      }
      .doc-action-preview {
        color: var(--splash-navy);
        background: var(--cream);
        border-color: var(--yellow);
      }
      .doc-action-preview:hover {
        border-color: var(--splash-blue);
        background: var(--white);
      }
      .doc-approved-tag {
        display: inline-block;
        margin-top: 6px;
        padding: 2px 10px;
        background: #065f46;
        color: var(--white);
        font-size: 0.6875rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        border-radius: 10px;
        align-self: flex-start;
      }
      .doc-edit-form {
        grid-column: 1 / -1;
        margin-top: 10px;
        padding: 12px;
        background: var(--white);
        border-radius: var(--radius-sm);
        border: 1px solid var(--gray-light);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .doc-edit-form input,
      .doc-edit-form textarea {
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        font-family: inherit;
        background: var(--white);
        color: var(--splash-navy);
      }
      .doc-edit-form input:focus,
      .doc-edit-form textarea:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.20);
      }
      .doc-edit-actions {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }

      /* Upload form */
      .doc-upload-form {
        margin-top: 14px;
        padding: 16px;
        background: #f8fafc;
        border: 1px dashed var(--splash-blue);
        border-radius: var(--radius-md);
      }
      .doc-upload-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 700px) {
        .doc-upload-grid { grid-template-columns: 1fr; }
      }
      .doc-upload-notes {
        grid-column: 1 / -1;
      }
      .doc-upload-form select,
      .doc-upload-form input[type="text"],
      .doc-upload-form input[type="number"],
      .doc-upload-form textarea {
        width: 100%;
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.8125rem;
        font-family: inherit;
        background: var(--white);
        color: var(--splash-navy);
      }
      .doc-upload-form input[type="file"] {
        width: 100%;
        padding: 6px 0;
        font-size: 0.8125rem;
        color: var(--splash-navy);
      }
      .doc-upload-form select:focus,
      .doc-upload-form input:focus,
      .doc-upload-form textarea:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.20);
      }
      .doc-upload-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 14px;
        flex-wrap: wrap;
        gap: 10px;
      }

      /* Pay-to radios + summary on quote rows */
      .doc-pay-to-radios {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        margin: 4px 0;
      }
      .doc-radio {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.8125rem;
        color: var(--splash-navy);
        cursor: pointer;
      }
      .doc-radio input[type="radio"] {
        margin: 0;
        cursor: pointer;
      }
      .doc-pay-to {
        font-size: 0.75rem;
        margin-top: 2px;
      }
      .doc-edit-vendor-addr-wrap {
        margin-top: 4px;
      }
      .doc-pay-to-section .doc-pay-to-radios {
        background: var(--white);
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
      }

      /* Lightbox */
      .lightbox {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.92);
        z-index: 9999;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      .lightbox.active { display: flex; }
      .lightbox-controls {
        position: absolute;
        top: 16px;
        right: 16px;
        display: flex;
        gap: 8px;
        z-index: 10000;
      }
      .lb-btn {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        border: none;
        background: rgba(255,255,255,0.15);
        color: #fff;
        font-size: 20px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease;
      }
      .lb-btn:hover { background: rgba(255,255,255,0.3); }
      .lb-close { background: rgba(220,62,38,0.6); }
      .lb-close:hover { background: rgba(220,62,38,0.9); }
      .lightbox-img-wrap {
        flex: 1;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        cursor: grab;
        touch-action: none;
      }
      .lightbox-img-wrap.grabbing { cursor: grabbing; }
      .lightbox-img-wrap img {
        max-width: 90vw;
        max-height: 80vh;
        display: block;
        user-select: none;
        -webkit-user-drag: none;
        transition: transform 0.1s ease;
        transform-origin: center center;
      }
      .lightbox-caption {
        color: rgba(255,255,255,0.85);
        padding: 16px;
        font-size: 0.875rem;
      }
    </style>

    <script>
    (function(){
      const overlay = document.getElementById('lightbox');
      const img = document.getElementById('lbImg');
      const wrap = document.getElementById('lbImgWrap');
      const caption = document.getElementById('lbCaption');
      let scale = 1;
      let panX = 0, panY = 0;
      let isDragging = false;
      let dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;

      function applyTransform(){
        img.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
      }
      function reset(){
        scale = 1; panX = 0; panY = 0; applyTransform();
      }
      function open(src, cap){
        img.src = src; caption.textContent = cap; reset();
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
      }
      function close(){
        overlay.classList.remove('active');
        img.src = '';
        document.body.style.overflow = '';
      }

      document.querySelectorAll('.photo-tile, .doc-tile-img').forEach(t=>{
        t.addEventListener('click', ()=> open(t.dataset.src, t.dataset.caption));
      });

      // Edit / cancel toggles for the Documents card
      document.querySelectorAll('[data-edit-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const form = document.getElementById('doc-edit-' + btn.dataset.editId);
          if (form) form.style.display = '';
        });
      });
      document.querySelectorAll('[data-cancel-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const form = document.getElementById('doc-edit-' + btn.dataset.cancelId);
          if (form) form.style.display = 'none';
        });
      });

      document.getElementById('lbClose').addEventListener('click', close);
      document.getElementById('lbZoomIn').addEventListener('click', ()=>{ scale = Math.min(scale * 1.4, 8); applyTransform(); });
      document.getElementById('lbZoomOut').addEventListener('click', ()=>{
        scale = Math.max(scale / 1.4, 0.5);
        if (scale <= 1) { panX = 0; panY = 0; }
        applyTransform();
      });
      document.getElementById('lbReset').addEventListener('click', reset);

      // Wheel to zoom
      wrap.addEventListener('wheel', (e)=>{
        if (!overlay.classList.contains('active')) return;
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.15 : 1/1.15;
        const newScale = Math.max(0.5, Math.min(scale * delta, 8));
        scale = newScale;
        if (scale <= 1) { panX = 0; panY = 0; }
        applyTransform();
      }, { passive: false });

      // Pan when zoomed
      wrap.addEventListener('pointerdown', (e)=>{
        if (scale <= 1) return;
        isDragging = true;
        wrap.classList.add('grabbing');
        dragStartX = e.clientX; dragStartY = e.clientY;
        panStartX = panX; panStartY = panY;
        wrap.setPointerCapture(e.pointerId);
      });
      wrap.addEventListener('pointermove', (e)=>{
        if (!isDragging) return;
        panX = panStartX + (e.clientX - dragStartX);
        panY = panStartY + (e.clientY - dragStartY);
        applyTransform();
      });
      wrap.addEventListener('pointerup', (e)=>{
        isDragging = false;
        wrap.classList.remove('grabbing');
      });

      // Click outside img closes; click on img doesn't
      overlay.addEventListener('click', (e)=>{
        if (e.target === overlay || e.target === wrap) close();
      });

      // Keyboard: Esc closes, +/- zoom, 0 resets
      document.addEventListener('keydown', (e)=>{
        if (!overlay.classList.contains('active')) return;
        if (e.key === 'Escape') close();
        else if (e.key === '+' || e.key === '=') { scale = Math.min(scale * 1.4, 8); applyTransform(); }
        else if (e.key === '-') { scale = Math.max(scale / 1.4, 0.5); if (scale <= 1) { panX = 0; panY = 0; } applyTransform(); }
        else if (e.key === '0') reset();
      });
    })();
    </script>
  `;
  // Page chrome: pageName = customer name; meta line = location · submission date
  const submittedShort = claim.submitted_at
    ? new Date(claim.submitted_at).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", year: "numeric"
      })
    : "—";
  const metaLine = `${claim.location_pretty || "—"} · Submitted ${submittedShort}`;

  return renderManagePageWrap(inner, {
    title: `${claim.customer_name || claim.claim_id} — Damage Claim`,
    eyebrow: "DAMAGE CLAIMS",
    pageName: claim.customer_name || claim.claim_id,
    pageNameMeta: metaLine,
    auth,
  });
}

// 403 page for users authenticated but lacking the 'claims' tool grant in user_tool_access.
// Distinct from renderClaimForbidden (per-claim location authorization).
// Lands on a stand-alone branded page (not the /manage chrome) so it's clearly
// a "wrong door" experience rather than a sub-page within the tool.
function renderClaimsForbidden(email) {
  const safeEmail = String(email || "this account")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#1c164e"/>
<title>Access Denied — Damage Claims</title>
<link rel="icon" type="image/png" href="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/favicon-32x32.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Asap:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --splash-blue: #2b3491;
    --splash-blue-dark: #20276e;
    --sudsy-blue: #3dbeee;
    --splash-navy: #1c164e;
    --white: #ffffff;
    --muted: #6b7280;
    --radius-sm: 6px;
    --radius-lg: 16px;
    --shadow-card: 0 10px 30px rgba(28, 22, 78, 0.18);
    --shadow-btn: 0 4px 12px rgba(43, 52, 145, 0.25);
    --font-body: 'Asap', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: var(--font-body);
    color: var(--splash-navy);
    background: linear-gradient(160deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    background-attachment: fixed;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
  }
  .card {
    width: 100%; max-width: 460px;
    background: var(--white);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }
  .card-header {
    background: linear-gradient(135deg, var(--splash-blue) 0%, var(--splash-navy) 100%);
    color: #fff;
    padding: 28px 32px 22px;
    text-align: center;
  }
  .card-header img { display: block; height: 56px; width: auto; margin: 0 auto 12px; }
  .card-header .eyebrow {
    font-size: 11px; font-weight: 700;
    letter-spacing: 0.18em; text-transform: uppercase;
    color: var(--sudsy-blue); margin-bottom: 4px;
  }
  .card-header h1 { margin: 0; font-size: 1.25rem; font-weight: 700; color: #fff; }
  .card-body { padding: 24px 32px 28px; text-align: center; }
  .card-body p { margin: 0 0 8px; font-size: 14px; color: var(--splash-navy); }
  .card-body .email { font-weight: 700; word-break: break-all; }
  .card-body .muted { color: var(--muted); font-size: 13px; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
  .btn {
    padding: 10px 20px; height: 42px;
    font: 700 14px var(--font-body);
    border-radius: var(--radius-sm); cursor: pointer;
    text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center;
    border: none;
  }
  .btn-primary {
    background: var(--splash-blue); color: #fff;
    box-shadow: var(--shadow-btn);
  }
  .btn-primary:hover { background: var(--splash-blue-dark); }
</style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <img src="https://pub-88f136a47a5846d5b7e47fbce605719b.r2.dev/SplashScriptWhite_RedCar.png" alt="Splash Car Washes"/>
      <div class="eyebrow">Damage Claims</div>
      <h1>Access Denied</h1>
    </div>
    <div class="card-body">
      <p>Sorry, <span class="email">${safeEmail}</span> doesn't have access to Damage Claims.</p>
      <p class="muted">Contact your administrator if you need access.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/">Return to Dashboard</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// 403 page for users trying to access a claim they don't have permission for
function renderClaimForbidden(claimId, auth = null) {
  const inner = `
    <div class="card">
      <div class="error-page">
        <div class="error-page-claim">Claim: ${escapeManage(claimId)}</div>
        <div class="mut">You don't have permission to view this claim. It belongs to a location you're not assigned to.</div>
        <div class="error-page-back"><a href="/manage" class="link">&larr; Back to claims</a></div>
      </div>
    </div>
    <style>
      .error-page-claim { font-weight: 700; margin-bottom: 8px; color: var(--splash-navy); }
      .error-page-back { margin-top: 14px; }
    </style>
  `;
  return renderManagePageWrap(inner, {
    title: "Access Denied",
    eyebrow: "DAMAGE CLAIMS",
    pageName: "Access Denied",
    auth,
  });
}

// 404 page
function renderClaimNotFound(claimId, auth = null) {
  const inner = `
    <div class="card">
      <div class="error-page">
        <div class="error-page-claim">Claim: ${escapeManage(claimId)}</div>
        <div class="mut">No claim with that ID exists, or it has been deleted.</div>
        <div class="error-page-back"><a href="/manage" class="link">&larr; Back to claims</a></div>
      </div>
    </div>
    <style>
      .error-page-claim { font-weight: 700; margin-bottom: 8px; color: var(--splash-navy); }
      .error-page-back { margin-top: 14px; }
    </style>
  `;
  return renderManagePageWrap(inner, {
    title: "Not Found",
    eyebrow: "DAMAGE CLAIMS",
    pageName: "Not Found",
    auth,
  });
}

// ==================== PAGE RENDERER: CLAIM LIST ====================
function renderClaimList(auth, claims, locations, filters) {
  const escFn = escapeManage;

  // Location filter dropdown
  const locOptions = ['<option value="All">All Locations</option>']
    .concat(locations.map(l => {
      const sel = filters.location === l.location_code ? "selected" : "";
      return `<option value="${escFn(l.location_code)}" ${sel}>${escFn(l.location_pretty)}</option>`;
    }))
    .join("");

  // Status filter dropdown
  const statusOptions = ['<option value="All">All Statuses</option>']
    .concat(CLAIM_STATUSES.map(s => {
      const sel = filters.status === s ? "selected" : "";
      return `<option value="${escFn(s)}" ${sel}>${escFn(s)}</option>`;
    }))
    .join("");

  // Lifecycle filter
  const lifecycleOptions = ["All", "Open", "Closed"].map(l => {
    const sel = filters.lifecycle === l ? "selected" : "";
    return `<option value="${l}" ${sel}>${l}</option>`;
  }).join("");

  // Claim rows
  const rows = claims.length === 0
    ? `<tr><td colspan="7" class="empty">No claims match the current filters.</td></tr>`
    : claims.map(c => {
        const flags = getAttentionFlags(c);
        const flagsHtml = flags.map(f =>
          `<span class="flag flag-${f.tone}" title="${escFn(f.title)}">${escFn(f.label)}</span>`
        ).join("");

        const vehicle = [c.vehicle_year, c.vehicle_make, c.vehicle_model]
          .filter(Boolean).join(" ") || "—";

        const submittedDate = c.submitted_at
          ? new Date(c.submitted_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
          : "—";

        const statusClass = `status-${(c.lifecycle_state || "").toLowerCase()}`;

        return `
          <tr>
            <td><a href="/manage/claim/${escFn(c.claim_id)}" class="claim-link">${escFn(c.claim_id)}</a></td>
            <td>
              <div class="customer-name">${escFn(c.customer_name)}</div>
              ${flagsHtml ? `<div class="flags">${flagsHtml}</div>` : ""}
            </td>
            <td>${escFn(c.location_pretty)}</td>
            <td>${escFn(vehicle)}</td>
            <td>${escFn(submittedDate)}</td>
            <td>${renderAgeBadge(c)}</td>
            <td><span class="status-badge ${statusClass}">${escFn(c.claim_status)}</span></td>
          </tr>
        `;
      }).join("");

  const inner = `
    <form method="GET" action="/manage" class="filter-bar">
      <input type="text" name="search" value="${escFn(filters.search || "")}" placeholder="Search customer name..." class="filter-search"/>
      <select name="location" onchange="this.form.submit()">${locOptions}</select>
      <select name="status" onchange="this.form.submit()">${statusOptions}</select>
      <select name="lifecycle" onchange="this.form.submit()">${lifecycleOptions}</select>
      <button type="submit" class="btn-filter">Apply</button>
      <a href="/manage?lifecycle=Open" class="link clear-link">Clear</a>
    </form>

    <div class="card claims-card">
      <div class="result-meta">
        Showing ${claims.length} claim${claims.length === 1 ? "" : "s"}${claims.length === 100 ? " (max 100, refine filters to see more)" : ""}
      </div>
      <div class="table-scroll">
        <table class="claims-table">
          <thead>
            <tr>
              <th>Claim ID</th>
              <th>Customer</th>
              <th>Location</th>
              <th>Vehicle</th>
              <th>Submitted</th>
              <th>Age</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>

    <style>
      .filter-bar {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 18px;
        flex-wrap: wrap;
        background: var(--white);
        padding: 14px 16px;
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-card);
      }
      .filter-bar input,
      .filter-bar select {
        padding: 8px 10px;
        border: 1.5px solid var(--gray-light);
        border-radius: var(--radius-sm);
        font-size: 0.875rem;
        background: var(--white);
        color: var(--splash-navy);
        font-family: inherit;
      }
      .filter-bar input:focus,
      .filter-bar select:focus {
        outline: none;
        border-color: var(--splash-blue);
        box-shadow: 0 0 0 3px rgba(61,190,238,0.20);
      }
      .filter-search { flex: 1; min-width: 220px; }
      .btn-filter {
        padding: 8px 16px;
        background: var(--splash-blue);
        color: var(--white);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 700;
        font-family: inherit;
      }
      .btn-filter:hover { background: var(--splash-blue-dark); }
      .clear-link { font-size: 0.8125rem; }

      .result-meta {
        font-size: 0.8125rem;
        color: var(--gray-dark);
        margin-bottom: 12px;
      }
      /* The card pads its content (padding: 22px 24px) - we negate that horizontally
         on the scroll container so the table can scroll edge-to-edge inside the card
         without breaking out of the card's rounded shape. */
      .claims-card { overflow: hidden; }
      .table-scroll {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        margin: 0 -24px -22px;
        padding: 0 24px 22px;
      }
      .claims-table {
        width: 100%;
        min-width: 720px;
        border-collapse: collapse;
        font-size: 0.875rem;
        color: var(--splash-navy);
      }
      .claims-table th {
        text-align: left;
        padding: 10px 12px;
        background: #f8f9fb;
        border-bottom: 2px solid #e5e7eb;
        font-weight: 700;
        color: var(--splash-blue);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .claims-table td {
        padding: 12px;
        border-bottom: 1px solid #f3f4f6;
        vertical-align: top;
      }
      .claims-table tr:hover { background: #f9fbfd; }
      .claim-link {
        color: var(--splash-blue);
        text-decoration: none;
        font-weight: 700;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8125rem;
      }
      .claim-link:hover { text-decoration: underline; color: var(--splash-blue-dark); }
      .customer-name { font-weight: 600; }

      .flags { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
      .flag {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 0.6875rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .flag-warn { background: #fef3c7; color: #92400e; }
      .flag-info { background: var(--sudsy-blue-soft); color: var(--splash-blue); }

      .status-badge {
        display: inline-block;
        padding: 4px 11px;
        border-radius: 20px;
        font-size: 0.75rem;
        font-weight: 600;
        background: var(--sudsy-blue-soft);
        color: var(--splash-blue);
        white-space: nowrap;
      }
      .status-closed { background: #e5e7eb; color: var(--gray-dark); }

      .empty { text-align: center; padding: 32px; color: var(--gray-dark); font-style: italic; }

      .age-pill {
        display: inline-block;
        padding: 3px 9px;
        border-radius: 10px;
        font-size: 0.75rem;
        font-weight: 700;
        white-space: nowrap;
      }
      .age-green { background: #d1fae5; color: #065f46; }
      .age-yellow { background: #fef3c7; color: #92400e; }
      .age-red { background: #fee2e2; color: #991b1b; }
      .age-closed { background: #e5e7eb; color: var(--gray-dark); }
    </style>
  `;
  return renderManagePageWrap(inner, {
    title: "Damage Claims",
    eyebrow: "DAMAGE CLAIMS",
    pageName: "Claims",
    auth,
  });
}

function escapeManage(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]
  ));
}

async function serveR2Photo(photoPath, env) {
  try {
    const key = "claims/" + photoPath;
    const object = await env.R2_BUCKET.get(key);
    
    if (!object) {
      return new Response("Photo not found", { status: 404 });
    }
    
    const headers = new Headers();
    headers.set("Content-Type", object.httpMetadata?.contentType || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=86400");
    
    return new Response(object.body, { headers });
  } catch (error) {
    return new Response("Error fetching photo: " + error.message, { status: 500 });
  }
}

