-- Run once on production when db:init fails with:
--   check constraint "user_roles_role_check" ... violated (23514)
-- No git required — copy this file to the server or paste into psql.
--
-- Usage (pick one):
--   docker exec -i CONTAINER_NAME psql -U postgres -d lumi_backend < scripts/fix-user-roles-constraint.sql
--   psql "postgresql://USER:PASS@HOST:5432/lumi_backend" -f scripts/fix-user-roles-constraint.sql

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;

UPDATE user_roles SET role = 'partner' WHERE role = 'agent';
UPDATE user_roles SET role = 'partner' WHERE role NOT IN ('rider', 'driver', 'partner', 'partner_employee', 'admin');

ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('rider', 'driver', 'partner', 'partner_employee', 'admin'));
