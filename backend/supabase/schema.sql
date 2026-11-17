-- ============================================================================
-- TINY ARTIST — Supabase schema (Phase 2)
-- ============================================================================
-- Run in the Supabase SQL Editor AFTER creating the project and enabling
-- Email auth with "Confirm email" turned on. Review before applying.
--
-- Security model:
--   * RLS is enabled on EVERY table. Deny by default.
--   * Admin status is decided ONLY by public.is_admin(), from the verified
--     Supabase Auth email. Exactly three addresses are allowlisted.
--     One of them is the SUPER ADMIN (public.is_super_admin()): only
--     that address may deactivate/reactivate the website.
--     The frontend NEVER decides admin status.
--   * Prices are decided ONLY by the products table. create_order() looks
--     prices up server-side and snapshots them. Client prices are ignored.
--   * Orders are always created as 'Pending Confirmation'. Nothing in this
--     schema marks an order confirmed because WhatsApp was opened.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- admin ----
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() ->> 'email'),
    (auth.jwt() -> 'user_metadata' ->> 'email')
  ) in (
    'moosamahmood20002512@gmail.com',
    'asadvendor0@gmail.com',
    'learnandlead36@gmail.com'
  )
  and coalesce((auth.jwt() ->> 'email_confirmed_at') is not null, false);
$$;

-- Super admin: exactly one address. Decided ONLY from the verified
-- Supabase Auth email, like is_admin(). Only the super admin may
-- deactivate/reactivate the website (set_site_deactivated) and view
-- access-attempt records.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() ->> 'email'),
    (auth.jwt() -> 'user_metadata' ->> 'email')
  ) = 'moosamahmood20002512@gmail.com'
  and coalesce((auth.jwt() ->> 'email_confirmed_at') is not null, false);
$$;

-- ---------------------------------------------------------------- tables ---
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  category_id uuid references public.categories (id) on delete set null,
  price_pkr integer, -- NULL = "Price Coming Soon": not orderable
  stock_quantity integer not null default 0,
  is_available boolean not null default true,
  is_kit boolean not null default false,
  sku text,
  cost_pkr integer, -- NULL = cost not set: profit cannot be computed, never guessed
  is_featured boolean not null default false,
  contents jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_price_nonnegative check (price_pkr is null or price_pkr >= 0),
  constraint products_cost_nonnegative check (cost_pkr is null or cost_pkr >= 0),
  constraint products_stock_nonnegative check (stock_quantity >= 0)
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  storage_path text not null, -- Supabase Storage path, never a blob in the DB
  alt_text text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  phone text,
  city text,
  address text,
  role text not null default 'customer',
  created_at timestamptz not null default now(),
  constraint profiles_role_valid check (role in ('customer', 'admin'))
);

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  session_id text, -- anonymous visitors: random session id, never personal data
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carts_owner_required check (user_id is not null or session_id is not null)
);

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity integer not null default 1,
  custom_pack jsonb, -- NULL unless this line is a Build-Your-Own pack
  created_at timestamptz not null default now(),
  constraint cart_items_quantity_valid check (quantity >= 1 and quantity <= 99)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_code text not null unique, -- e.g. TA-XXXXXX, generated by create_order
  user_id uuid references auth.users (id) on delete set null, -- NULL for guests
  customer_name text not null,
  customer_phone text not null,
  delivery_address text not null,
  city text not null,
  instructions text not null default '',
  subtotal_pkr integer not null,
  delivery_label text not null default 'To Be Confirmed',
  total_pkr integer not null,
  status text not null default 'Pending Confirmation',
  admin_notes text not null default '',
  delivery_lat double precision,
  delivery_lng double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_status_valid check (status in (
    'Pending Confirmation', 'Confirmed', 'Processing',
    'Completed', 'Cancelled'
  )),
  constraint orders_totals_nonnegative check (subtotal_pkr >= 0 and total_pkr >= 0)
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null, -- snapshot at order time
  unit_price_pkr integer not null, -- snapshot at order time (server price)
  quantity integer not null,
  line_total_pkr integer not null,
  custom_pack jsonb,
  constraint order_items_quantity_valid check (quantity >= 1),
  constraint order_items_price_nonnegative check (unit_price_pkr >= 0 and line_total_pkr >= 0)
);

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null, -- page_view | product_view | add_to_cart | checkout_started | order_created
  detail text not null default '',
  session_id text,
  user_id uuid references auth.users (id) on delete set null,
  path text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists idx_products_slug on public.products (slug);
create index if not exists idx_products_category on public.products (category_id);
create index if not exists idx_orders_created on public.orders (created_at desc);
create index if not exists idx_orders_status on public.orders (status);
create index if not exists idx_orders_user on public.orders (user_id);
create index if not exists idx_cart_items_cart on public.cart_items (cart_id);
create index if not exists idx_events_type_created on public.analytics_events (event_type, created_at desc);
create index if not exists idx_events_session on public.analytics_events (session_id);

-- ------------------------------------------------------- role protection ---
-- Nobody may change their own role through the profiles table. Admin status
-- comes from the email allowlist in is_admin(), not from this column.
create or replace function public.prevent_role_change()
returns trigger
language plpgsql
as $$
begin
  if old.role is distinct from new.role and not public.is_admin() then
    raise exception 'role changes are not allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_role_change on public.profiles;
create trigger trg_prevent_role_change
  before update on public.profiles
  for each row execute function public.prevent_role_change();

-- ------------------------------------------------------------- order fn ----
-- Transactional order creation with server-side price verification.
-- p_items: [{"product_id": "<uuid>", "quantity": 2}] for single
-- products/kits, or [{"quantity": 1, "custom_pack":
-- {"pack_product_id": "<uuid>", "figures": [{"product_id": "<uuid>",
-- "quantity": n}]}}] for Build-Your-Own packs, priced server-side as
-- colour-pack price + figure prices. Unpriced/inactive products are
-- rejected: the whole transaction rolls back and no order is created.
create or replace function public.create_order(
  p_customer jsonb,
  p_items jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_item jsonb;
  v_product public.products;
  v_pack public.products;
  v_fig jsonb;
  v_fig_product public.products;
  v_subtotal integer := 0;
  v_unit integer;
  v_code text;
begin
  if jsonb_array_length(p_items) < 1 then
    raise exception 'order must contain at least one item';
  end if;
  if length(trim(p_customer ->> 'name')) < 2
     or length(trim(p_customer ->> 'phone')) < 10
     or length(trim(p_customer ->> 'address')) < 8
     or length(trim(p_customer ->> 'city')) < 2 then
    raise exception 'incomplete delivery details';
  end if;

  v_code := 'TA-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));

  insert into public.orders (
    order_code, user_id, customer_name, customer_phone,
    delivery_address, city, instructions,
    subtotal_pkr, delivery_label, total_pkr, status
  ) values (
    v_code, auth.uid(),
    trim(p_customer ->> 'name'), trim(p_customer ->> 'phone'),
    trim(p_customer ->> 'address'), trim(p_customer ->> 'city'),
    coalesce(trim(p_customer ->> 'instructions'), ''),
    0, 'To Be Confirmed', 0, 'Pending Confirmation'
  ) returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item ? 'custom_pack' and v_item -> 'custom_pack' is not null then
      -- Build-Your-Own pack: ONE line priced as the colour-pack product
      -- plus each figure inside, all at server-side prices.
      select * into v_pack
        from public.products
       where id = ((v_item -> 'custom_pack') ->> 'pack_product_id')::uuid;
      if not found then
        raise exception 'unknown pack product';
      end if;
      if v_pack.price_pkr is null or not v_pack.is_available then
        raise exception 'pack not orderable: %', v_pack.name;
      end if;
      v_unit := v_pack.price_pkr;
      for v_fig in select * from jsonb_array_elements((v_item -> 'custom_pack') -> 'figures') loop
        select * into v_fig_product
          from public.products
         where id = (v_fig ->> 'product_id')::uuid;
        if not found then
          raise exception 'unknown product: %', v_fig ->> 'product_id';
        end if;
        if v_fig_product.price_pkr is null or not v_fig_product.is_available then
          raise exception 'product not orderable: %', v_fig_product.name;
        end if;
        v_unit := v_unit + v_fig_product.price_pkr * (v_fig ->> 'quantity')::integer;
      end loop;
      v_subtotal := v_subtotal + v_unit * (v_item ->> 'quantity')::integer;
      insert into public.order_items (
        order_id, product_id, product_name, unit_price_pkr,
        quantity, line_total_pkr, custom_pack
      ) values (
        v_order.id, v_pack.id, v_pack.name, v_unit,
        (v_item ->> 'quantity')::integer,
        v_unit * (v_item ->> 'quantity')::integer,
        v_item -> 'custom_pack'
      );
    else
      select * into v_product
        from public.products
       where id = (v_item ->> 'product_id')::uuid;
      if not found then
        raise exception 'unknown product: %', v_item ->> 'product_id';
      end if;
      if v_product.price_pkr is null or not v_product.is_available then
        raise exception 'product not orderable: %', v_product.name;
      end if;
      v_subtotal := v_subtotal + v_product.price_pkr * (v_item ->> 'quantity')::integer;
      insert into public.order_items (
        order_id, product_id, product_name, unit_price_pkr,
        quantity, line_total_pkr, custom_pack
      ) values (
        v_order.id, v_product.id, v_product.name, v_product.price_pkr,
        (v_item ->> 'quantity')::integer,
        v_product.price_pkr * (v_item ->> 'quantity')::integer,
        v_item -> 'custom_pack'
      );
    end if;
  end loop;

  update public.orders
     set subtotal_pkr = v_subtotal,
         total_pkr = v_subtotal,
         delivery_label = case when v_subtotal > 2000 then 'FREE' else 'To Be Confirmed' end,
         updated_at = now()
   where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

-- ------------------------------------------------------------------- RLS ---
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.profiles enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.analytics_events enable row level security;

-- Public catalogue reads; only admins write.
create policy "catalogue read" on public.categories for select using (true);
create policy "catalogue read" on public.products for select using (true);
create policy "catalogue read" on public.product_images for select using (true);
create policy "admin write" on public.categories for all using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.products for all using (public.is_admin()) with check (public.is_admin());
create policy "admin write" on public.product_images for all using (public.is_admin()) with check (public.is_admin());

-- Profiles: users read/update their own row (role change blocked by trigger); admins read all.
create policy "own profile read" on public.profiles for select using (auth.uid() = id or public.is_admin());
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- Carts: owners only (user or matching session); admins read all.
create policy "cart owner" on public.carts for all
  using (auth.uid() = user_id or public.is_admin())
  with check (auth.uid() = user_id or user_id is null);
create policy "cart items owner" on public.cart_items for all
  using (exists (select 1 from public.carts c where c.id = cart_id and (c.user_id = auth.uid() or public.is_admin())))
  with check (exists (select 1 from public.carts c where c.id = cart_id and c.user_id = auth.uid()));

-- Orders: created only via create_order() (no direct insert policy for anon).
-- Customers read their own orders; admins read/update all. No direct delete.
create policy "order read own or admin" on public.orders for select
  using (public.is_admin() or (auth.uid() is not null and auth.uid() = user_id));
create policy "order admin update" on public.orders for update
  using (public.is_admin()) with check (public.is_admin());
create policy "order items read" on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id
                 and (public.is_admin() or (auth.uid() is not null and auth.uid() = o.user_id))));

-- Analytics: anyone may insert events; only admins may read them.
create policy "events insert" on public.analytics_events for insert with check (true);
create policy "events admin read" on public.analytics_events for select using (public.is_admin());

-- ------------------------------------------------------------- seed data ---
-- Kit prices from the verified posters. Every figure costs Rs. 70
-- (owner-confirmed 2026-11-16). Ready-made packs use the official prices
-- the owner supplied for the admin panel; they are separate products and
-- do NOT replace the poster kits. Colour packs start unpriced on purpose:
-- the owner sets their prices before custom packs become orderable.
insert into public.categories (name, slug) values
  ('Painting Kits', 'painting-kits'),
  ('Space', 'space'),
  ('Food & Drinks', 'food-drinks'),
  ('Ocean', 'ocean'),
  ('Nature', 'nature'),
  ('Everyday Objects', 'everyday-objects'),
  ('Colour Packs', 'colour-packs')
on conflict (slug) do nothing;

insert into public.products (slug, name, description, category_id, price_pkr, is_kit, contents) values
  ('20-pcs-painting-set', '20 Pcs Painting Set',
   '20 paintable pieces with 12 colours. Free Cash on Delivery.',
   (select id from public.categories where slug = 'painting-kits'), 1000, true,
   '["20 paintable pieces", "12 colours", "Paint brushes as shown on the poster", "Free Cash on Delivery"]'::jsonb),
  ('30-pcs-painting-kit', '30 Pcs Painting Kit',
   '30 paintable pieces with a 12-colour strip, 3 big colours and 4 brushes.',
   (select id from public.categories where slug = 'painting-kits'), 1300, true,
   '["30 paintable pieces", "12 Colour Strip", "3 Big Colours", "4 Brushes"]'::jsonb)
on conflict (slug) do nothing;

-- Ready-made packs (official prices supplied by the owner; free home delivery).
insert into public.products (slug, name, description, category_id, price_pkr, is_kit, contents) values
  ('pack-15-big-pieces', '15 Big Pieces Pack',
   '15 big paintable pieces with 6 colours and 2 brushes. Free home delivery.',
   (select id from public.categories where slug = 'painting-kits'), 899, true,
   '["15 Big Pieces", "6 Colors", "2 Brushes", "FREE HOME DELIVERY"]'::jsonb),
  ('pack-20-big-pieces', '20 Big Pieces Pack',
   '20 big paintable pieces with 12 colours and 3 brushes. Free home delivery.',
   (select id from public.categories where slug = 'painting-kits'), 1199, true,
   '["20 Big Pieces", "12 Colors", "3 Brushes", "FREE HOME DELIVERY"]'::jsonb),
  ('pack-30-big-pieces', '30 Big Pieces Pack',
   '30 big paintable pieces with 18 colours and 5 brushes. Free home delivery.',
   (select id from public.categories where slug = 'painting-kits'), 1499, true,
   '["30 Big Pieces", "18 Colors", "5 Brushes", "FREE HOME DELIVERY"]'::jsonb)
on conflict (slug) do nothing;

-- Colour packs for Build Your Own Pack (prices set by the owner later).
insert into public.products (slug, name, description, category_id, price_pkr, is_kit, contents) values
  ('small-colour-pack', 'Small Colour Pack',
   'Green, pink, orange and black paints plus a red-handled paintbrush with black bristles.',
   (select id from public.categories where slug = 'colour-packs'), null, false,
   '["Green", "Pink", "Orange", "Black", "Red-handled paintbrush with black bristles"]'::jsonb),
  ('large-colour-pack', 'Large Colour Pack',
   'Red, yellow, blue, green, pink, orange and black paints plus a red-handled paintbrush with black bristles.',
   (select id from public.categories where slug = 'colour-packs'), null, false,
   '["Red", "Yellow", "Blue", "Green", "Pink", "Orange", "Black", "Red-handled paintbrush with black bristles"]'::jsonb)
on conflict (slug) do nothing;

-- The 16 figures, Rs. 70 each.
insert into public.products (slug, name, description, category_id, price_pkr, sku) values
  ('cute-baby-astronaut', 'Cute Baby Astronaut', 'A tiny astronaut ready for a colourful mission beyond the stars.', (select id from public.categories where slug = 'space'), 70, 'TA-CUTE-BABY-ASTRONAUT'),
  ('honey-jar', 'Honey Jar', 'A sweet little honey jar, waiting for golden yellows and warm ambers.', (select id from public.categories where slug = 'food-drinks'), 70, 'TA-HONEY-JAR'),
  ('football', 'Football', 'A classic football figure for little sports fans to paint their way.', (select id from public.categories where slug = 'everyday-objects'), 70, 'TA-FOOTBALL'),
  ('burger', 'Burger', 'A cheerful burger figure — stack it with your favourite colours.', (select id from public.categories where slug = 'food-drinks'), 70, 'TA-BURGER'),
  ('planet-earth', 'Planet Earth', 'Our home planet in miniature, ready for blues, greens and imagination.', (select id from public.categories where slug = 'space'), 70, 'TA-PLANET-EARTH'),
  ('honey-dipper', 'Honey Dipper', 'A swirly honey dipper figure, perfect for warm honey tones.', (select id from public.categories where slug = 'food-drinks'), 70, 'TA-HONEY-DIPPER'),
  ('french-fries', 'French Fries', 'Crispy little fries in their carton — paint them golden.', (select id from public.categories where slug = 'food-drinks'), 70, 'TA-FRENCH-FRIES'),
  ('rocket', 'Rocket', 'A rocket ready for lift-off in whatever colours you dream up.', (select id from public.categories where slug = 'space'), 70, 'TA-ROCKET'),
  ('airplane', 'Airplane', 'A friendly little airplane for high-flying colour adventures.', (select id from public.categories where slug = 'everyday-objects'), 70, 'TA-AIRPLANE'),
  ('seashell', 'Seashell', 'A gentle seashell figure, straight from an imaginary beach.', (select id from public.categories where slug = 'ocean'), 70, 'TA-SEASHELL'),
  ('flower', 'Flower', 'A happy flower that can bloom in every colour of the rainbow.', (select id from public.categories where slug = 'nature'), 70, 'TA-FLOWER'),
  ('cola-drink', 'Cola Drink', 'A fizzy cola cup figure — pick your flavour, pick your colours.', (select id from public.categories where slug = 'food-drinks'), 70, 'TA-COLA-DRINK'),
  ('cute-whale', 'Cute Whale', 'A smiling little whale, ready to make a splash of colour.', (select id from public.categories where slug = 'ocean'), 70, 'TA-CUTE-WHALE'),
  ('bus', 'Bus', 'A cheerful little bus — every window a new colour stop.', (select id from public.categories where slug = 'everyday-objects'), 70, 'TA-BUS'),
  ('igloo-house', 'Small Igloo House', 'A cosy little igloo house, ready to be decorated your way.', (select id from public.categories where slug = 'everyday-objects'), 70, 'TA-IGLOO-HOUSE'),
  ('crab', 'Crab', 'A friendly little crab with claws full of creative ideas.', (select id from public.categories where slug = 'ocean'), 70, 'TA-CRAB')
on conflict (slug) do nothing;

-- ============================================================================
-- EMERGENCY DEACTIVATION (kill switch) — server-controlled site on/off state
-- ============================================================================
-- The public site reads this row (via the status API or, before the backend
-- is wired, the deployed site-status.json file). When deactivated=true, the
-- storefront renders a blank white page. This table NEVER deletes content:
-- products, orders, customers, and code are untouched by deactivation.
-- Recovery = setting deactivated=false again (recovery.html + admin API,
-- or the Supabase dashboard). Only is_admin() may change this row.

create table if not exists public.site_settings (
  id integer primary key default 1,
  deactivated boolean not null default false,
  reason text not null default '',
  deactivated_by text,
  deactivated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint site_settings_single_row check (id = 1)
);

insert into public.site_settings (id, deactivated, reason)
values (1, false, '')
on conflict (id) do nothing;

-- Super-admin-only toggle. Raises unless the caller passes is_super_admin().
create or replace function public.set_site_deactivated(
  p_deactivated boolean,
  p_reason text default ''
)
returns public.site_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.site_settings;
begin
  if not public.is_super_admin() then
    raise exception 'super admin access required';
  end if;

  update public.site_settings
     set deactivated = p_deactivated,
         reason = coalesce(p_reason, ''),
         deactivated_by = case when p_deactivated
           then coalesce(auth.jwt() ->> 'email', 'admin')
           else deactivated_by end,
         deactivated_at = case when p_deactivated then now() else deactivated_at end,
         updated_at = now()
   where id = 1
  returning * into v_row;

  return v_row;
end;
$$;

alter table public.site_settings enable row level security;

-- Everyone may READ the flag (the storefront needs it before sign-in).
create policy "site settings read" on public.site_settings
  for select using (true);
-- Only the SUPER ADMIN may change it (direct update or the function).
-- No direct insert/delete policies: the row is created by this migration.
create policy "site settings super admin update" on public.site_settings
  for update using (public.is_super_admin()) with check (public.is_super_admin());

-- ============================================================================
-- ADMIN PANEL (Phase 2b): audit log, access-attempt records, site config
-- ============================================================================
create table if not exists public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  action text not null, -- login | order_status | product_change | inventory_change | settings_change | site_deactivated | site_restored | code_gate_failed
  target_type text not null default '',
  target_id text not null default '',
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.access_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null, -- SHA-256 of the caller IP: no raw IPs stored
  success boolean not null,
  created_at timestamptz not null default now()
);

create table if not exists public.site_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.site_config (key, value) values
  ('whatsapp_number', '923098426672'),
  ('free_delivery_threshold', '2000'),
  ('currency', 'PKR')
on conflict (key) do nothing;

create index if not exists idx_audit_created on public.admin_audit_log (created_at desc);
create index if not exists idx_attempts_created on public.access_attempts (created_at desc);
create index if not exists idx_attempts_ip on public.access_attempts (ip_hash, created_at desc);

alter table public.admin_audit_log enable row level security;
alter table public.access_attempts enable row level security;
alter table public.site_config enable row level security;

-- Audit log: admins read and append; nothing updates or deletes history.
create policy "audit admin read" on public.admin_audit_log for select using (public.is_admin());
create policy "audit admin insert" on public.admin_audit_log for insert with check (public.is_admin());

-- Access attempts: written ONLY by the server function (service role, which
-- bypasses RLS). Only the super admin may read them.
create policy "attempts super admin read" on public.access_attempts for select using (public.is_super_admin());

-- Site config: everyone may read (the storefront needs it); only admins write.
-- Never store secrets in site_config: it is publicly readable by design.
create policy "config read" on public.site_config for select using (true);
create policy "config admin write" on public.site_config for all using (public.is_admin()) with check (public.is_admin());

-- RPC grants for browser access (PostgREST). RLS + the functions' own
-- allowlist checks still decide every call.
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_super_admin() to anon, authenticated;
grant execute on function public.create_order(jsonb, jsonb) to anon, authenticated;
grant execute on function public.set_site_deactivated(boolean, text) to anon, authenticated;

-- Product image storage: public bucket, admin-only writes.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;
create policy "product images public read" on storage.objects
  for select using (bucket_id = 'product-images');
create policy "product images admin write" on storage.objects
  for all using (bucket_id = 'product-images' and public.is_admin())
  with check (bucket_id = 'product-images' and public.is_admin());

-- ---------------------------------------------------------------------------
-- ALLOWLIST VERIFICATION (run signed in as each owner; see SETUP.md step 6)
--   select public.is_admin();        -- moosamahmood20002512@gmail.com -> must be true
--   select public.is_admin();        -- asadvendor0@gmail.com          -> must be true
--   select public.is_admin();        -- learnandlead36@gmail.com       -> must be true
--   select public.is_admin();        -- any other verified email       -> must be false
--   select public.is_super_admin();  -- moosamahmood20002512@gmail.com -> must be true
--   select public.is_super_admin();  -- other two admins               -> must be false
-- Do NOT remove any address from is_admin() without the owner's say-so.
-- ---------------------------------------------------------------------------
