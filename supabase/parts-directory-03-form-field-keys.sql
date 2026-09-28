-- Parts Directory — map a part to the checklist questions it answers.
--
-- Status: APPLIED to the live project (rewokyofschtvqgxrxwl) on 2026-09-28 via
-- psql. Verified after apply: 17 rows under 'Safety Supplies', all 17 carrying
-- a form_field_keys entry, 0 keys that do not match a field on the form.
--
-- IDEMPOTENT (unlike safety-center-form-01.sql): the column add is
-- IF NOT EXISTS and every seeded row is guarded by a NOT EXISTS on the mapping
-- itself, so a second run inserts nothing.
--
-- WHY THE MAPPING LIVES HERE AND NOT ON THE FORM SCHEMA
--
--   The alternative was a new optional flag on the form field, alongside
--   action_item_eligible / exclude_from_pdf. That is more precise but every
--   change to it means editing the draft and republishing the form, and it
--   lives in a generator script rather than a UI. Here, the operator curates
--   the mapping in /admin/parts/directory, several parts can answer one
--   question (glove sizes, kit refills), and nothing needs republishing.
--
-- WHY `form_field_keys` AND NOT `safety_item_keys`
--
--   The array holds form field KEYS, and a key is not safety-specific. The AM
--   site assessment and the RM visit checklist raise action items from the same
--   `action_item_eligible` mechanism and can reuse this column with no second
--   migration. Safety Center is simply the first consumer.
--
--   Keys are NOT namespaced by form. They are already distinctive
--   (`ppe_safety_glasses`, `aid_first_aid_kit`), and a part that answers the
--   same question on two checklists SHOULD match both. If a future form reuses
--   a key for an unrelated question, add the form id to the array entry then —
--   do not pre-empt it.

ALTER TABLE parts_directory
  ADD COLUMN IF NOT EXISTS form_field_keys text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN parts_directory.form_field_keys IS
  'Form field keys this part answers. When a checklist question with one of these keys is answered No, the completion email and the action item link here. Empty = not tied to any checklist question.';

-- Overlap lookup (`&&`) is the only access pattern: given the keys a
-- submission flagged, find the parts. GIN is the index for that operator.
CREATE INDEX IF NOT EXISTS idx_parts_directory_form_field_keys
  ON parts_directory USING gin (form_field_keys);

-- ---------------------------------------------------------------------------
-- Seed: the orderable items on the Safety Center Compliance Checklist.
--
-- NAMES ONLY, ON PURPOSE. part_number, vendor, unit_cost and vendor_url are
-- left NULL for the operator to fill in at /admin/parts/directory. Inventing a
-- vendor or a part number would put a wrong number in front of somebody
-- ordering against it.
--
-- 17 of the checklist's 21 items. The four Required Safety Programs items
-- (HazCom, Spill Response, SDS Program, Current SDS Binder) are programs and
-- documentation rather than purchases, so they map to nothing and their action
-- items simply carry no Order link.
-- ---------------------------------------------------------------------------

-- parent_equipment is text[], NOT text — 02-multi-equipment turned it into an
-- array so one part can sit on several machines. These each sit on exactly one
-- notional "machine", so they are one-element arrays.
INSERT INTO parts_directory (parent_equipment, part_name, form_field_keys, created_by)
SELECT ARRAY[v.equipment], v.name, ARRAY[v.key], 'safety-center seed'
FROM (VALUES
  -- Personal Protective Equipment
  ('Safety Supplies', 'Safety Glasses',                            'ppe_safety_glasses'),
  ('Safety Supplies', 'Disposable Gloves',                         'ppe_disposable_gloves'),
  ('Safety Supplies', 'Waterproof Long Gloves (Ninja Operations)', 'ppe_waterproof_gloves'),
  ('Safety Supplies', 'Burn Sleeves (Oil Lube Operations)',        'ppe_burn_sleeves'),
  ('Safety Supplies', 'Face Masks',                                'ppe_face_masks'),
  ('Safety Supplies', 'Hearing Protection / Ear Plugs',            'ppe_hearing_protection'),
  ('Safety Supplies', 'Slip-Resistant Boots',                      'ppe_slip_resistant_boots'),
  ('Safety Supplies', 'Smocks / Aprons',                           'ppe_smocks_aprons'),
  ('Safety Supplies', 'Back Braces',                               'ppe_back_braces'),
  -- Emergency and First Aid Supplies
  ('Safety Supplies', 'First Aid Kit Refill',                      'aid_first_aid_kit'),
  ('Safety Supplies', 'Bloodborne Pathogen Cleanup Kit',           'aid_bbp_kit'),
  ('Safety Supplies', 'Band-Aids',                                 'aid_band_aids'),
  ('Safety Supplies', 'Alcohol Prep Pads',                         'aid_alcohol_pads'),
  ('Safety Supplies', 'Antibiotic Ointment (Neosporin)',           'aid_antibiotic_ointment'),
  -- Safety Equipment
  ('Safety Supplies', 'Wheel Chocks',                              'equip_wheel_chocks'),
  ('Safety Supplies', 'Lockout/Tagout (LOTO) Locks and Tags',      'equip_loto'),
  ('Safety Supplies', 'Spill Kit Refill',                          'equip_spill_kit')
) AS v(equipment, name, key)
WHERE NOT EXISTS (
  SELECT 1 FROM parts_directory p WHERE p.form_field_keys && ARRAY[v.key]
);

-- Verify: expect 17. Containment, not equality — parent_equipment is text[].
-- SELECT count(*) FROM parts_directory WHERE parent_equipment @> ARRAY['Safety Supplies'];
