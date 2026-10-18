import { config } from "../config.js";
import { INTEGRATIONS, PRODUCTS, SECTORS, type PlanVersion } from "./catalog.js";
import { fmtMoney } from "../lib/util.js";

/**
 * The website assistant's knowledge. It is a retrieval assistant, not a generative model: every answer is written text drawn from the
 * product catalogue (plans, sectors, products, integrations come from the same source as the public pages) plus the entries below.
 * It never invents prices or capabilities; when nothing matches well it says so and offers a person.
 */
export interface Entry { id: string; title: string; keys: string[]; text: string; links?: [string, string][]; follow?: string[] }
export interface Reply { answer: string; links: [string, string][]; suggestions: string[]; handoff: boolean; entry?: string; score: number }

const STOP = new Set("a an and are as at be but by can do does for from get got had has have how i if in into is it its me my of on or our so that the their them then there these they this to too us was we were what when where which who why will with would you your please tell about want need know like just also any some more much many other".split(" "));
const SYN: Record<string, string> = { cost: "price", costs: "price", pricing: "price", prices: "price", fee: "price", fees: "price", charge: "price", charges: "price", cheap: "price", cheaper: "price", afford: "price", affordable: "price", expensive: "price", rate: "price", plan: "plan", plans: "plan", tier: "plan", package: "plan", subscription: "plan", pay: "payment", paying: "payment", checkout: "payment", card: "payment", invoice: "invoice", invoicing: "invoice", bill: "invoice", billing: "invoice", gst: "gst", udyam: "udyam", msme: "udyam", safe: "security", secure: "security", safety: "security", privacy: "privacy", private: "privacy", hack: "security", encrypt: "security", encrypted: "security", mfa: "mfa", "2fa": "mfa", otp: "mfa", arabic: "arabic", rtl: "arabic", language: "arabic", whatsapp: "whatsapp", wa: "whatsapp", phone: "phone", call: "phone", mobile: "phone", number: "phone", email: "email", mail: "email", mailbox: "email", human: "human", person: "human", agent: "human", staff: "human", representative: "human", demo: "demo", walkthrough: "demo", trial: "demo", try: "demo", sample: "demo", driver: "driver", drivers: "driver", rider: "driver", riders: "driver", offline: "offline", app: "app", aws: "aws", amazon: "aws", cloud: "hosting", hosting: "hosting", hosted: "hosting", server: "hosting", region: "hosting", location: "hosting", dubai: "uae", emirates: "uae", uae: "uae", india: "india", indian: "india", competitor: "compare", competitors: "compare", compare: "compare", comparison: "compare", versus: "compare", vs: "compare", alternative: "compare", zoho: "zoho", tally: "accounting", quickbooks: "accounting", accounting: "accounting", books: "accounting", ledger: "accounting", erp: "accounting", customs: "customs", clearance: "customs", broker: "customs", declaration: "customs", einvoice: "einvoice", "e-invoice": "einvoice", einvoicing: "einvoice", fta: "einvoice", cancel: "cancel", cancellation: "cancel", downgrade: "cancel", refund: "cancel", export: "export", leave: "export", delete: "delete", erase: "delete", erasure: "delete", import: "import", migrate: "import", migration: "import", csv: "import", spreadsheet: "import", excel: "import", offer: "offer", discount: "offer", promo: "offer", coupon: "offer", deal: "offer", api: "api", webhook: "api", webhooks: "api", integration: "integration", integrations: "integration", connect: "integration", support: "support", help: "support", hours: "hours", timing: "hours", open: "hours", available: "hours", team: "team", user: "team", users: "team", seats: "team", seat: "team", staff2: "team", forwarder: "freight", forwarding: "freight", freight: "freight", shipment: "freight", shipments: "freight", cargo: "freight", truck: "transport", trucks: "transport", fleet: "transport", trip: "transport", trips: "transport", dispatch: "transport", warehouse: "warehouse", warehousing: "warehouse", "3pl": "warehouse", stock: "warehouse", inventory: "warehouse", fulfilment: "fulfilment", fulfillment: "fulfilment", ecommerce: "fulfilment", courier: "delivery", parcel: "delivery", parcels: "delivery", cod: "delivery", delivery: "delivery", margin: "margin", profit: "margin", profitability: "margin", dashboard: "dashboard", report: "dashboard", reports: "dashboard", analytics: "dashboard", ai: "ai", assistant: "ai", gpt: "ai", llm: "ai", who: "about", founder: "about", founders: "about", company: "about", subsidiary: "about", parent: "about", built: "about", builders: "about", freelancer: "about", freelancers: "about" };

const stem = (w: string) => w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w.replace(/s$/, "");
export const tokens = (q: string): string[] =>
  q.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+؀-ۿ -]/g, " ").split(/\s+/).filter(Boolean)
    .filter((w) => !STOP.has(w)).map((w) => SYN[w] ?? stem(w)).map((w) => SYN[w] ?? w);

const money = (v: number) => fmtMoney(v).replace(/\.00$/, "");
const phone = () => config.contact.phone;
const mail = config.contact.emails;
const hours = () => `${String(config.contact.chatFromHour).padStart(2, "0")}:00 to ${String(config.contact.chatToHour).padStart(2, "0")}:00 (${config.contact.chatTz})`;

export function buildKnowledge(plans: PlanVersion[]): Entry[] {
  const planBy = (c: string) => plans.find((p) => p.plan_code === c);
  const free = planBy("free"), starter = planBy("starter"), business = planBy("business"), ops = planBy("operations"), ent = planBy("enterprise");
  const L = (p?: PlanVersion) => p ? `${p.limits.max_users} users, ${p.limits.max_branches} branch${p.limits.max_branches > 1 ? "es" : ""}, ${p.limits.jobs_per_month.toLocaleString("en")} jobs a month, ${p.limits.storage_mb >= 1024 ? p.limits.storage_mb / 1024 + " GB" : p.limits.storage_mb + " MB"} of documents, ${p.limits.max_sectors} sector${p.limits.max_sectors > 1 ? "s" : ""}` : "";
  const planLine = (p?: PlanVersion) => p ? `${p.name}: ${p.contact_sales ? "from " : ""}${money(p.monthly_minor)} a month${p.setup_minor ? ` plus ${money(p.setup_minor)} one-off setup` : p.contact_sales ? ", scoped setup" : ", no setup fee"}. Includes ${L(p)}.` : "";
  const E: Entry[] = [
    { id: "what", title: "What LOAD|BY|TON.store is", keys: ["what", "platform", "software", "product", "os", "operating", "system", "overview", "about", "store", "loadbyton"],
      text: "LOAD|BY|TON.store is logistics operating software. One workspace holds your enquiries, quotes, jobs, trips, stock, parcels, documents, invoices and collections, so you can see what each movement actually earned. It has seven products on one shared core, eighteen sector packs, an offline driver app, customer portals and an owner dashboard. It starts free.",
      links: [["See the platform", "/features"], ["Explore sectors", "/sectors"]], follow: ["How much does it cost?", "Which sectors do you cover?", "Is it secure?"] },
    { id: "who", title: "Who it is for", keys: ["suit", "fit", "logistics", "forwarders", "size", "small", "industry", "industries", "target", "audience"],
      text: "It is for logistics companies: freight forwarders, transport and fleet operators, warehouse and 3PL teams, e-commerce fulfilment, couriers and last-mile, customs brokers, trading companies and movers. If you coordinate cargo and send invoices, it fits. Most customers are small and mid-size teams in the UAE.",
      links: [["Industries", "/industries"], ["Find my bundle", "/find-my-bundle"]] },
    { id: "start", title: "How to get started", keys: ["start", "begin", "signup", "sign", "register", "create", "account", "workspace", "onboard", "setup", "set", "up", "join"],
      text: "Create a free workspace at /start. It takes a couple of minutes: company name, your name, email, a password and the sectors you operate in. You get a real, empty workspace on the permanent Free plan and a short checklist (add a customer, a supplier, a real enquiry, a quote). No trade documents are needed to explore.",
      links: [["Start free", "/start"]], follow: ["What does the Free plan include?", "Can I import my customers?"] },
    { id: "free", title: "Free plan", keys: ["free", "forever", "no", "cost", "limit", "permanent"],
      text: `The Free plan is permanent and really free. ${free ? L(free) + "." : ""} Your workspace starts empty, we never add sample data. Export in CSV and JSON is included. Upgrade when you need more people, jobs, storage or sectors.`,
      links: [["See all plans", "/pricing"]] },
    { id: "pricing", title: "Pricing overview", keys: ["price", "plan", "payment", "how", "much", "monthly", "month", "aed", "dirham", "cheap", "afford"],
      text: ["Plans, in AED per month (excluding VAT):", ...plans.map(planLine)].join("\n"),
      links: [["Pricing and comparison", "/pricing"]], follow: ["What is the difference between plans?", "Is there a setup fee?", "Do you have any offers?"] },
    ...(["starter", "business", "operations", "enterprise"] as const).map((c) => ({ id: `plan-${c}`, title: `${c} plan`, keys: [c, "plan", "price", "include", "limit"], text: planLine(planBy(c)) + (c === "enterprise" ? " Talk to us for a scoped schedule." : ""), links: [["Pricing", "/pricing"]] as [string, string][] })),
    { id: "setup-fee", title: "Setup fee", keys: ["setup", "implementation", "onboarding", "fee", "one-off", "price"],
      text: `Paid plans have a stated one-off setup fee (${starter ? "Starter " + money(starter.setup_minor) : ""}${business ? ", Business " + money(business.setup_minor) : ""}${ops ? ", Operations " + money(ops.setup_minor) : ""}). Setup covers entity and branding, templates, inviting your team, an initial customer import, one remote training session and an acceptance checklist. The Free plan has no setup fee. Enterprise setup is scoped.`,
      links: [["Pricing", "/pricing"]] },
    { id: "cheaper", title: "Why it costs less than other vendors", keys: ["compare", "price", "cheaper", "vendor", "uae", "competitor", "expensive", "big", "why", "low", "less"],
      text: "It is built and supported by the LOAD|BY|TON team in the UAE, with AI-native tooling and no field sales force or inflated implementation fee. Prices are published and in AED. We will not quote other vendors' prices, because we cannot verify them, but you can compare our plan limits and setup fees on the pricing page line by line.",
      links: [["Pricing", "/pricing"], ["About us", "/about"]] },
    { id: "payment", title: "How payment works", keys: ["payment", "pay", "card", "checkout", "stripe", "razorpay", "google", "invoice", "method", "upi"],
      text: "Upgrades are paid through hosted checkout (Stripe, by card and eligible Apple Pay and Google Pay methods; other UAE providers can be added). Access is granted only after the payment provider's verified server event, never from a browser redirect. We hold no customer funds and have no escrow.",
      links: [["How activation works", "/how-activation-works"]] },
    { id: "vat-gst", title: "VAT", keys: ["vat", "tax", "trn", "invoice", "registered", "registration"],
      text: `Prices exclude applicable tax. The default UAE VAT rate in the checkout is ${(config.vatBps / 100).toFixed(0)}% and the checkout shows the exact tax treatment before you pay. LOAD|BY|TON.store is operated by the same UAE company as loadbyton.com, and invoices carry the seller's UAE tax registration number (TRN) once it is VAT-registered. For tax questions about your own position, please ask your accountant.`,
      links: [["Compliance notes", "/compliance"]] },
    { id: "activation", title: "How long activation takes", keys: ["activation", "activate", "how", "long", "ready", "hours", "time", "provision", "after", "upgrade"],
      text: "After a verified payment and your legal entity name, our standard branded activation target is within 24 hours. That is a target, not a guarantee. Custom domains, historical migration and provider approvals have their own milestones. Your free workspace is reused, so nothing is recreated or lost.",
      links: [["How activation works", "/how-activation-works"]] },
    { id: "cancel", title: "Cancelling or downgrading", keys: ["cancel", "downgrade", "refund", "stop", "end", "subscription", "renew", "leave"],
      text: "Downgrades apply at renewal, after a preview of what changes. Cancelling keeps the access you paid for until the period ends, and a published grace period comes before any restriction. Exceeding a limit blocks new excess records, never reading or exporting what you already have. For refunds, message us and we will look at your case.",
      links: [["Terms", "/legal/terms"]] },
    { id: "limits", title: "What happens at a limit", keys: ["limit", "exceed", "over", "quota", "allowance", "job", "jobs", "unit", "meter"],
      text: "Each sector has its own billing unit: a forwarding job, a transport trip, a delivery parcel, a warehouse order. If you reach an allowance, new records of that type are blocked until you upgrade or the month rolls over. You can always read and export existing records.",
      links: [["How limits work", "/pricing"]] },
    { id: "export", title: "Exporting data and leaving", keys: ["export", "leave", "data", "own", "portable", "csv", "json", "backup", "exit", "lock"],
      text: "Your data is yours. CSV and JSON export is on every plan, including after a downgrade or cancellation. Settings → Export gives you the lot, so you are never locked in.",
      links: [["Trust and safety", "/trust"]] },
    { id: "delete", title: "Data deletion and retention", keys: ["delete", "erase", "retention", "gdpr", "pdpl", "privacy", "request", "remove", "forget"],
      text: `Owners can submit access, correction and deletion requests under Your data. Deletions are reviewed against statutory retention and legal holds before erasure. The deployment retention schedule is ${config.retentionDays} days after the applicable exit milestone. The legal pages are listed in the footer.`,
      links: [["Privacy notice", "/legal/privacy"], ["Data processing", "/legal/data-processing"]] },
    { id: "security", title: "Security", keys: ["security", "secure", "safe", "isolation", "tenant", "encrypt", "protect", "audit", "access", "role", "permission", "hack", "breach", "data", "trust", "confidential"],
      text: "Each company's records are isolated by the database itself (row-level security), and the tenant comes from your authenticated membership, never from a field the browser sends. People have individual accounts and roles, files are private with short-lived signed links, sensitive steps need a second person's approval, and every important change is in an append-only audit trail. This is a description of design controls, not a certification.",
      links: [["Security", "/security"], ["Trust and safety", "/trust"]] },
    { id: "mfa", title: "Multi-factor sign-in", keys: ["mfa", "2fa", "authenticator", "otp", "totp", "login", "password", "sign", "reset", "forgot"],
      text: "Company accounts support authenticator-app MFA (and it is required for sensitive roles in production). Platform staff always use MFA. If you forgot your password, use Forgot password on the sign-in page: the link works once and expires in one hour.",
      links: [["Sign in", "/login"], ["Reset password", "/forgot-password"]] },
    { id: "hosting", title: "Where it is hosted", keys: ["hosting", "region", "server", "location", "aws", "cloud", "centre", "center", "residency", "where", "hosted"],
      text: `Current deployment region: ${config.deploymentRegion}. The platform is deployed on cloud infrastructure with a managed PostgreSQL database, private object storage and encrypted backups; the exact providers and regions are on the subprocessors page. UAE data-residency needs are a deployment decision we are happy to discuss before you sign.`,
      links: [["Subprocessors", "/legal/subprocessors"], ["Compliance", "/compliance"]] },
    { id: "arabic", title: "Arabic and languages", keys: ["arabic", "language", "rtl", "translate", "english", "bilingual", "urdu", "hindi"],
      text: "The interface is available in English and Arabic with right-to-left layout (use the language links in your account menu). Invoices and customer-facing documents have a bilingual layout. Arabic copy should be reviewed natively before you publish it to customers.",
      links: [["Features", "/features"]] },
    { id: "driver", title: "Driver and rider app", keys: ["driver", "rider", "app", "mobile", "phone", "offline", "pod", "proof", "signature", "android", "ios", "iphone"],
      text: "Drivers and riders use a phone-first web app: today's trips or runs, big buttons, proof of delivery with a signature, failed attempts and expenses. If the signal drops, actions wait in a local queue and sync when it returns; every action has its own id so a retry never creates a duplicate. It installs to the home screen on Android and iPhone.",
      links: [["For transport and fleets", "/for-transporters"]] },
    { id: "portal", title: "Customer portal", keys: ["portal", "customer", "client", "merchant", "track", "tracking", "visibility", "shipper"],
      text: "Your customers and merchants can have limited portal logins. They see only their own shipments, issued documents, invoices and (for fulfilment and warehouse) their own stock. Delivery parcels also have a public tracking link.",
      links: [["Features", "/features"]] },
    { id: "api", title: "API and webhooks", keys: ["api", "webhook", "integration", "connect", "automate", "shopify", "key", "rest", "developer"],
      text: "Delivery and fulfilment customers can use scoped API keys and signed webhooks to push parcels and orders in, and to be told about status changes. Writes are idempotent. Marketplace and carrier-label connectors are planned, not available yet.",
      links: [["Integrations", "/integrations"]] },
    { id: "integrations", title: "Integrations and accounting", keys: ["integration", "accounting", "zoho", "tally", "quickbooks", "books", "erp", "connect", "sync", "bank", "feed"],
      text: ["Integration status, stated plainly:", ...INTEGRATIONS.map((i) => `• ${i.name}: ${i.status}`)].join("\n") + "\nCSV export of invoices is always available.",
      links: [["Integrations and status", "/integrations"]] },
    { id: "einvoice", title: "UAE e-invoicing", keys: ["einvoice", "e-invoice", "fta", "peppol", "asp", "accredited", "electronic", "mandatory", "tax"],
      text: "LOAD|BY|TON is not an accredited UAE e-invoicing service provider. Operational invoices can be reconciled with the system or provider you already use, and an adapter for a verified provider is on the roadmap. We would rather say that than overpromise.",
      links: [["Integrations", "/integrations"]] },
    { id: "customs", title: "Customs", keys: ["customs", "clearance", "declaration", "broker", "mirsal", "dubai", "trade", "filing", "hs", "code", "duty"],
      text: "The Customs product manages cases: goods lines (HS codes format-checked), an evidence checklist, a second-person approval, deposits and guarantees, inspections, queries and a printable handover pack. It does not file anything. Lodging is done by your licensed broker in Dubai Trade or Mirsal 2.",
      links: [["Customs sector", "/sectors/customs-brokerage"]] },
    { id: "margin", title: "Margin and the owner dashboard", keys: ["margin", "profit", "dashboard", "report", "owner", "unbilled", "overdue", "kpi", "earn", "cost"],
      text: "The owner dashboard shows expected, estimated and reconciled margin separately, unbilled delivered jobs, overdue receivables, supplier exposure, exceptions and delayed milestones. Every figure links to the records behind it, and costs not yet reconciled are marked as estimates, never presented as final books.",
      links: [["Features", "/features"]] },
    { id: "documents", title: "Documents", keys: ["document", "documents", "pod", "bill", "lading", "awb", "packing", "template", "draft", "print", "pdf", "invoice", "evidence"],
      text: "Documents attach to the job. There are versioned, source-linked drafts, holds, uploads with malware scanning when configured, proof of delivery, and bilingual (Arabic and English) invoices. Each version is kept.",
      links: [["Features", "/features"]] },
    { id: "roles", title: "Team and roles", keys: ["team", "role", "user", "permission", "owner", "seat", "invite", "member", "staff", "access", "approve", "approval"],
      text: "Invite colleagues by email; each gets an individual account. Roles include owner, sales, pricing, coordinator, dispatcher, warehouse, finance, HR, auditor and portal. Sensitive actions (cash recovery, stock adjustments, expense receipts, customs handover) need a second person to approve.",
      links: [["Trust and safety", "/trust"]] },
    { id: "ai", title: "AI features", keys: ["ai", "assistant", "gpt", "llm", "chatgpt", "automation", "automate", "machine", "draft"],
      text: "The workspace has scoped assistant drafts: suggested enquiry replies and document text that a person must review before anything is sent. Drafts use only the fields you allow and have a monthly allowance by plan. The assistant never sends or posts on its own. (This chat on the website is a separate help assistant that answers from our own product information.)",
      links: [["Features", "/features"]] },
    { id: "import", title: "Importing your data", keys: ["import", "migrate", "migration", "csv", "spreadsheet", "excel", "customers", "upload", "existing", "move"],
      text: "Customers, suppliers, SKUs and parcels can be imported from CSV, with a preview and a rollback for controlled customer migrations. Paid setup includes an initial customer import. Large historical migrations are scoped separately.",
      links: [["Pricing and setup", "/pricing"]] },
    { id: "demo", title: "Demo and trial", keys: ["demo", "trial", "try", "sample", "walkthrough", "preview", "test", "see", "show"],
      text: "The fastest way to try it is the Free plan: a real workspace, no card. For a guided walkthrough, message us on WhatsApp or open the live chat and we will show you the workflow for your sector. Any sample data lives in a separate demo environment, never mixed with real workspaces.",
      links: [["Start free", "/start"]], follow: ["Talk to a person"] },
    { id: "offer", title: "Current offer", keys: ["offer", "discount", "promo", "coupon", "deal", "code", "special", "launch"],
      text: "Check the banner at the top of the site for the current offer and its end date. If you start a workspace through the offer link we will note it on your account and arrange the onboarding call. Tell us in chat what you need and we will see what we can do.",
      links: [["Start free", "/start"]] },
    { id: "support", title: "Support and contact", keys: ["support", "help", "contact", "reach", "phone", "whatsapp", "email", "mail", "call", "hours", "address"],
      text: `You can reach us by WhatsApp or phone on ${phone()}, and by email: ${mail.contact} (sales and enquiries), ${mail.support} (support), ${mail.info} (general). The live chat is staffed ${hours()}; outside those hours leave a message and we reply next working morning.`,
      links: [["Contact page", "/contact"], ["WhatsApp", `https://wa.me/${phone().replace(/\D/g, "")}`]] },
    { id: "about", title: "About the company", keys: ["about", "built", "made", "created", "company", "founder", "team", "group", "story", "behind", "who", "owner", "entity"],
      text: "LOAD|BY|TON.store is the business-software arm of LOAD|BY|TON, the UAE road freight and container drayage platform, and is operated by the same UAE-registered company. We keep the team small so prices stay fair and you talk to the people who wrote the code.",
      links: [["About", "/about"]] },
    { id: "parent", title: "The parent LOAD|BY|TON", keys: ["parent", "drayage", "marketplace", "bid", "carrier", "shipper", "project", "loadbyton", "freight", "road", "container"],
      text: "LOAD|BY|TON is a UAE road freight and container drayage platform: shippers post jobs, verified carriers bid, the shipper awards one, and the job is tracked to proof of delivery with payment protection, ratings and dispute handling. LOAD|BY|TON.store is the separate software product for logistics companies themselves.",
      links: [["About", "/about"]] },
    { id: "status", title: "Service status", keys: ["status", "down", "outage", "uptime", "available", "working", "slow", "incident"],
      text: "Live component status is on the status page. Our targets (99.9% monthly availability, recovery objectives) are engineering objectives, not present guarantees.",
      links: [["Service status", "/status"]] },
    { id: "legal", title: "Legal documents", keys: ["terms", "legal", "contract", "privacy", "dpa", "processing", "subprocessor", "sla", "agreement", "policy"],
      text: "Terms of service, Privacy notice, Data processing, Subprocessors and Accessibility are linked in the footer. They are marked as draft until reviewed by the contracting entity's adviser; ask us for the current versions before you sign anything.",
      links: [["Terms", "/legal/terms"], ["Privacy", "/legal/privacy"]] },
    { id: "sectors", title: "Sector packs", keys: ["sector", "sectors", "pack", "packs", "industry", "cover", "support", "types", "all"],
      text: `There are ${SECTORS.length} sector packs: ${SECTORS.map((s) => s.name).join(", ")}. You can combine them in one company account; Free includes one.`,
      links: [["All sectors", "/sectors"], ["Find my bundle", "/find-my-bundle"]] },
    { id: "products", title: "Products", keys: ["product", "products", "modules", "module", "features", "feature"],
      text: `Seven products share one core: ${PRODUCTS.map((p) => p.name.replace("LOAD|BY|TON ", "")).join(", ")}.`,
      links: [["Products", "/products"], ["Features", "/features"]] },
    { id: "bundle", title: "Choosing a bundle", keys: ["bundle", "recommend", "choose", "which", "plan", "right", "fit", "combine", "multiple"],
      text: "Pick your sectors in Find my bundle and it recommends a plan and shows the net price; shared CRM, finance and documents are included once, never charged twice.",
      links: [["Find my bundle", "/find-my-bundle"]] },
    { id: "not-built", title: "What is not available", keys: ["marketplace", "escrow", "sso", "saml", "scim", "gps", "route", "optimisation", "optimization", "label", "barcode", "rf", "hardware", "native", "not"],
      text: "Not available today: public carrier bidding and escrow settlement, SAML SSO and SCIM, live GPS fleet tracking and route optimisation as a turnkey feature, marketplace and carrier-label connectors, barcode/RF hardware workflows, and an accredited e-invoicing connection. Planned items are labelled planned on the site.",
      links: [["Integrations", "/integrations"], ["Enterprise controls", "/enterprise"]] },
    { id: "uptime-backup", title: "Backups and continuity", keys: ["backup", "restore", "recovery", "disaster", "continuity", "uptime", "monitor", "rpo", "rto"],
      text: "Encrypted database-plus-file backups and isolated restore verification are built in, along with health and readiness endpoints. The target recovery objectives are RPO of an hour and RTO of eight hours on the shared platform; they are targets until the deployment has proven them.",
      links: [["Trust and safety", "/trust"]] },
    { id: "transport", title: "Transport product", keys: ["transport", "trip", "fleet", "dispatch", "vehicle", "detention", "subcontract", "truck", "trailer", "plan"],
      text: "Transport covers orders, trip planning with capacity, availability and compliance checks, dispatch to the driver app, expenses with receipts and independent approval, detention, subcontracting and trip profitability.",
      links: [["For transport and fleets", "/for-transporters"], ["Road transport sector", "/sectors/road-transport"]] },
    { id: "forwarding", title: "Freight forwarding product", keys: ["forwarding", "forwarder", "freight", "enquiry", "quote", "quotation", "job", "shipment", "supplier", "rate", "booking"],
      text: "Forwarding runs enquiry → quote (supplier rates, chargeable-weight rules, margin check and approval) → job (legs, bookings, milestones) → supplier costs → documents → invoice → collection, with master/house shipments, tenders and contracts for the harder cases.",
      links: [["For freight forwarders", "/for-forwarders"], ["Freight forwarding sector", "/sectors/freight-forwarding"]] },
    { id: "warehouse", title: "Warehouse and fulfilment", keys: ["warehouse", "3pl", "stock", "inventory", "fulfilment", "sku", "pick", "pack", "ship", "returns", "count", "lot", "expiry", "serial"],
      text: "Warehouse covers owner-separated custody stock on an immutable movement ledger, receiving with variances and quarantine, FIFO allocation, blind counts with independent approval and activity billing. Fulfilment adds merchant SKUs, reservation, pick, scan-verified pack, ship, returns and counts.",
      links: [["Warehouse sector", "/sectors/contract-warehouse-3pl"], ["E-commerce fulfilment", "/sectors/ecommerce-fulfilment"]] },
    { id: "delivery", title: "Delivery and cash on delivery", keys: ["delivery", "courier", "parcel", "cod", "cash", "rider", "last", "mile", "remittance", "runs", "label"],
      text: "Delivery covers merchant parcels (form or CSV), printable labels, delivery runs, a rider phone app with proof of delivery and failed attempts, exact-cash COD collection, rider cash handover with independent variance approval, merchant remittance with fees netted, and rate-card billing.",
      links: [["Courier / last mile", "/sectors/courier-last-mile"]] },
    { id: "thanks", title: "Thanks", keys: ["thanks", "thank", "great", "cool", "ok", "okay", "perfect", "nice", "awesome"], text: "You are welcome. Is there anything else you would like to know?" },
    { id: "hello", title: "Greeting", keys: ["hello", "hi", "hey", "salaam", "assalam", "namaste", "morning", "afternoon", "evening"], text: "Hello! I can answer questions about the platform, pricing, sectors, security and how to get started. What would you like to know?", follow: ["What is LOAD|BY|TON.store?", "How much does it cost?", "Talk to a person"] },
  ];
  // one entry per sector, generated from the live catalogue so the assistant never drifts from the sector pages
  for (const s of SECTORS) E.push({ id: `sector-${s.slug}`, title: s.name, keys: [...s.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2), s.slug, "sector", "pack", "support", "cover"],
    text: `${s.name} (${s.availability}): ${s.workflow}.${s.specialist ? " This is a specialist profile: it needs subject-matter review and is not a certification to handle regulated cargo." : ""}`, links: [[`${s.name} sector`, `/sectors/${s.slug}`], ["Start free with it", `/start?sector=${s.slug}`]] });
  void ent;
  return E;
}

const DEFAULT_SUGGEST = ["What is LOAD|BY|TON.store?", "How much does it cost?", "Which sectors do you cover?", "Is my data secure?", "Talk to a person"];
/** Phrases that decide the topic on their own, whatever else the sentence says. */
const BOOST: [RegExp, string, number][] = [
  [/\b(how much|cost|costs|price|prices|pricing|afford|affordable|cheap|expensive)\b/i, "pricing", 8],
  [/\b(free plan|free forever|is it free|really free)\b/i, "free", 8],
  [/\b(who (made|built|created|owns|runs)|founders?|group)\b/i, "about", 8],
  [/\b(where|which (aws|cloud|region))\b.*\b(hosted|stored|data|server)|\b(hosted|hosting)\b|\baws\b/i, "hosting", 8],
  [/\b(talk|speak|chat) (to|with)|\bwhatsapp\b|\bphone number\b|\bemail address\b|\bcontact (details|number|info)/i, "support", 6],
];
const HUMAN = /\b(human|person|someone|agent|representative|real person|live chat|talk to|speak to|speak with|call me|call back|callback|contact (you|us|sales))\b/i;

export function answer(question: string, plans: PlanVersion[]): Reply {
  const kb = buildKnowledge(plans);
  const q = question.trim().slice(0, 500);
  const qt = tokens(q);
  if (!q) return { answer: "Ask me anything about the platform. For example: how much does it cost?", links: [], suggestions: DEFAULT_SUGGEST, handoff: false, score: 0 };
  if (HUMAN.test(q) && qt.length <= 6) return { answer: "Of course. You can switch to Live chat in this window (a person replies during staffed hours), or message us on WhatsApp.", links: [["WhatsApp", `https://wa.me/${phone().replace(/\D/g, "")}`], ["Contact page", "/contact"]], suggestions: [], handoff: true, score: 99 };
  // document frequency over keys/title/text, so rare words count for more
  const df = new Map<string, number>();
  const docs = kb.map((e) => { const set = new Set([...e.keys.flatMap(tokens), ...tokens(e.title)]); const body = new Set(tokens(e.text)); for (const t of new Set([...set, ...body])) df.set(t, (df.get(t) ?? 0) + 1); return { e, set, body }; });
  const idf = (t: string) => Math.log(1 + docs.length / (1 + (df.get(t) ?? 0)));
  const scored = docs.map(({ e, set, body }) => {
    let s = 0;
    for (const t of new Set(qt)) { const w = idf(t); if (set.has(t)) s += 3 * w; else if (body.has(t)) s += 1 * w; }
    const low = q.toLowerCase();
    if (low.includes(e.title.toLowerCase())) s += 6;
    for (const [re, id, w] of BOOST) if (e.id === id && re.test(q) && !(id === "pricing" && /\b(starter|business|operations|enterprise|free)\b/i.test(q))) s += w;
    if (e.id.startsWith("sector-") && !set.has(qt.find((t) => set.has(t) && t.length > 3 && !["sector", "pack", "support", "cover"].includes(t)) ?? "")) s *= 0.55;
    return { e, s: s / Math.sqrt(1 + Math.max(0, qt.length - 4)) };
  }).sort((a, b) => b.s - a.s);
  const top = scored[0];
  const strong = top && top.s >= 2.8;
  if (!strong) {
    return { answer: "I do not have a good answer for that in my notes, and I would rather not guess. A person can answer it properly: switch to Live chat here, or message us on WhatsApp.", links: [["WhatsApp", `https://wa.me/${phone().replace(/\D/g, "")}`], ["Contact", "/contact"]], suggestions: DEFAULT_SUGGEST.slice(0, 4), handoff: true, score: top?.s ?? 0 };
  }
  const links = [...(top.e.links ?? [])];
  const second = scored[1];
  if (second && second.s >= top.s * 0.7 && second.e.links?.[0] && !links.some((l) => l[1] === second.e.links![0][1])) links.push(second.e.links[0]);
  return { answer: top.e.text, links: links.slice(0, 3), suggestions: top.e.follow ?? DEFAULT_SUGGEST.filter((x) => x.toLowerCase() !== q.toLowerCase()).slice(0, 3), handoff: false, entry: top.e.id, score: Number(top.s.toFixed(2)) };
}
