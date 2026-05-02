// D1 client + query helpers + migrations for the Splash MaxPass system.
//
// Currently used only by the damage worker, but exposed as a shared package
// for future workers that may need edge-native storage.
//
// Will wrap:
//   - claims table (damage)
//   - claim_photos table (damage)
//   - locations table (damage — site_number, location_pretty, is_active)
//   - claim activity / audit log (damage)
//
// To be ported in Step 5 from damagemanager.js.

export {};
