-- Per-merchant opt-in for WhatsApp delivery notices (the merchant, as data controller, has its consignees' consent; sent only as pre-approved templates).
ALTER TABLE dlv_merchant_settings ADD COLUMN notify_whatsapp boolean NOT NULL DEFAULT false;
