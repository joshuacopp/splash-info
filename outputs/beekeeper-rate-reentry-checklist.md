# Beekeeper `rate` field swap — re-entry checklist

Exported from Supabase before deleting the integer `rate` custom field.
**36 users.** Keep this file until the last box is ticked and a sync has verified.

## Before you start

- New field key must be exactly **`rate`** (lowercase). `customField()` does an
  exact case-sensitive match with no error path — `Rate` or `rate_1` means every
  user reads as unrated forever and nothing complains.
- New field visibility must be **admin**, not public. Public publishes every
  pay rate to everyone in Beekeeper.
- New field type: **text**.
- Tell managers to hold off entering rates until this is done. Anything typed
  into Beekeeper during the swap window is lost.

## Re-entry list (Beekeeper, alphabetical — matches the admin user list order)

| ✓ | Name | Pay type | Rate |
|---|------|----------|------|
| ☐ | Alexandrea Walts | Hourly | 18.00 |
| ☐ | Anthony Ellis | Hourly | 18.00 |
| ☐ | Anthony Miller | Hourly | 16.00 |
| ☐ | Anthony Nesbitt | Hourly | 16.00 |
| ☐ | Anthony Valette | Hourly | 18.00 |
| ☐ | Austin Douglas | Hourly | 17.00 |
| ☐ | Brandon Adams | Hourly | 16.00 |
| ☐ | Cole Shroyer | **Salary** | 36.00 |
| ☐ | Cory Gill | Hourly | 18.00 |
| ☐ | Daniel Ralston | Hourly | 17.00 |
| ☐ | David Lee | Hourly | 18.00 |
| ☐ | Davonte Cheeseboro | Hourly | 18.00 |
| ☐ | Emma Bova | Hourly | 18.00 |
| ☐ | Hasan Wakefield | Hourly | 17.00 |
| ☐ | James Fenner | Hourly | 18.00 |
| ☐ | James Kelley | Hourly | 16.00 |
| ☐ | Jimmy Russell | Hourly | 16.00 |
| ☐ | Juan Perez | Hourly | 20.00 |
| ☐ | Kayla Mathews | Hourly | 17.00 |
| ☐ | Kaylee Shoemaker | **Salary** | 42.00 |
| ☐ | Kedar Clarke | Hourly | 20.00 |
| ☐ | Keigan Sowka | Hourly | 27.00 |
| ☐ | Kevin Talton | Hourly | 16.00 |
| ☐ | Kyra Adams | Hourly | 18.00 |
| ☐ | Lauren Dubois | Hourly | 27.00 |
| ☐ | Leila Novljakovic | Hourly | 23.00 |
| ☐ | Leviticus Phrakousonh | Hourly | 16.00 |
| ☐ | Michael Jones | Hourly | 16.00 |
| ☐ | Mitchel Kirk | Hourly | 17.00 |
| ☐ | Nathan Schneider | Hourly | 20.00 |
| ☐ | Patrick McCarthy | Hourly | 16.00 |
| ☐ | Skylar Baranyk | Hourly | 16.00 |
| ☐ | Stephen Tran | Hourly | 16.00 |
| ☐ | Tyler Rowand | Hourly | 20.00 |
| ☐ | Vestal Wash | *(none — tablet profile, not a person)* | 20.00 |
| ☐ | Walt Mann | Hourly | 23.00 |

Type bare decimals: `18.00` or `18`. Not `$18.00`, not `18,00` — those parse as
NaN and read as unrated until the parser hardening ships.

## Verify after re-entry

Run a sync (`POST /schedule/api/sync-users` as super_admin), then:

```sql
SELECT count(*) FILTER (WHERE rate IS NOT NULL) AS with_rate,
       count(*) AS total
  FROM beekeeper_users;
```

Expect `with_rate = 36`. If it comes back 0, the new field's key or visibility
is wrong.

Then spot-check that decimals survive end to end — enter one real half-dollar
rate and confirm it lands as `.50` rather than truncating:

```sql
SELECT display_name, pay_type, rate
  FROM beekeeper_users
 WHERE rate IS NOT NULL
 ORDER BY rate DESC, display_name;
```

## Stopgap only — restores Supabase, NOT Beekeeper

The next sync overwrites all of this with whatever Beekeeper holds. Use it only
to keep schedules pricing correctly during a long gap between deleting the field
and finishing re-entry. It is not the re-entry.

```sql
UPDATE beekeeper_users SET rate = 18.00 WHERE id = '127f1142-6a02-45b1-92f8-f3c4260bf486'; -- Alexandrea Walts
UPDATE beekeeper_users SET rate = 18.00 WHERE id = '007e5252-31d9-495d-b530-f587e3e2e1ee'; -- Anthony Ellis
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '3e9ae5d3-9a31-4b2b-8f5f-39c3f68b7148'; -- Anthony Miller
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '7f0a4c27-f771-4945-a227-2f5cbc73dce5'; -- Anthony Nesbitt
UPDATE beekeeper_users SET rate = 18.00 WHERE id = 'd486ac1e-c067-42d4-9495-64939eb999d2'; -- Anthony Valette
UPDATE beekeeper_users SET rate = 17.00 WHERE id = '51bee547-ac38-432a-bf86-84135839d613'; -- Austin Douglas
UPDATE beekeeper_users SET rate = 16.00 WHERE id = 'd271068d-f5b5-4300-b092-c3d95c8f7802'; -- Brandon Adams
UPDATE beekeeper_users SET rate = 36.00 WHERE id = 'c39dba2c-8aff-4c00-8a34-7828e3331bb9'; -- Cole Shroyer
UPDATE beekeeper_users SET rate = 18.00 WHERE id = '37ef2079-ae23-4ff6-aa92-2ef7689bfe36'; -- Cory Gill
UPDATE beekeeper_users SET rate = 17.00 WHERE id = '9f464329-94e9-4535-88c3-eff0aa8c2731'; -- Daniel Ralston
UPDATE beekeeper_users SET rate = 18.00 WHERE id = '4d9060fd-8e65-4ba1-93ae-605522afe1ae'; -- David Lee
UPDATE beekeeper_users SET rate = 18.00 WHERE id = 'd44a9120-7b60-4adc-b148-48404a7264b7'; -- Davonte Cheeseboro
UPDATE beekeeper_users SET rate = 18.00 WHERE id = '92c3eab7-ff54-4daa-84de-a902f2e20311'; -- Emma Bova
UPDATE beekeeper_users SET rate = 17.00 WHERE id = '222b616f-607b-48f3-9369-94b2ff2888c5'; -- Hasan Wakefield
UPDATE beekeeper_users SET rate = 18.00 WHERE id = 'cd10a4e8-c2a7-4174-adb3-bb6791d5f79b'; -- James Fenner
UPDATE beekeeper_users SET rate = 16.00 WHERE id = 'cd38e6be-02f7-4f8a-bd59-642aafbd8bdf'; -- James Kelley
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '515481d6-24e9-47cd-977c-2e098d90bafd'; -- Jimmy Russell
UPDATE beekeeper_users SET rate = 20.00 WHERE id = '4f100bbc-bd7c-47af-8e68-2d48a3a89c4e'; -- Juan Perez
UPDATE beekeeper_users SET rate = 17.00 WHERE id = 'd3e27654-eda9-4c4c-b992-40494a699b33'; -- Kayla Mathews
UPDATE beekeeper_users SET rate = 42.00 WHERE id = '0a401394-5e45-481c-81aa-75cbcfb6fd1c'; -- Kaylee Shoemaker
UPDATE beekeeper_users SET rate = 20.00 WHERE id = '39a66b87-4731-46db-9464-935934250042'; -- Kedar Clarke
UPDATE beekeeper_users SET rate = 27.00 WHERE id = 'fe2538aa-e97c-435a-bad6-8b3512972729'; -- Keigan Sowka
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '9d9d8bc8-555d-4322-aae7-178e4e5f8c75'; -- Kevin Talton
UPDATE beekeeper_users SET rate = 18.00 WHERE id = '970c3100-c161-4803-8c91-5fc81e7596d0'; -- Kyra Adams
UPDATE beekeeper_users SET rate = 27.00 WHERE id = 'ccbf4b99-ec8a-4868-b5e4-0c8526ee198e'; -- Lauren Dubois
UPDATE beekeeper_users SET rate = 23.00 WHERE id = 'dc53d17e-fbfd-465e-8ebb-6066a4b70e64'; -- Leila Novljakovic
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '7ef81540-99f9-4176-ab4c-e24c74870c3b'; -- Leviticus Phrakousonh
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '37448bdc-5e44-4d9d-8c5b-38ee4584bb34'; -- Michael Jones
UPDATE beekeeper_users SET rate = 17.00 WHERE id = '52d545dd-75a7-4e2f-bfb4-a7a4e8465ad3'; -- Mitchel Kirk
UPDATE beekeeper_users SET rate = 20.00 WHERE id = '99a01bff-07b9-478d-8aaa-50a593f43e2d'; -- Nathan Schneider
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '7434176f-b266-4492-ae0e-e6b6f196afd2'; -- Patrick McCarthy
UPDATE beekeeper_users SET rate = 16.00 WHERE id = '6209283e-1806-4b13-84bc-3daea2008ceb'; -- Skylar Baranyk
UPDATE beekeeper_users SET rate = 16.00 WHERE id = 'f976713c-03e5-4827-807a-9fb8a51c85a7'; -- Stephen Tran
UPDATE beekeeper_users SET rate = 20.00 WHERE id = 'c4c15263-28b2-4a48-b433-8ec17988fb18'; -- Tyler Rowand
UPDATE beekeeper_users SET rate = 20.00 WHERE id = 'b3d6df88-6489-44d2-89f7-952f8dd53b4b'; -- Vestal Wash
UPDATE beekeeper_users SET rate = 23.00 WHERE id = 'fe295fd0-6b15-471b-a3b1-2f5fbf197b65'; -- Walt Mann
```
