// Brief 61 — Set DC Role card. Sixth Manage Users card.
//
// Writes the damage-claim permission domain (damage_claim_user_roles +
// damage_claim_user_locations) which is independent of user_permissions
// (set via the Set Role card). A user can be `location_admin` for
// Oswego in user_permissions AND `gm` for Oswego in dc_role; both are
// needed.
//
// Server component shape mirrors the other Brief 7 user-mgmt cards.
// The dc_role select + locations multi-picker live inside a small
// client wrapper (SetDcRoleFields) so the picker can show/hide based
// on the chosen role. Worker re-validates on POST as defense in depth.

import { ActionForm } from "../../_components/ActionForm";
import {
  FieldLabel,
  OperationCard,
  submitClass
} from "./OperationCard";
import { LocationCodeMultiPicker } from "./LocationCodeMultiPicker";
import { SetDcRoleFields } from "./SetDcRoleFields";
import { UserPicker } from "./UserPicker";
import { setDcRoleAction } from "../actions";

export function SetDcRoleCard() {
  return (
    <OperationCard
      title="Set DC Role"
      description="Set or clear a user's damage-claim role + dc_locations. Independent of the user_permissions role above."
    >
      <ActionForm action={setDcRoleAction} className="space-y-4">
        <div>
          <FieldLabel htmlFor="set-dc-role-user-id" helper="Search by email">
            User
          </FieldLabel>
          <UserPicker
            name="user_id"
            inputId="set-dc-role-user-id"
            required
          />
        </div>

        <SetDcRoleFields
          selectId="set-dc-role-role"
          locationPicker={
            <LocationCodeMultiPicker
              name="location_codes"
              inputId="set-dc-role-locations"
            />
          }
        />

        <div className="pt-1">
          <button type="submit" className={submitClass}>
            Set DC Role
          </button>
        </div>
      </ActionForm>
    </OperationCard>
  );
}
