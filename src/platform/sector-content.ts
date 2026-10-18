/**
 * Plain-language detail for each of the 18 sector packs, shown on the public sector pages and again in the client's dashboard.
 * It describes what the pack does (the stages, documents and roles of the walkthrough live in web/sector-demo.tsx) and which private
 * details the client types in themselves. Nothing here is a regulatory claim: the specialist sectors say so on their pages.
 */
export interface SectorContent {
  /** one line: who runs this */
  who: string;
  /** the problem it replaces */
  pain: string;
  /** what the pack gives you, in the order a day goes */
  highlights: string[];
  /** private details specific to this sector that the client enters in their own admin panel */
  yours: string[];
}

export const SECTOR_CONTENT: Record<string, SectorContent> = {
  "freight-forwarding": {
    who: "Air, ocean and road forwarders who quote, book and invoice shipments for other companies.",
    pain: "Quotes in email, rates in a spreadsheet, costs that arrive after the invoice has gone out.",
    highlights: [
      "Enquiry to quote, with supplier rates, chargeable weight and an approval step before it is sent",
      "One job per accepted quote, with route legs, bookings, supplier costs and documents on the same record",
      "Margin shown three ways (expected, estimated, reconciled) and unbilled jobs flagged",
      "Invoice and collections, with air waybill and shipment document drafts you review before use",
    ],
    yours: ["Your tax registration number on invoices", "Your IATA / FIATA or licence references, if you print them", "Your bank details block on invoices"],
  },
  "customs-brokerage": {
    who: "Licensed customs brokers who prepare declarations for clients and hand them to the official channel.",
    pain: "Evidence chased by phone, approvals nobody can find, deposits held without a clear record.",
    highlights: [
      "Case file per declaration with goods lines; tariff codes are format-checked and duty is estimated from the rates you enter",
      "Evidence checklist with uploads, and a second person approves before handover",
      "Printable handover pack and lines file for the licensed broker's own channel",
      "Deposits and guarantees recorded as client money, then disbursements on the final invoice",
    ],
    yours: ["Your broker licence reference", "Your tax registration number", "Nothing for the official channel: this software never logs in to it or files for you"],
  },
  "road-transport": {
    who: "Trucking companies and fleet operators who dispatch their own and subcontracted vehicles.",
    pain: "Trips planned by phone, detention that is never billed, drivers chased for paperwork.",
    highlights: [
      "Orders become trips, checked for capacity, driver availability and compliance before they are planned",
      "A phone app for drivers that keeps working with a weak signal and never double-posts proof of delivery",
      "Expenses, detention and subcontractor costs rolled into trip profit",
      "Invoice from delivered trips, with receipts reviewed by someone other than the person who entered them",
    ],
    yours: ["Vehicle registrations and permits", "Your tax registration number on invoices", "Fuel and toll account references"],
  },
  "contract-warehouse-3pl": {
    who: "Warehouses that store and move goods owned by their customers.",
    pain: "Customer stock that has to be exact, counts that never agree, storage billed from memory.",
    highlights: [
      "Stock kept per owner on a ledger that cannot be edited after the fact",
      "Receiving with variances and quarantine, FIFO allocation, pick and dispatch",
      "Blind cycle counts, approved by a second person before stock is adjusted",
      "Storage and handling activity turned into the customer invoice",
    ],
    yours: ["Your warehouse licence or free-zone references", "Your tax registration number", "Rate cards agreed with each customer"],
  },
  "courier-last-mile": {
    who: "Couriers and last-mile fleets that deliver merchants' parcels, often with cash on delivery.",
    pain: "Cash that doesn't tally, failed deliveries with no record, merchants asking where their money is.",
    highlights: [
      "Parcels by form or spreadsheet, printable labels, delivery runs and a rider phone app",
      "Proof of delivery and failed attempts, with returns handled",
      "Exact-cash collection, rider handover with variance approval, then merchant remittance with fees netted",
      "A public tracking link for each parcel and rate-card billing",
    ],
    yours: ["Your tax registration number", "The bank account merchants are paid from", "Your SMS sender name, if you use delivery notices"],
  },
  "ecommerce-fulfilment": {
    who: "Fulfilment centres that pick, pack and ship orders for online merchants.",
    pain: "Overselling, mis-picks, returns that vanish, and activity billed from a spreadsheet.",
    highlights: [
      "Merchant SKUs, inbound receiving and a stock ledger where reserved can never exceed on hand",
      "Pick, scan-verified pack and ship, with returns processed back to stock",
      "Counts that change stock only after independent approval",
      "Activity and storage billing, with a merchant portal that shows only their own stock",
    ],
    yours: ["Your tax registration number", "Rate cards per merchant", "Carrier and store credentials, entered by you if you add connectors"],
  },
  "consolidation-nvocc": {
    who: "Consolidators and NVOCCs who combine many shippers' cargo into shared containers.",
    pain: "House bills that don't match the master, containers that sail half full, agent settlements that run late.",
    highlights: [
      "Master and house shipment relationships kept together",
      "Container planning and allocation of each shipper's cargo",
      "Loading plan and manifest documents",
      "Destination-agent settlement statements",
    ],
    yours: ["Your NVOCC or carrier licence references", "Your tax registration number", "Agent and carrier contract rates"],
  },
  "cold-chain": {
    who: "Temperature-controlled carriers, stores and distributors of food, medicine and other chilled goods.",
    pain: "Temperature logs on paper, excursions found after delivery, nobody sure who released a load.",
    highlights: [
      "Temperature events and excursions recorded against the load",
      "Calibration evidence kept with the equipment",
      "Hold and release approvals by a named quality approver",
      "Logger feeds can post readings in (paid add-on)",
    ],
    yours: ["Calibration certificates", "Your food-safety or pharmaceutical licence references", "Your acceptable temperature ranges"],
  },
  "project-heavy-cargo": {
    who: "Project forwarders and heavy-lift carriers moving oversized or abnormal loads.",
    pain: "Permits and surveys tracked in email, budgets that drift, stages approved verbally.",
    highlights: [
      "Project budget with actuals beside it",
      "Equipment bookings, permits and route surveys on the project file",
      "Stage approvals recorded as they happen",
      "Close-out budget report",
    ],
    yours: ["Permit numbers and authority references", "Your insurance details", "Equipment owner references"],
  },
  "automotive-logistics": {
    who: "Vehicle importers, yards and dealers' logistics teams.",
    pain: "Condition disputes with no record, vehicles that can't be found in the yard, releases without authority.",
    highlights: [
      "Stock tracked by VIN with condition inspection on arrival",
      "Yard locations and slot allocation",
      "Release authority recorded before a vehicle leaves",
      "Damage claim file with the original condition report",
    ],
    yours: ["Your tax registration number", "Dealer and importer references", "Yard licence references"],
  },
  "marine-agency": {
    who: "Ship agents handling port calls for visiting vessels.",
    pain: "Disbursements estimated in a spreadsheet, service requests lost in email, final accounts late.",
    highlights: [
      "Port-call case per vessel",
      "Service requests and orders to suppliers",
      "Disbursement estimate against actuals",
      "Statement of facts and the final account for the principal",
    ],
    yours: ["Your port-agency licence references", "Your tax registration number", "Principal and supplier terms"],
  },
  "aviation-logistics": {
    who: "Air-cargo handlers and agents coordinating airlines, shippers and consignees.",
    pain: "Milestones chased by phone and documents that need a second pair of eyes.",
    highlights: [
      "Air shipments with milestones from booking to delivery",
      "Air waybill and manifest document drafts that you review; nothing is sent to an airline for you",
      "Coordination between customer, agent and handler",
      "Regulated procedures (such as dangerous goods) need your own validation",
    ],
    yours: ["Your IATA or agent code", "Your tax registration number", "Airline and handler contract references"],
  },
  "moving-relocation": {
    who: "Moving companies for homes and offices, local and international.",
    pain: "Surveys on paper, crews double-booked, damage claims argued from memory.",
    highlights: [
      "Survey and room-by-room inventory",
      "Crew scheduling and packing plan",
      "Storage between moves",
      "Damage claims with the inventory and photos attached",
    ],
    yours: ["Your tax registration number", "Insurance details", "Customer ID copies are not needed and not stored here"],
  },
  "import-export-trading": {
    who: "Trading companies that buy and sell goods across borders.",
    pain: "Landed cost worked out after the sale, stock and margin that never match.",
    highlights: [
      "Sales and purchase orders linked to each other",
      "Landed cost per shipment",
      "Stock and margin per trade",
      "Trade document set (invoice, packing list and others) kept with the order",
    ],
    yours: ["Your trade licence and import/export code", "Your tax registration number", "Bank details on invoices"],
  },
  distribution: {
    who: "Distributors who deliver to retailers and outlets on set routes.",
    pain: "Short deliveries, returns with no credit note, routes built by hand each morning.",
    highlights: [
      "Customer orders allocated from stock",
      "Dispatch routes and a driver app with proof of delivery",
      "Returns and credit notes",
      "Collections against delivered orders",
    ],
    yours: ["Your tax registration number", "Customer credit terms", "Bank details on invoices"],
  },
  "container-depot": {
    who: "Container depots and yards.",
    pain: "Gate moves on paper, damage argued with the shipping line, repairs approved by phone.",
    highlights: [
      "Gate-in and gate-out events with equipment condition",
      "Dwell time and storage charges",
      "Damage survey, repair estimate and approval",
      "Release checks before a container leaves",
    ],
    yours: ["Your depot licence and port-authority references", "Your tax registration number", "Shipping-line tariff terms"],
  },
  "dangerous-cargo": {
    who: "Carriers and forwarders handling regulated or dangerous goods.",
    pain: "Classification evidence scattered, approvals unrecorded, incidents reconstructed afterwards.",
    highlights: [
      "Classification evidence recorded per load",
      "Approvals by a trained person",
      "Restrictions shown on the load",
      "Incident records",
    ],
    yours: ["Dangerous-goods licences and trained-person certificates", "Your tax registration number", "Regulator references"],
  },
  "cross-border-transit": {
    who: "Hauliers and forwarders moving goods across borders under transit.",
    pain: "Border delays with no record, guarantees that stay open, transits that are never closed out.",
    highlights: [
      "Border legs and permits per movement",
      "Guarantee tracking",
      "Reconciliation to close each transit",
      "Delivery receipt at destination",
    ],
    yours: ["Permit and guarantee numbers", "Your tax registration number", "Border-agent references"],
  },
};

export const sectorContent = (slug: string) => SECTOR_CONTENT[slug];
