-- ============================================================================
-- inventory.location_products.sort_order — chemical order per site.
--
-- APPLIED 2026-10-23 to rewokyofschtvqgxrxwl (1161 rows / 82 sites ordered, every
-- site a clean 1..N run). Had to precede the worker that writes it:
-- savePackageConfig wipes and re-inserts a site's location_products, so an
-- insert carrying sort_order against a table without the column would fail
-- every package save.
--
-- WHY
--
-- Field request (October 2026): chemicals were listed A-Z everywhere, but a
-- count is taken walking the chem room, so the visit form should follow the
-- room. The order is set by dragging rows on the site's Package setup page and
-- is followed by the visit form, the delivery form, Package setup itself and
-- Usage trends. Analysis views (Visit Detail's sortable table, the email's
-- over-target ranking) keep their own sort.
--
-- Lower sorts first. NULL sorts last, then by name, so a row nobody has placed
-- (or one inserted by older code) still lands somewhere sensible.
--
-- The backfill numbers every site's existing rows A-Z by product name, i.e.
-- exactly what every screen shows today, so applying this moves nothing.
-- ============================================================================

begin;

alter table inventory.location_products
  add column if not exists sort_order integer;

update inventory.location_products lp
   set sort_order = ranked.rn
  from (
    select lp2.id,
           row_number() over (
             partition by lp2.location_code
             order by lower(p.name), p.id
           ) as rn
      from inventory.location_products lp2
      join inventory.products p on p.id = lp2.product_id
  ) ranked
 where ranked.id = lp.id
   and lp.sort_order is null;

comment on column inventory.location_products.sort_order is
  'Display order of this chemical at this site (lower first; NULL last, then name). '
  'Set by dragging on Package setup; followed by the visit and delivery forms.';

commit;

-- VERIFY — expect 0 rows without an order, and one 1..N run per site.
-- select count(*) from inventory.location_products where sort_order is null;
-- select location_code, count(*), min(sort_order), max(sort_order)
--   from inventory.location_products group by location_code order by 1;

-- ROLLBACK
-- alter table inventory.location_products drop column if exists sort_order;
