/**
 * "Add your private details": the things we deliberately do not ask for. A client's tax registration number, bank account, licence copies and
 * provider credentials are typed by the client into their own admin panel. This list teaches where, so the hand-off is complete without us
 * ever holding the details. Menu names are those of the standard build; a customised build lists any differences in its hand-off notes.
 */
export interface PrivateItem {
  code: string; title: string;
  /** what it is, concretely */
  what: string;
  /** where to type it in the delivered admin panel */
  where: string;
  steps: string[];
  /** only show for these sectors (undefined = everyone) */
  sectors?: string[];
  /** only show when the client asked for one of these features */
  features?: string[];
}

export const PRIVATE_ITEMS: PrivateItem[] = [
  { code: "tax-id", title: "Your tax registration number", what: "TRN, VAT or GST number printed on your invoices.",
    where: "Settings → Legal entity & finance",
    steps: ["Sign in to your admin panel as the owner.", "Open Settings, then the Legal entity & finance card.", "Type your legal name and your tax registration number exactly as on your certificate.", "Choose an invoice prefix (two to six letters), then Save.", "Create a test invoice and check the number prints where you expect."] },
  { code: "bank", title: "Bank details on your invoices", what: "The account customers pay into (account name, bank, IBAN).",
    where: "The bank-details block in your invoice layout",
    steps: ["Ask us for a bank-details block in your invoice layout when you register (it is part of the free customisation). We leave it empty.", "Open your invoice layout in the admin panel and fill the block yourself.", "Send yourself a test invoice and have your accountant check it."] },
  { code: "team", title: "Your team and their roles", what: "Everyone who will use the system, and what each person may do.",
    where: "Team",
    steps: ["Open Team.", "Invite each colleague by their own work email and choose their role.", "Each person sets their own password from the invitation link. Never share one login.", "Ask owners and finance users to turn on two-step sign-in under Account security."] },
  { code: "licences", title: "Licence and certificate copies", what: "Trade licence and any sector licences you want kept with your records.",
    where: "Documents",
    steps: ["Open Documents.", "Upload each file and give it a clear title (PDF, JPG or PNG).", "Keep originals with you: we do not need copies to build or hand over your system."] },
  { code: "accounting", title: "Your accounting connection", what: "The login that lets your system send invoices to your accounting software.",
    where: "Accounting connection", features: ["accounting-bridge"],
    steps: ["Open Accounting connection.", "Connect your own Zoho organisation using the instructions on that page.", "Map your currencies and tax codes with your accountant.", "Send one test invoice before turning it on for real."] },
  { code: "einvoice", title: "Your e-invoicing provider account", what: "Credentials from the accredited provider you have chosen.",
    where: "E-invoicing readiness", features: ["einvoice"],
    steps: ["Open E-invoicing readiness.", "Check the readiness list: it needs your tax registration number first.", "Enter the provider credentials they give you. We never see them.", "Send a test invoice in the provider's test mode."] },
  { code: "api-keys", title: "API keys for your merchants", what: "Keys your merchants' systems use to create orders and read status.",
    where: "API keys", sectors: ["courier-last-mile", "ecommerce-fulfilment", "contract-warehouse-3pl"], features: ["merchant-api"],
    steps: ["Open API keys.", "Create one key per merchant, with only the access they need.", "Copy the key once: it is shown a single time.", "Give it to the merchant over a channel you trust, never in a shared document."] },
  { code: "domain", title: "Your own web address", what: "A name such as track.yourcompany.com instead of the standard address.",
    where: "Settings → Domains",
    steps: ["Open Settings, then Domains.", "Enter the address and choose Request custom domain.", "Add the TXT record shown to your domain's DNS settings.", "Choose Verify once the record is live."] },
  { code: "security", title: "Your own sign-in security", what: "A strong password of your own and two-step sign-in.",
    where: "Account security",
    steps: ["Open Account security.", "Set up two-step sign-in with an authenticator app.", "Keep the recovery codes somewhere safe, away from the email account used to sign in."] },
];

export function privateItemsFor(sectors: string[], features: string[]): PrivateItem[] {
  return PRIVATE_ITEMS.filter((i) => (!i.sectors || i.sectors.some((s) => sectors.includes(s))) && (!i.features || i.features.some((f) => features.includes(f))));
}

/** The short list of things we will never ask you for, repeated wherever we collect information. */
export const NEVER_ASK = ["Tax registration number (TRN, VAT or GST)", "Bank account or IBAN", "Card numbers", "Passwords, codes and API keys"];
