-- APPLIED 2026-11-13 via psql (SUPABASE_DB_URL, --single-transaction).
-- Supply Orders: company-wide "Commonly ordered at Splash" list (2026-11-13).
--
-- Seeded from the operator's list of Kleen-Rite item numbers ordered over the
-- past years (pasted as "SKU - description - qty" lines, no site attached).
-- Each item # was looked up in Kleen-Rite's catalog for its canonical name,
-- unit, picture and product page; two typos in the source were corrected
-- (VAA10SBK -> VAA-10SBK, VAB15B -> VAB-15B). times_ordered = how many lines
-- named the item; typical_qty = the median quantity on those lines.
--
-- Shown on the order page's "Ordered before" tab under the site's own history
-- (supply-orders.ts recentItems). Not location-scoped: the source list had no
-- sites. Re-running is safe: upsert on (vendor, sku).
--
-- RLS on with no policies: service role only.

create table if not exists public.supply_order_common_items (
  vendor         text not null references public.supply_order_vendors(vendor),
  sku            text not null,
  name           text not null,
  uom            text,
  product_path   text,
  image_url      text,
  times_ordered  integer not null default 1,
  typical_qty    integer not null default 1 check (typical_qty between 1 and 9999),
  active         boolean not null default true,
  updated_at     timestamptz not null default now(),
  primary key (vendor, sku)
);

alter table public.supply_order_common_items enable row level security;

insert into public.supply_order_common_items
  (vendor, sku, name, uom, product_path, image_url, times_ordered, typical_qty)
values
  ('kleen_rite', 'HF0151', 'Parker 21342-6-6 Reusable Single Wire Braid Hose Swivel Fitting - 3/8 Hose Swivel x 3/8 NPT', 'Each', 'p-2756-parker-21342-6-6-reusable-single-wire-braid-hose-swivel-fitting-3-8-hose-swivel-x-3-8-npt.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2756.jpg', 7, 4),
  ('kleen_rite', 'HO0088BL', 'Continental 20023638 Neptune Blue High Pressure Hose - 3/8in.', 'Each', 'p-2736-continental-20023638-neptune-blue-high-pressure-hose-3-8in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2736.jpg', 5, 100),
  ('kleen_rite', 'VMK135', 'Kleen-Rite Vac Motor QM6600-135T - Quiet Motor, Peripheral', 'Each', 'p-31445-kleen-rite-vac-motor-qm6600-135t-quiet-motor-peripheral.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/31445.jpg', 3, 6),
  ('kleen_rite', 'GUSS50', 'Spraying System 22650-PP-1/4 Trigger Jet Plastic Spray Gun', 'Each', 'p-1249-spraying-system-22650-pp-1-4-trigger-jet-plastic-spray-gun.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/1249.jpg', 2, 2),
  ('kleen_rite', 'SNCJ55X22-PP', 'Spraying Systems 5500-PPB-X22-VI Polypropylene ConeJet Adjustable Nozzle - 22 Orifice, White, Viton', 'Each', 'p-18228-spraying-systems-5500-ppb-x22-vi-polypropylene-conejet-adjustable-nozzle-22-orifice-white-viton.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/18228.jpg', 2, 5),
  ('kleen_rite', 'SWV38SS', 'Kleen-Rite Stainless Steel Value Swivel - 3/8in. M x F', 'Each', 'p-31827-kleen-rite-stainless-steel-value-swivel-3-8in-m-x-f.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/31827.jpg', 2, 2),
  ('kleen_rite', 'VAA-10SBK', 'Vac Swivel Cuff Black 1 1/2 in.', 'Each', 'p-28734-vac-swivel-cuff-black-1-1-2-in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/28734.jpg', 2, 20),
  ('kleen_rite', 'VMKBRUSH', 'Kleen-Rite Vac Motor Brush Replacement Kit', 'Each', 'p-4472-kleen-rite-vac-motor-brush-replacement-kit.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/4472.jpg', 2, 2),
  ('kleen_rite', '10009649', 'Double Y 45 degree Adapter, 2in FPT x 2in MPT', 'Each', 'p-71937-double-y-45-degree-adapter-2in-fpt-x-2in-mpt.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/71937.jpg', 1, 2),
  ('kleen_rite', 'BTN1600', 'Hydra-Flex 1001600 Blast-Tec Pro 324 No. 2 Rotating Nozzle - 0.25 In. NPT', 'Each', 'p-56471-hydra-flex-1001600-blast-tec-pro-324-no-2-rotating-nozzle-0-25-in-npt.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/56471.jpg', 1, 6),
  ('kleen_rite', 'CT2504BWF', 'Coilhose Pneumatics PU14-25B-B22 Blue Flexcoil Polyurethane Foamy Hose With Reusable Strain Relief Fittings - 25ft. x 1/4in.', 'Each', 'p-2348-coilhose-pneumatics-pu14-25b-b22-blue-flexcoil-polyurethane-foamy-hose-with-reusable-strain-relief-fittings-25ft-x-1-4in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2348.jpg', 1, 2),
  ('kleen_rite', 'CT2506BWF', 'Coilhose Pneumatics PU38-25B-B Blue Flexcoil Polyurethane Foamy Hose With Reusable Strain Relief Fittings - 25ft. x 3/8in.', 'Each', 'p-2353-coilhose-pneumatics-pu38-25b-b-blue-flexcoil-polyurethane-foamy-hose-with-reusable-strain-relief-fittings-25ft-x-3-8in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2353.jpg', 1, 2),
  ('kleen_rite', 'DSH41BL', 'Kleen-Rite Dura-Slide Blue Premium Vacuum Hose - 15 ft. x 1 1/2 in.', 'Each', 'p-70123-kleen-rite-dura-slide-blue-premium-vacuum-hose-15-ft-x-1-1-2-in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/70123.jpg', 1, 5),
  ('kleen_rite', 'FP573145', 'Flojet G573145D Quick Connect Push Fitting G57 Series Air Pump - 5 GPM, 1/2in, Viton', 'Each', 'p-33584-flojet-g573145d-quick-connect-push-fitting-g57-series-air-pump-5-gpm-1-2in-viton.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/33584.jpg', 1, 1),
  ('kleen_rite', 'FP7020', 'Flojet G573215D Air Operated G57 Series Pump - 5 GPM, 1/2 Inch, Viton', 'Each', 'p-2091-flojet-g573215d-air-operated-g57-series-pump-5-gpm-1-2-inch-viton.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2091.jpg', 1, 4),
  ('kleen_rite', 'GUK600NW', 'Kleen-Rite Gun, Non-Weep', 'Each', 'p-1224-kleen-rite-gun-non-weep.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/1224.jpg', 1, 2),
  ('kleen_rite', 'GYI12BL', 'Continental 20022686 Blue Insta-Grip Hose, 3/4 in.', 'Each', 'p-2633-continental-20022686-blue-insta-grip-hose-3-4-in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2739.jpg', 1, 50),
  ('kleen_rite', 'HA1506WBK1414', '150 Ft. Black 3/8 In Single Wirebraid Hose, 3/8 In MPE', 'Each', 'p-11187-150-ft-black-3-8-in-single-wirebraid-hose-3-8-in-mpe.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/HA506BK1414HP.jpg', 1, 1),
  ('kleen_rite', 'HYPN2520P4', 'Hypro FanJet 25 Degree Flat Fan PVDF Nozzle - 0.25 In. MNPT, No. 20', 'Each', 'p-30898-hypro-fanjet-25-degree-flat-fan-pvdf-nozzle-0-25-in-mnpt-no-20.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/30898.jpg', 1, 10),
  ('kleen_rite', 'JFVTS16', 'Jobe 1 Inch Topaz Standard Float Valve with Long Tail', 'Each', 'p-27615-jobe-1-inch-topaz-standard-float-valve-with-long-tail.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/27615.jpg', 1, 3),
  ('kleen_rite', 'JFVTS16D', 'Jobe Valves J-TPV1D Topaz Float Valve with Detachable Base and Short Tail - 1 in. NPT', 'Each', 'p-61381-jobe-valves-j-tpv1d-topaz-float-valve-with-detachable-base-and-short-tail-1-in-npt.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/61381.jpg', 1, 2),
  ('kleen_rite', 'JG6CV', 'John Guest 38SCV Acetal Resin Push-Fit In-Line Check Valve - 3/8 Push x 3/8 Push', 'Each', 'p-2946-john-guest-38scv-acetal-resin-push-fit-in-line-check-valve-3-8-push-x-3-8-push.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2946.jpg', 1, 5),
  ('kleen_rite', 'JG8SE6', 'John Guest Swivel Elbow Pneumatic Fitting - 1/2 Polytube x 3/8 MNPT', 'Each', 'p-31692-john-guest-swivel-elbow-pneumatic-fitting-1-2-polytube-x-3-8-mnpt.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/31692.jpg', 1, 2),
  ('kleen_rite', 'NP139BL', 'Hamel 139 Blue Plastic 1/4 in. and 1/8 in. Tip Protector', 'Each', 'p-22334-hamel-139-blue-plastic-1-4-in-and-1-8-in-tip-protector.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/22334.jpg', 1, 4),
  ('kleen_rite', 'PLF390', 'Push Barb Swivel - 3/4 Inch Hose I.D. X 3/4 Inch Male NPTF', 'Each', 'p-14544-push-barb-swivel-3-4-inch-hose-i-d-x-3-4-inch-male-nptf.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/14544.jpg', 1, 4),
  ('kleen_rite', 'PU06105', 'CAT Pumps 6105 Hydraulic ISO 68 Crankcase Oil - 2.5 Gallon Jug', 'Each', 'p-847-cat-pumps-6105-hydraulic-iso-68-crankcase-oil-2-5-gallon-jug.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/847.jpg', 1, 2),
  ('kleen_rite', 'SN2508M2', 'Spraying Systems 1/8 In. Male NPT WashJet MEG Spray Tip 2508', 'Each', 'p-17967-spraying-systems-1-8-in-male-npt-washjet-meg-spray-tip-2508.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/washjet-meg.jpg', 1, 5),
  ('kleen_rite', 'SN2508M4', 'Spraying Systems 1/4 in. Male NPT WashJet Spray Tip, 2508', 'Each', 'p-17968-spraying-systems-1-4-in-male-npt-washjet-spray-tip-2508.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/washjet-meg.jpg', 1, 4),
  ('kleen_rite', 'SN4008M4', 'Spraying Systems 1/4 in. Male NPT WashJet Spray Tip, 4008', 'Each', 'p-18032-spraying-systems-1-4-in-male-npt-washjet-spray-tip-4008.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/washjet-meg.jpg', 1, 4),
  ('kleen_rite', 'SNCJ55X22', 'Spraying Systems 5500-X22 Adjustable Brass Cone Jet Tip No.22', 'Each', 'p-18227-spraying-systems-5500-x22-adjustable-brass-cone-jet-tip-no-22.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/18227.jpg', 1, 2),
  ('kleen_rite', 'SNCJ55X8', 'Spraying Systems 5500-X8 ConeJet Adjustable Brass Spray Tip', 'Each', 'p-3105-spraying-systems-5500-x8-conejet-adjustable-brass-spray-tip.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/3105.jpg', 1, 2),
  ('kleen_rite', 'SNCP19843', 'Spraying Systems 19843-NYR Shutoff Cap', 'Each', 'p-26128-spraying-systems-19843-nyr-shutoff-cap.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/26128.jpg', 1, 6),
  ('kleen_rite', 'SNQJFJP8003', 'Spraying Systems QJFJP-8003 QuickJet FoamJet Blue Insert Nozzle - 03 Capacity, 80 Degree Angle', 'Each', 'p-27792-spraying-systems-qjfjp-8003-quickjet-foamjet-blue-insert-nozzle-03-capacity-80-degree-angle.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/27792.jpg', 1, 5),
  ('kleen_rite', 'SOD416P120-DIN', 'Dema A416P.6D Brass 3/4 in. Normally Closed Direct Acting Valve with 120VAC DIN Connector', 'Each', 'p-67064-dema-a416p-6d-brass-3-4-in-normally-closed-direct-acting-valve-with-120vac-din-connector.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/67064.jpg', 1, 1),
  ('kleen_rite', 'SOD416PLC', 'Dema A416P 3/4 in. Brass Solenoid Valve Body - No Coil', 'Each', 'p-18613-dema-a416p-3-4-in-brass-solenoid-valve-body-no-coil.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/SOD416PLC.jpg', 1, 1),
  ('kleen_rite', 'SOD458PS24', 'Dema 458PS.3 NC 1" High Pressure Valve with Steel Sleeve and 24VAC Coil', 'Each', 'p-4443-dema-458ps-3-nc-1-high-pressure-valve-with-steel-sleeve-and-24vac-coil.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/4443.jpg', 1, 2),
  ('kleen_rite', 'SODK4129', 'Dema 41.29 Solenoid Valve Repair Kit for 416P Valves', 'Each', 'p-1842-dema-41-29-solenoid-valve-repair-kit-for-416p-valves.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/1842.jpg', 1, 4),
  ('kleen_rite', 'SODK4133', 'Dema 41.33 Solenoid Valve Repair Kit for 458P Valves', 'Each', 'p-1846-dema-41-33-solenoid-valve-repair-kit-for-458p-valves.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/1846.jpg', 1, 3),
  ('kleen_rite', 'SODK4918V', 'Dema 49.1.8B Valve Repair Kit - Viton Seat 1/8 in. Orifice', 'Each', 'p-31397-dema-49-1-8b-valve-repair-kit-viton-seat-1-8-in-orifice.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/SODK4918V.jpg', 1, 2),
  ('kleen_rite', 'SODK6178V', 'Dema 61.78V Solenoid Valve Repair Kit with Viton Diaphragm', 'Each', 'p-18664-dema-61-78v-solenoid-valve-repair-kit-with-viton-diaphragm.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/18664.jpg', 1, 8),
  ('kleen_rite', 'SUT1500NW', 'Suttner 201500910 ST-1500 Spray Gun - Non-Weep', 'Each', 'p-2269-suttner-201500910-st-1500-spray-gun-non-weep.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/2269.jpg', 1, 5),
  ('kleen_rite', 'SW7080', 'Kleen-Rite 7080 Straight Brass Swivel - 3/8in. MxF, 3000 PSI', 'Each', 'p-1543-kleen-rite-7080-straight-brass-swivel-3-8in-mxf-3000-psi.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/1543.jpg', 1, 2),
  ('kleen_rite', 'SWM40032', 'Mosmatic 40.032 WDG 90 Degree Boom Swivel - 0.375 in. NPTF x NPTM, 2200 PSI', 'Each', 'p-1565-mosmatic-40-032-wdg-90-degree-boom-swivel-0-375-in-nptf-x-nptm-2200-psi.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/1565.jpg', 1, 3),
  ('kleen_rite', 'TSCW532', 'London Mat 6260 Regular Floor Switch  - 5 in. x 32 in.', 'Each', 'p-3694-london-mat-6260-regular-floor-switch-5-in-x-32-in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/3694.jpg', 1, 1),
  ('kleen_rite', 'VAA-10S', 'Vac Swivel Cuff Gray 1 1/2 in. Hose x 1 1/2 in. Nozzle', 'Each', 'p-824-vac-swivel-cuff-gray-1-1-2-in-hose-x-1-1-2-in-nozzle.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/824.jpg', 1, 10),
  ('kleen_rite', 'VAAB5996010', 'J.E. Adams B5996-010 Inline Fuse - 10 Amp', 'Each', 'p-19740-j-e-adams-b5996-010-inline-fuse-10-amp.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/19740.jpg', 1, 20),
  ('kleen_rite', 'VAB-15B', 'Mr. Nozzle 1 1/2 in. Black Plastic Claw Style Vacuum Nozzle', 'Each', 'p-817-mr-nozzle-1-1-2-in-black-plastic-claw-style-vacuum-nozzle.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/817.jpg', 1, 10),
  ('kleen_rite', 'VACT20', 'Mr. Nozzle CT-A Black Car Wash Vacuum Slim Line Crevice Tool - 16 in. x 1 1/2 in.', 'Each', 'p-31218-mr-nozzle-ct-a-black-car-wash-vacuum-slim-line-crevice-tool-16-in-x-1-1-2-in.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/31218.jpg', 1, 10),
  ('kleen_rite', 'VCHA150', 'Hose Adapter for 1 1/2 in. Hose (For Central Vac Systems)', 'Each', 'p-39034-hose-adapter-for-1-1-2-in-hose-for-central-vac-systems.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/39034.jpg', 1, 10),
  ('kleen_rite', 'VCV500', 'Steel Inlet Valve for Central Vacuum Systems - 2 in. MPT x 1 1/2 in. Hose', 'Each', 'p-39035-steel-inlet-valve-for-central-vacuum-systems-2-in-mpt-x-1-1-2-in-hose.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/39035.jpg', 1, 10),
  ('kleen_rite', 'VCV500-K', 'Steel Inlet Valve and Hose Adapter Kit for Central Vacuum Systems', 'Each', 'p-75803-steel-inlet-valve-and-hose-adapter-kit-for-central-vacuum-systems.aspx', 'https://cdn.kleen-ritecorp.com/klrt-externalstorage/Kleen-Rite/images/product%20images/74692.jpg', 1, 5)
on conflict (vendor, sku) do update set
  name = excluded.name,
  uom = excluded.uom,
  product_path = excluded.product_path,
  image_url = excluded.image_url,
  times_ordered = excluded.times_ordered,
  typical_qty = excluded.typical_qty,
  updated_at = now();
