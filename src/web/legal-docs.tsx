import { config } from "../config.js";

/**
 * Legal documents for LOAD|BY|TON.store. DRAFT v1 written 18 Oct 2026 for the single UAE entity that operates loadbyton.com and loadbyton.store.
 * The pages show a draft banner until LEGAL_REVIEWED=true. The entity's legal name, licence, address and TRN come from SELLER_* settings and are
 * printed under each document. Have the text reviewed by a UAE-qualified lawyer before it is relied on.
 */
export const LEGAL_VERSION = "2026-10-18";
const cur = () => (config.vatBps / 100).toFixed(0);
const company = () => config.seller.legalName || "the LOAD|BY|TON operating company";
const P = (p: { children: any }) => <p>{p.children}</p>;
const Meta = () => <p class="small mute">Version {LEGAL_VERSION} · effective on publication · English text prevails over any translation.</p>;

export const LEGAL: Record<string, { title: string; body: any }> = {
  terms: { title: "Terms of service", body: (<>
    <Meta />
    <P>These terms are the contract between {company()} (“we”, “us”) and the business that creates or uses a LOAD|BY|TON.store workspace (“you”). We also operate loadbyton.com, the freight marketplace; the two are separate services with separate terms, linked only as described in the <a href="/legal/included-plans">Included plans</a> terms.</P>

    <h2>1. The service</h2>
    <P>LOAD|BY|TON.store is software for running a logistics business: enquiries, quotes, jobs, dispatch, warehouse and delivery records, documents, invoices and reports, in sector packs. You use it to run your own business; your relationships with your customers, suppliers and drivers are yours alone. We may add, change or retire features, and we will not remove a feature you pay for without a fair replacement or a pro-rata refund of the paid period.</P>

    <h2>2. Accounts and authority</h2>
    <ul><li>You must be a business or a person acting for one, and the person who registers must be authorised to bind it.</li>
    <li>You give us accurate details, keep credentials secret, and tell us promptly of suspected misuse. You are responsible for what your users do in your workspace.</li>
    <li>We may verify your company (for example trade licence and contact details) before a workspace can create records. Verification is an eligibility check, not an endorsement.</li></ul>

    <h2>3. Plans, limits and changes of plan</h2>
    <P>Each plan version is a published, unchangeable record of its price, set-up fee and limits. Limits are ceilings, not guarantees of provider-funded usage. When you reach a limit, new records of that type are blocked; everything already stored stays readable and exportable. If a plan lowers (for example the end of a paid period), your data is never deleted for that reason. Free and included plans may be changed or ended on 30 days’ notice, except as the Included plans terms say.</P>

    <h2>4. Fees, tax and payment</h2>
    <ul><li>Prices are in UAE dirhams (AED) and exclude value added tax. UAE VAT (currently {cur()}%) and any other applicable tax is added at checkout and shown before you pay.</li>
    <li>Paid plans are billed in advance for the period you choose. Access is granted after the payment provider confirms the payment, never from a browser redirect.</li>
    <li>Pass-through charges (for example SMS, e-invoicing providers, map and tracking services) are quoted separately and are never bundled into a plan price.</li>
    <li>Late or failed payment: we tell you, keep the workspace fully working for the grace period stated in your plan (7 days unless your plan says otherwise), then restrict it to read and export until payment is resolved. We do not delete data because a payment failed.</li>
    <li>Refunds: a paid period is refundable within 14 days of the first payment if you have not exceeded the Free plan’s limits; after that, fees for a period already started are not refundable except where the law requires or we have materially failed to provide the service.</li></ul>

    <h2>5. Your data</h2>
    <P>You own the data you put into the service. You give us the right to host, process, back up and display it to provide the service to you. We do not sell it, use it to train models for others, or show it to other customers. Export (JSON and CSV) is available on every plan, including after a plan lowers. The <a href="/legal/data-processing">data processing terms</a> apply to personal data in your workspace.</P>

    <h2>6. Acceptable use</h2>
    <P>You follow the <a href="/legal/acceptable-use">acceptable use rules</a>. We may suspend access to the part of the service involved, with notice where we can, if you breach them or put the service or other customers at risk.</P>

    <h2>7. Availability and support</h2>
    <P>We aim for 99.9% monthly availability and publish live status, but these are targets, not guarantees, and planned maintenance is excluded. Support is by email, WhatsApp and chat during the staffed hours shown on the site; urgent security issues are handled as quickly as we can. We do not promise 24/7 support on any plan unless your plan says so in writing.</P>

    <h2>8. Regulated activities</h2>
    <P>The software is not an accredited e-invoicing service provider, a customs authority, or a certification to handle dangerous goods, pharmaceutical cold chain or bonded inventory. Customs features are case management and a controlled handover to your licensed broker channel; we do not file declarations. You remain responsible for your licences, filings, tax returns and legal obligations. The four specialist sector packs (customs, cold chain, aviation, dangerous cargo) need review by a competent person in your business before you rely on them.</P>

    <h2>9. Intellectual property</h2>
    <P>We own the software, design and documentation; you may use them as the service allows while your account is active. You own your content and your brand. Feedback you give us may be used to improve the service without payment.</P>

    <h2>10. Warranties and liability</h2>
    <P>The service is provided with the care expected of a professional software supplier, and otherwise “as is”: we do not promise it will be uninterrupted or error-free, or that it fits a purpose not agreed in writing. To the extent UAE law allows, we are not liable for indirect or consequential loss, lost profit, lost business or lost data you could have exported, and our total liability for all claims in a 12-month period is limited to the fees you paid us for the service in that period (or AED 1,000 if you paid nothing). Nothing limits liability that cannot lawfully be limited, including for fraud or wilful misconduct.</P>

    <h2>11. Ending the relationship</h2>
    <P>You may stop at any time; paid periods are not shortened. We may end the service to you for material breach not fixed within 14 days of notice, or immediately for serious misuse or legal necessity. After the end, you can export your data for the retention period in the <a href="/legal/data-processing">data processing terms</a>, after which it is erased as described there.</P>

    <h2>12. Changes to these terms</h2>
    <P>We may update these terms. For changes that reduce your rights we give at least 30 days’ notice by email or in the product; continued use after that is acceptance, and you may stop first.</P>

    <h2>13. Governing law and disputes</h2>
    <P>These terms are governed by the laws of the United Arab Emirates as applied in the Emirate of Dubai. The parties first try to settle disputes in good faith within 30 days of written notice; failing that, the courts of Dubai have jurisdiction.</P>

    <h2>14. Contact and notices</h2>
    <P>Notices to us: {config.seller.email || "the support address shown on the contact page"}. Notices to you: the email addresses on your account.</P></>) },

  "included-plans": { title: "Included plans (Business OS with loadbyton.com)", body: (<>
    <Meta />
    <P>A company with a verified account on loadbyton.com can activate LOAD|BY|TON.store without a separate software subscription. These terms add to the <a href="/legal/terms">Terms of service</a> for workspaces created that way.</P>
    <h2>1. Starter Included and Enterprise Included</h2>
    <ul><li><strong>Starter Included</strong> is granted while your company is a verified loadbyton.com company that has activated Business OS. It carries the Starter plan’s limits with no subscription fee and no standard self-service set-up fee.</li>
    <li><strong>Enterprise Included</strong> is granted while your company also holds an active loadbyton.com Premium membership. It carries the Enterprise plan’s limits with no extra subscription fee.</li></ul>
    <P>The limits are the published plan ceilings. They are not a promise of provider-funded usage: external usage, provider fees, bespoke implementation and managed services are quoted separately.</P>
    <h2>2. What we receive from loadbyton.com, and what we do not</h2>
    <P>loadbyton.com tells us your company’s identifier, name, verification status, the plan it is entitled to, dates, the sector you chose when you activated, and who accepted the activation terms. We do not receive your freight jobs, bids, payments or documents, and loadbyton.com does not receive your workspace records. See the <a href="/legal/privacy">Privacy notice</a>.</P>
    <h2>3. When the entitlement changes</h2>
    <ul><li><strong>Cancellation of Premium:</strong> Enterprise Included continues to the end of the paid period, then your company returns to Starter Included.</li>
    <li><strong>Failed payment:</strong> Enterprise Included continues for a grace period of 14 days (this period is set by loadbyton.com), then returns to Starter Included.</li>
    <li><strong>Company no longer verified:</strong> the workspace becomes read-only (you can read and export everything) until verification is restored.</li>
    <li>In every case your data is kept. Records above the lower plan’s limits stay readable and exportable; only new records of the affected type are blocked.</li></ul>
    <h2>4. If you already pay us</h2>
    <P>A workspace that already pays for an equal or higher plan keeps it. An included plan never silently replaces a plan you bought, and you are never charged twice for the same software.</P>
    <h2>5. Who may activate</h2>
    <P>Only your company’s administrator on loadbyton.com may activate Business OS, accept these terms for the company and choose its first sector. The first sign-in of that administrator creates the workspace. Other people join by invitation inside the workspace.</P>
    <h2>6. Ending the link</h2>
    <P>You may stop using Business OS at any time. If your loadbyton.com account closes, the workspace stays available on the plan it then has for 30 days so you can export, and is then handled under the retention terms.</P></>) },

  services: { title: "Managed services terms", body: (<>
    <Meta />
    <P>These terms apply to services we deliver for a fee under a signed or accepted quote (“Order”), such as websites, digital marketing, social media management, brand and document work, and automation or integrations. They add to the <a href="/legal/terms">Terms of service</a>.</P>
    <h2>1. Orders and scope</h2>
    <P>Each Order states the deliverables, languages, number of pages or posts, integrations, revision rounds, response hours, timeline, price and payment milestones. Work outside the Order is a change order with its own price. A service is not started until you accept the Order and pay the deposit it states.</P>
    <h2>2. Your inputs</h2>
    <P>You give us accurate content, facts, logos and access in time. You confirm you have the right to use what you provide. Delays caused by missing inputs move the timeline.</P>
    <h2>3. Review, acceptance and revisions</h2>
    <P>We deliver for review at each milestone. You accept or give specific written feedback within 5 working days; silence is acceptance of that milestone. The Order’s revision rounds are included; more are charged.</P>
    <h2>4. Advertising and results</h2>
    <P>Advertising spend belongs to you and is paid to the platform separately from our fee. We do not promise search rankings, traffic, leads or sales. Social and search platforms set their own rules and may change or suspend accounts.</P>
    <h2>5. Ownership</h2>
    <P>On full payment you own the deliverables made for you. We keep our pre-existing tools and may reuse general know-how. Third-party components and fonts keep their licences. We may name you as a client only with your written permission.</P>
    <h2>6. Hosting, maintenance and integrations</h2>
    <P>Hosting, domains, provider access, usage, maintenance and acceptance tests for automations are quoted and billed separately and stated in the Order.</P>
    <h2>7. Payment and cancellation</h2>
    <P>Fees are in AED plus VAT, invoiced by milestone. If you cancel, you pay for work done and costs committed up to the cancellation date; deposits are applied to that and the balance, if any, refunded. Retainers renew monthly and may be cancelled on 30 days’ notice.</P>
    <h2>8. Liability</h2>
    <P>Clause 10 of the Terms of service applies; for an Order, the 12-month cap is the fees paid under that Order.</P></>) },

  "acceptable-use": { title: "Acceptable use", body: (<>
    <Meta />
    <P>You and your users must not:</P>
    <ul><li>break the law, or use the service for fraud, money laundering, sanctions evasion, or to move goods you are not entitled to move;</li>
    <li>upload malware, probe or attack the service, bypass tenant isolation or limits, or scrape it beyond the published API;</li>
    <li>send spam or unsolicited messages through the messaging features, or message people who have not agreed to hear from you where consent is required;</li>
    <li>store card numbers, passwords or government identity documents in free-text fields or messages;</li>
    <li>resell access to the service without our written agreement, or share one login between people;</li>
    <li>misstate regulated approvals, certifications or licences in documents you create with the service.</li></ul>
    <P>We may remove content or suspend the part of the service involved to stop harm, and we tell you why unless the law or an investigation prevents it. Report abuse or security issues to {config.seller.email || "the support address on the contact page"}.</P></>) },

  privacy: { title: "Privacy notice", body: (<>
    <Meta />
    <P>This notice explains how {company()} handles personal data on LOAD|BY|TON.store and in the link with loadbyton.com. We follow the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021) and other applicable UAE law.</P>
    <h2>Roles</h2>
    <P>For your own account, billing, verification and support we are the <strong>controller</strong>. For the records you keep about your customers, suppliers, drivers and staff in your workspace, you are the controller and we are your <strong>processor</strong> under the <a href="/legal/data-processing">data processing terms</a>.</P>
    <h2>What we collect, why, and on what basis</h2>
    <ul><li><strong>Account and company details</strong> (name, email, phone, company, trade licence and tax numbers, role): to create and secure your account and verify your company: contract and legal obligation.</li>
    <li><strong>Usage and security records</strong> (sign-in times, IP address, device, audit trail, error reports): to keep the service secure and working: legitimate interest and legal obligation.</li>
    <li><strong>Payments</strong>: handled by our payment provider; we keep order references, amounts and status, not card numbers: contract and legal obligation (tax records).</li>
    <li><strong>Brand files and messages</strong> you send our team: to deliver and support your service. Please do not send card numbers, passwords or bank details; our messaging refuses the obvious shapes of them.</li>
    <li><strong>Live chat</strong>: your messages and a random browser key (stored hashed) so the conversation continues; kept for the retention period.</li></ul>
    <h2>Link with loadbyton.com</h2>
    <P>If you sign in with “Continue with Loadbyton” or activate Business OS from loadbyton.com, the two services exchange only: your person identifier, name, email and role in the company; the company identifier, name and verification status; the plan entitlement, its dates and the chosen sector; and who accepted the activation terms. Freight jobs, bids, payments and documents stay on loadbyton.com; workspace records stay here. A company administrator can end the link by closing Business OS.</P>
    <h2>Sharing</h2>
    <P>We share data with the service providers listed on the <a href="/legal/subprocessors">subprocessors page</a>, with professional advisers under confidentiality, and with authorities where the law requires. We do not sell personal data or use it for third-party advertising.</P>
    <h2>Cookies and similar technologies</h2>
    <P>We use only what the service needs: a sign-in session cookie, a security (CSRF) cookie, a language preference, and short-lived cookies for sign-in with loadbyton.com. We do not use advertising or cross-site tracking cookies.</P>
    <h2>International transfers</h2>
    <P>Some providers process data outside the UAE. Where they do, we rely on contractual safeguards and the provider’s published terms, and list them on the subprocessors page.</P>
    <h2>Retention</h2>
    <P>We keep personal data for as long as the account is active and then for the schedule in the data processing terms ({config.retentionDays} days after exit by default), longer only where tax, accounting or other law, or a legal claim, requires.</P>
    <h2>Your rights</h2>
    <P>You may ask for access, correction, deletion, restriction, portability, to object, and to withdraw consent. Company owners can submit requests under Your data; others write to {config.seller.email || "the address on the contact page"}. We reply within 30 days. You may complain to the UAE Data Office.</P>
    <h2>Security</h2>
    <P>Tenant isolation in the database, encryption in transit and for stored secrets, two-person approvals for sensitive actions, signed webhooks, audited staff access and tested backups. No system is perfectly secure; we tell affected customers about breaches as described in the data processing terms.</P>
    <h2>Children</h2>
    <P>The service is for businesses and is not directed at children.</P></>) },

  "data-processing": { title: "Data processing terms", body: (<>
    <Meta />
    <P>These terms apply where we process personal data in your workspace on your behalf. You are the controller; {company()} is the processor.</P>
    <h2>1. Subject, duration and nature</h2>
    <P>We host and process the records you enter or import (for example customers’ contact details, driver details, shipment and stock records, documents) to provide the service, for as long as your account exists and for the exit period below.</P>
    <h2>2. Our commitments</h2>
    <ul><li>We process personal data only on your documented instructions (the service itself and your settings), and tell you if an instruction appears to break the law.</li>
    <li>People with access are bound by confidentiality. Staff access to a workspace needs an approved, time-limited support grant that you can see.</li>
    <li>We apply the security measures described in the Privacy notice, including tenant isolation, encryption, access control, logging and tested backups.</li>
    <li>We help you answer data-subject requests and meet your own security and impact-assessment duties, within reason and at no charge for ordinary requests.</li></ul>
    <h2>3. Subprocessors</h2>
    <P>You authorise the providers on the <a href="/legal/subprocessors">subprocessors page</a>. We give 30 days’ notice of a new one; you may object on reasonable grounds and, if we cannot resolve it, end the service and export your data. Each is bound by terms no less protective than these.</P>
    <h2>4. Personal data breaches</h2>
    <P>We tell you without undue delay, and in any case within 72 hours of becoming aware of a breach affecting your personal data, with what we know about its nature, the data and people affected, likely consequences and the steps taken. An incident commander and a customer-communication owner are named in our incident procedure.</P>
    <h2>5. Retention, return and erasure</h2>
    <P>Export remains available while the account is retained. The default schedule is {config.retentionDays} days after the applicable exit milestone, subject to your contract, statutory records and legal holds. Approved erasure covers the database, private objects, and the eventual expiry of recovery copies under the provider schedule. We confirm completion on request.</P>
    <h2>6. Transfers</h2>
    <P>Where a subprocessor processes data outside the UAE, we ensure an appropriate safeguard under UAE law and list the provider and role.</P>
    <h2>7. Audits</h2>
    <P>On reasonable notice, and no more than once a year unless there is a breach, we give you the information needed to show compliance, including our security documentation and the results of our own tests. On-site audits are agreed in advance, limited to relevant systems and paid for by you.</P>
    <h2>8. Liability</h2>
    <P>Clause 10 of the Terms of service applies.</P></>) },

  subprocessors: { title: "Subprocessors", body: (<>
    <Meta />
    <ul><li>Oracle Cloud Infrastructure: application and background compute.</li>
    <li>Cloudflare: DNS, TLS edge and origin tunnel.</li>
    <li>Neon: transactional PostgreSQL and configured recovery.</li>
    <li>Supabase: private document objects.</li>
    <li>Upstash: shared abuse-prevention counters with pseudonymous keys.</li>
    <li>Stripe: hosted payment processing when enabled (card and wallet data go to Stripe, not to us).</li>
    <li>Your configured email or SMS provider: account and service notifications.</li>
    <li>loadbyton.com (same operating company): sign-in and plan entitlement, as described in the Privacy notice.</li></ul>
    <P>Deployment region and processing schedule: {config.deploymentRegion}. Each provider’s region, retention, transfer and recovery terms are reviewed before use; providers may process security and payment data in additional locations. We announce changes 30 days ahead.</P></>) },

  accessibility: { title: "Accessibility", body: (<>
    <Meta />
    <P>We design for keyboard use, visible focus, sufficient contrast, text and icons in addition to colour (red is never the only indicator of an error), and large touch targets for driver workflows. We have not yet completed a formal accessibility audit; report problems via <a href="/contact">Contact</a> and we will respond within 5 working days.</P></>) },
};
