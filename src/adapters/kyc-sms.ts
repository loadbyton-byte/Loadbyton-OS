import { decryptSecret } from "../lib/encryption.js";
import type { OutboxHandlers } from "../platform/outbox.js";
import { defaultSms, type SmsSender } from "./delivery-notify.js";

/** Sends the one-time mobile-confirmation code queued by company verification. The code is stored encrypted in the queue and appears in no log. */
export function kycSmsHandlers(sms: SmsSender = defaultSms()): OutboxHandlers {
  return {
    async "kyc.sms"(row) {
      const p = row.payload ?? {};
      if (!p.phoneEncrypted || !p.codeEncrypted) throw new Error("kyc sms payload is incomplete");
      const r = await sms.send(decryptSecret(p.phoneEncrypted), `LOAD|BY|TON verification code: ${decryptSecret(p.codeEncrypted)}. It expires in 10 minutes. Do not share it.`);
      return { externalId: r.id };
    },
  };
}
