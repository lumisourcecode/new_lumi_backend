import { pool } from "./client.js";

const migrationSql = `
create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table users add column if not exists is_super_admin boolean not null default false;
alter table users add column if not exists created_by uuid;

create table if not exists user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('rider','driver','partner','partner_employee','admin')),
  primary key (user_id, role)
);

create table if not exists refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists rider_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  full_name text,
  phone text,
  ndis_id text,
  created_at timestamptz not null default now()
);

create table if not exists driver_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  full_name text,
  phone text,
  vehicle_rego text,
  verification_status text not null default 'Pending',
  created_at timestamptz not null default now()
);

create table if not exists agent_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  org_name text,
  contact_name text,
  created_at timestamptz not null default now()
);

create table if not exists partner_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  org_name text,
  contact_name text,
  created_at timestamptz not null default now()
);

create table if not exists admin_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references users(id) on delete cascade,
  pickup text not null,
  dropoff text not null,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_lat double precision,
  dropoff_lng double precision,
  scheduled_at timestamptz not null,
  status text not null default 'pending_matching',
  created_at timestamptz not null default now()
);

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id) on delete cascade,
  driver_id uuid references users(id) on delete set null,
  state text not null default 'Assigned',
  created_at timestamptz not null default now()
);

create table if not exists driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references users(id) on delete cascade,
  doc_type text not null,
  status text not null default 'Pending',
  expiry date
);

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id) on delete set null,
  severity text not null default 'medium',
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id) on delete set null,
  sender_id uuid not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists driver_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  full_name text,
  phone text,
  vehicle_rego text,
  notes text,
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id)
);

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references users(id) on delete cascade,
  type text not null,
  payload jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists partner_clients (
  partner_id uuid not null references users(id) on delete cascade,
  rider_id uuid not null references users(id) on delete cascade,
  notes text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (partner_id, rider_id)
);

create table if not exists partner_travel_plans (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references users(id) on delete cascade,
  name text not null,
  target_group text,
  frequency text not null default 'Weekly',
  start_date date,
  end_date date,
  priority text not null default 'Medium',
  notes text,
  status text not null default 'Draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references users(id) on delete cascade,
  role text not null,
  issue_type text not null,
  reference_id text,
  priority text not null default 'Normal',
  message text not null,
  status text not null default 'Open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table bookings add column if not exists mobility_needs text;
alter table bookings add column if not exists notes text;
alter table bookings add column if not exists created_by uuid references users(id) on delete set null;
alter table bookings add column if not exists pickup_lat double precision;
alter table bookings add column if not exists pickup_lng double precision;
alter table bookings add column if not exists dropoff_lat double precision;
alter table bookings add column if not exists dropoff_lng double precision;
alter table trips add column if not exists assigned_at timestamptz;
alter table driver_profiles add column if not exists vehicle_make text;
alter table driver_profiles add column if not exists vehicle_color text;
alter table driver_profiles add column if not exists emergency_contact text;

alter table driver_documents add column if not exists admin_notes text;

alter table driver_profiles add column if not exists date_of_birth date;
alter table driver_profiles add column if not exists address_line1 text;
alter table driver_profiles add column if not exists suburb text;
alter table driver_profiles add column if not exists state text;
alter table driver_profiles add column if not exists postcode text;
alter table driver_profiles add column if not exists license_number text;

alter table driver_enrollments add column if not exists verification_stage text default 'profile';
alter table driver_enrollments add column if not exists admin_notes text;

create table if not exists driver_interest (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  email text not null,
  phone text,
  role_type text,
  suburb text,
  vehicle_info text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table users add column if not exists phone text;
alter table users add column if not exists google_id text;

alter table user_roles drop constraint if exists user_roles_role_check;
alter table user_roles add constraint user_roles_role_check check (role in ('rider','driver','partner','partner_employee','admin'));

update user_roles set role = 'partner' where role = 'agent';

insert into partner_profiles (user_id, org_name, contact_name, created_at)
select user_id, org_name, contact_name, created_at
from agent_profiles
on conflict (user_id) do update set
  org_name = coalesce(excluded.org_name, partner_profiles.org_name),
  contact_name = coalesce(excluded.contact_name, partner_profiles.contact_name);

create table if not exists phone_otps (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  portal text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table driver_profiles add column if not exists last_lat double precision;
alter table driver_profiles add column if not exists last_lng double precision;
alter table driver_profiles add column if not exists last_ping_at timestamptz;

alter table bookings add column if not exists vehicle_type_needed text default 'standard';
alter table bookings add column if not exists is_ndis boolean default false;

alter table trips add column if not exists estimated_cost numeric(12,2);
alter table trips add column if not exists final_cost numeric(12,2);
alter table trips add column if not exists currency text default 'AUD';
alter table trips add column if not exists ndis_support_item text;
alter table trips add column if not exists distance_km numeric(10,2);
alter table trips add column if not exists duration_minutes integer;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text unique not null,
  owner_id uuid not null references users(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  trip_id uuid references trips(id) on delete set null,
  issue_date date not null default current_date,
  due_date date,
  status text not null default 'draft' check (status in ('draft','sent','paid','cancelled','void')),
  total_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  currency text not null default 'AUD',
  pdf_url text,
  xero_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  description text not null,
  ndis_support_item text,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(12,2) not null,
  total_price numeric(12,2) not null,
  tax_rate numeric(5,2) not null default 0
);

create table if not exists partner_billing_settings (
  partner_id uuid primary key references users(id) on delete cascade,
  auto_invoice boolean not null default true,
  invoice_frequency text not null default 'immediate' check (invoice_frequency in ('immediate','weekly','monthly')),
  billing_email text,
  abn text,
  gst_registered boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table invoices add column if not exists partner_id uuid references users(id) on delete set null;

create table if not exists admin_smtp_settings (
  id int primary key default 1,
  host text,
  port int not null default 587,
  username text,
  password text,
  from_name text,
  from_email text,
  secure_mode text not null default 'tls' check (secure_mode in ('tls','ssl','none')),
  is_active boolean not null default true,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  last_tested_at timestamptz,
  last_test_result text
);
alter table admin_smtp_settings drop constraint if exists admin_smtp_settings_singleton;
alter table admin_smtp_settings add constraint admin_smtp_settings_singleton check (id = 1);

create table if not exists partner_tenant_settings (
  partner_id uuid primary key references users(id) on delete cascade,
  tenant_slug text unique,
  brand_name text,
  logo_url text,
  support_email text,
  support_phone text,
  smtp_host text,
  smtp_port int not null default 587,
  smtp_username text,
  smtp_password text,
  smtp_from_email text,
  smtp_from_name text,
  smtp_secure_mode text not null default 'tls' check (smtp_secure_mode in ('tls','ssl','none')),
  smtp_enabled boolean not null default false,
  mail_template text,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists partner_employees (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references users(id) on delete cascade,
  employee_user_id uuid not null references users(id) on delete cascade,
  title text,
  permissions jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('invited','active','disabled')),
  invited_at timestamptz,
  invited_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(partner_id, employee_user_id)
);

create table if not exists admin_permission_matrix (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('admin','partner','partner_employee','driver','rider')),
  entity text not null,
  can_create boolean not null default true,
  can_read boolean not null default true,
  can_update boolean not null default true,
  can_delete boolean not null default false,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique(role, entity)
);
`;

export async function runMigrations() {
  await pool.query(migrationSql);
}

