// The giveaway settings fields, shared by "New giveaway" and the edit page.
// Rendered inside an <ActionForm>; names are read by settingsFrom() in
// ../actions.ts.
//
// The point of this page: the entry fields are fixed, so setting up a new
// contest is choosing Off / Optional / Required per field -- no form builder.

import {
  GIVEAWAY_FIELD_DEFAULT_LABEL,
  GIVEAWAY_FIELD_KEYS,
  GIVEAWAY_LABEL_MAX,
  GIVEAWAY_PRIZE_MAX,
  GIVEAWAY_SMS_CONSENT_TEXT,
  GIVEAWAY_TITLE_MAX,
  defaultGiveawayFields,
  type GiveawayFieldKey,
  type GiveawayFields,
  type GiveawaySmsConsent
} from "@splash/forms-schema/giveaway";

const LABEL = "block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none";

const HINT: Record<GiveawayFieldKey, string> = {
  site: "Customer types the 3-digit site number; the site's name shows as they type. A tablet link with ?site= fills it in for them.",
  name: "",
  email: "",
  phone: "10-digit US number.",
  plate: "Stored as letters and numbers only (spaces and dashes dropped).",
  barcode: "Typed in. Rename it if it's really something else, e.g. \"Receipt number\"."
};

export interface SettingsValues {
  title: string;
  prize: string | null;
  starts_on: string | null;
  ends_on: string | null;
  fields: GiveawayFields;
  sms_consent: GiveawaySmsConsent;
  one_per_person: boolean;
}

export const NEW_GIVEAWAY: SettingsValues = {
  title: "",
  prize: null,
  starts_on: null,
  ends_on: null,
  fields: defaultGiveawayFields(),
  sms_consent: "optional",
  one_per_person: true
};

export function SettingsForm({ v }: { v: SettingsValues }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <label className={LABEL} htmlFor="gw-title">
          Title (shown at the top of the entry page)
        </label>
        <input id="gw-title" name="title" required maxLength={GIVEAWAY_TITLE_MAX} defaultValue={v.title} placeholder="e.g. Win 2 Bills tickets!" className={INPUT} />
      </div>
      <div className="space-y-1">
        <label className={LABEL} htmlFor="gw-prize">
          Description (optional)
        </label>
        <textarea
          id="gw-prize"
          name="prize"
          rows={3}
          maxLength={GIVEAWAY_PRIZE_MAX}
          defaultValue={v.prize ?? ""}
          placeholder="e.g. Enter for a chance to win 2 tickets to the Dec 14 game. Winner drawn Dec 8."
          className={INPUT}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={LABEL} htmlFor="gw-start">
            First day of entries
          </label>
          <input id="gw-start" name="starts_on" type="date" defaultValue={v.starts_on ?? ""} className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className={LABEL} htmlFor="gw-end">
            Last day of entries
          </label>
          <input id="gw-end" name="ends_on" type="date" defaultValue={v.ends_on ?? ""} className={INPUT} />
        </div>
      </div>
      <p className="-mt-3 text-xs text-splash-navy/60">Leave blank for no limit. Days are Eastern time; the last day is included.</p>

      <fieldset className="space-y-2">
        <legend className={LABEL}>What customers fill in</legend>
        <div className="divide-y divide-gray-light rounded-splash-sm border border-gray-light">
          {GIVEAWAY_FIELD_KEYS.map((k) => (
            <div key={k} className="grid gap-2 p-3 sm:grid-cols-[9rem_1fr] sm:items-center">
              <div className="text-sm font-semibold text-splash-navy">{GIVEAWAY_FIELD_DEFAULT_LABEL[k]}</div>
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={GIVEAWAY_FIELD_DEFAULT_LABEL[k]}>
                  {(["off", "optional", "required"] as const).map((m) => (
                    <label
                      key={m}
                      className="flex cursor-pointer items-center gap-1.5 rounded-full border border-gray-light px-3 py-1 text-sm text-splash-navy has-[:checked]:border-splash-blue has-[:checked]:bg-splash-blue/10 has-[:checked]:font-semibold"
                    >
                      <input type="radio" name={`mode_${k}`} value={m} defaultChecked={v.fields[k].mode === m} className="accent-splash-blue" />
                      {m === "off" ? "Off" : m === "optional" ? "Optional" : "Required"}
                    </label>
                  ))}
                </div>
                <input
                  name={`label_${k}`}
                  maxLength={GIVEAWAY_LABEL_MAX}
                  defaultValue={v.fields[k].label ?? ""}
                  placeholder={`Label on the page (default "${GIVEAWAY_FIELD_DEFAULT_LABEL[k]}")`}
                  aria-label={`Label for ${GIVEAWAY_FIELD_DEFAULT_LABEL[k]}`}
                  className={`${INPUT} text-xs`}
                />
                {HINT[k] && <p className="text-xs text-splash-navy/60">{HINT[k]}</p>}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className={LABEL}>Text-message consent box</legend>
        <p className="text-xs text-splash-navy/60">Only shown when Phone is on. The box always starts unticked.</p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["off", "Don't show it"],
              ["optional", "Optional"],
              ["required", "Required to enter"]
            ] as const
          ).map(([val, label]) => (
            <label
              key={val}
              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-gray-light px-3 py-1 text-sm text-splash-navy has-[:checked]:border-splash-blue has-[:checked]:bg-splash-blue/10 has-[:checked]:font-semibold"
            >
              <input type="radio" name="sms_consent" value={val} defaultChecked={v.sms_consent === val} className="accent-splash-blue" />
              {label}
            </label>
          ))}
        </div>
        <p className="rounded-splash-sm border border-gray-light bg-splash-navy/5 p-3 text-xs text-splash-navy/80">
          {GIVEAWAY_SMS_CONSENT_TEXT}
        </p>
        <p className="text-xs text-splash-navy/60">
          &ldquo;Required to enter&rdquo; makes texting consent a condition of entering. Check with whoever handles SMS compliance
          before using it.
        </p>
      </fieldset>

      <label className="flex items-start gap-2 text-sm text-splash-navy">
        <input type="checkbox" name="one_per_person" defaultChecked={v.one_per_person} className="mt-0.5 accent-splash-blue" />
        <span>
          <span className="font-semibold">One entry per person.</span> A phone number, email, plate or barcode already entered in this
          giveaway is turned away.
        </span>
      </label>
    </div>
  );
}
