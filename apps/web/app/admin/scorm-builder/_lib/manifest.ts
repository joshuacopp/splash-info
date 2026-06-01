// Brief 148 — SCORM 1.2 imsmanifest.xml builder.
//
// Ported verbatim from scorm-builder.html's buildManifest() in repo root.
// Pure: returns a string; takes no IO.

import type { BuilderState } from "./types";

function escapeXml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[m] as string
  );
}

export function buildManifest(state: BuilderState, videoFilename: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeXml(state.courseId)}" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                      http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd
                      http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>${escapeXml(state.title)}</title>
      <item identifier="ITEM-1" identifierref="RES-1">
        <title>${escapeXml(state.title)}</title>
        <adlcp:masteryscore>${state.passScore}</adlcp:masteryscore>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="index.html">
      <file href="index.html"/>
      <file href="scorm.js"/>
      <file href="style.css"/>
      <file href="${escapeXml(videoFilename)}"/>
    </resource>
  </resources>
</manifest>`;
}
