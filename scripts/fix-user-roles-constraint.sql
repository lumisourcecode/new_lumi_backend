-- Run once on production when db:init fails with:
--   check constraint "user_roles_role_check" ... violated (23514)
-- No git required — copy this file to the server or paste into psql.
--
-- EC2 / docker-compose (container lumi-ride-backend_postgres_1):
--   cd /var/www/lumi-ride-backend
--   docker exec -i lumi-ride-backend_postgres_1 psql -U postgres -d lumi_backend < scripts/fix-user-roles-constraint.sql
-- If authentication fails, use the password from .env DB_PASSWORD (compose default is postgres):
--   docker exec -i -e PGPASSWORD=postgres lumi-ride-backend_postgres_1 psql -U postgres -d lumi_backend < scripts/fix-user-roles-constraint.sql

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;

-- Trim / lower so values like 'Rider ' or hidden whitespace still match the CHECK below.
UPDATE user_roles SET role = trim(role) WHERE role IS NOT NULL AND role <> trim(role);
UPDATE user_roles SET role = lower(role) WHERE role IS NOT NULL AND role <> lower(role);
UPDATE user_roles SET role = 'partner' WHERE role = 'agent';
UPDATE user_roles SET role = 'partner' WHERE role IS NULL OR role = '';
UPDATE user_roles SET role = 'partner' WHERE role NOT IN ('rider', 'driver', 'partner', 'partner_employee', 'admin');

ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('rider', 'driver', 'partner', 'partner_employee', 'admin'));
