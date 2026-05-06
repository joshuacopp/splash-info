// Three table-management cards. Brief 30 split this out from page.tsx as
// part of the two-mode hub restructure (Manage Users / Manage Tables).
//
// Cards (in order): Add location (Brief 24 — pricing_simple bulk insert),
// Update package (Brief 26 — per-row edit), Update location (Brief 27 —
// locations row edit; cascades via triggers). Each is wrapped in
// <OperationCard>; bodies are existing client islands.

import { AddLocationCard } from "../_components/AddLocationCard";
import { OperationCard } from "../_components/OperationCard";
import { UpdateLocationCard } from "../_components/UpdateLocationCard";
import { UpdatePackageCard } from "../_components/UpdatePackageCard";

export function TableOperations() {
  return (
    <>
      <AddLocationOperationCard />
      <UpdatePackageOperationCard />
      <UpdateLocationOperationCard />
    </>
  );
}

function AddLocationOperationCard() {
  return (
    <OperationCard
      title="Add location"
      description="Insert pricing_simple rows for a brand-new location. Atomic — all rows or none. Defaults to pricing = 'full'."
    >
      <AddLocationCard />
    </OperationCard>
  );
}

function UpdatePackageOperationCard() {
  return (
    <OperationCard
      title="Update package pricing"
      description="Pick a location, then multi-select packages and edit pkg$/single/sort across the selection. For rename, pricing-mode, flash2/5, or location_pretty edits, use the deprecated single-row endpoint."
    >
      <UpdatePackageCard />
    </OperationCard>
  );
}

function UpdateLocationOperationCard() {
  return (
    <OperationCard
      title="Update location"
      description="Search a locations row by site #, name, address, or manager, then edit denormalized fields (manager names + emails, address, hrt_email, rm_group, site). DB triggers cascade into pricing_simple + user_permissions."
    >
      <UpdateLocationCard />
    </OperationCard>
  );
}
