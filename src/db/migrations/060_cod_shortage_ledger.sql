-- Approved cash-shortage write-offs post to the native ledger: debit "COD cash shortage written off", credit bank (the company makes the merchant whole from its own funds).
ALTER TABLE gl_accounts DROP CONSTRAINT gl_accounts_role_check;
ALTER TABLE gl_accounts ADD CONSTRAINT gl_accounts_role_check CHECK (role IN ('bank','ar','input_vat','ap','output_vat','revenue','cost','fx','cod_shortage'));
INSERT INTO gl_accounts(tenant_id,code,name,kind,role)
 SELECT s.tenant_id, '5910', 'COD cash shortage written off', 'expense', 'cod_shortage' FROM gl_settings s
  WHERE NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.tenant_id=s.tenant_id AND (a.code='5910' OR a.role='cod_shortage'));
