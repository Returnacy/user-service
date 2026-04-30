-- Phase 2.4 — local password verification support
--
-- Adds three nullable columns to User. Existing rows get NULL; nothing else
-- is touched. PostgreSQL handles ADD COLUMN with no default as a metadata-only
-- change, instantaneous even on large tables.
--
-- Generated via:
--   prisma migrate diff --from-url <prod> --to-schema-datamodel schema.prisma --script
--
-- Applied to production at Phase 2.6 cutover. Rollback (if ever needed):
--   ALTER TABLE "User" DROP COLUMN "passwordHash";
--   ALTER TABLE "User" DROP COLUMN "passwordAlgorithm";
--   ALTER TABLE "User" DROP COLUMN "passwordUpdatedAt";

ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordAlgorithm" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordUpdatedAt" TIMESTAMP(3);
