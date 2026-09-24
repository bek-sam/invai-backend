ALTER POLICY "gang_sheets_vendor_read" ON "gang_sheets" TO invai_app USING (gang_sheets.id in (select va.gang_sheet_id from vendor_access va where va.company_id = gang_sheets.company_id and va.vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and va.revoked_at is null));--> statement-breakpoint
ALTER POLICY "gang_sheets_vendor_update" ON "gang_sheets" TO invai_app USING (gang_sheets.id in (select va.gang_sheet_id from vendor_access va where va.company_id = gang_sheets.company_id and va.vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and va.revoked_at is null)) WITH CHECK (gang_sheets.id in (select va.gang_sheet_id from vendor_access va where va.company_id = gang_sheets.company_id and va.vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and va.revoked_at is null));--> statement-breakpoint
ALTER POLICY "transfers_vendor_read" ON "transfers" TO invai_app USING (transfers.gang_sheet_id in (select va.gang_sheet_id from vendor_access va where va.company_id = transfers.company_id and va.vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and va.revoked_at is null));--> statement-breakpoint
-- Permissive policies are OR'ed: in a vendor session app.company_id is the vendor, so the tenant
-- policy's WITH CHECK would let a vendor rewrite a shared sheet's company_id to its own. A sheet
-- never changes owner.
CREATE OR REPLACE FUNCTION company_id_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'company_id of % cannot change', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS gang_sheets_company_id_immutable ON gang_sheets;--> statement-breakpoint
CREATE TRIGGER gang_sheets_company_id_immutable BEFORE UPDATE OF company_id ON gang_sheets FOR EACH ROW EXECUTE FUNCTION company_id_immutable();
