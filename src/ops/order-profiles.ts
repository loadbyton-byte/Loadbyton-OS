/**
 * Ready-made field mappings for marketplaces and shop platforms that publish an order API. A profile only pre-fills the same settings a person could type into an order pull;
 * anything typed overrides it. Each profile was written from the vendor's published API reference and has NOT been exercised against a live account from this repository:
 * run the first pull by hand and compare a few orders. There is no Noon profile: Noon's seller order interface is not publicly documented, so use the generic pull or CSV import.
 */
export interface OrderProfile { label: string; note: string; defaults: Record<string, any>; hint: Record<string, string> }
const SHIP = "extension_attributes.shipping_assignments.0.shipping.address";
export const ORDER_PROFILES: Record<string, OrderProfile> = {
  magento: {
    label: "Magento 2 / Adobe Commerce (REST)",
    note: "Orders are read with an integration access token (Bearer). The pull asks for orders updated since the last pull (first pull: the last 7 days) and ships orders in the statuses you list. Child lines of configurable products are skipped so each product is counted once. Bundle products are not expanded.",
    hint: { url: "https://your-store.example/rest/V1/orders", secret: "Integration access token (System → Integrations)" },
    defaults: {
      auth_scheme: "bearer", channel: "magento", items_path: "items", page_mode: "page", page_param: "searchCriteria[currentPage]", max_pages: 10, lookback_days: 7, since_format: "sql",
      since_param: "searchCriteria[filter_groups][0][filters][0][value]",
      static_params: { "searchCriteria[pageSize]": "100", "searchCriteria[filter_groups][0][filters][0][field]": "updated_at", "searchCriteria[filter_groups][0][filters][0][condition_type]": "gt", "searchCriteria[sortOrders][0][field]": "updated_at", "searchCriteria[sortOrders][0][direction]": "ASC" },
      map_ref: "increment_id", map_name: `${SHIP}.firstname,${SHIP}.lastname`, map_phone: `${SHIP}.telephone`, map_address: `${SHIP}.street.0,${SHIP}.street.1`, map_city: `${SHIP}.city`, map_country: `${SHIP}.country_id`,
      map_lines_path: "items", map_sku: "sku", map_qty: "qty_ordered", map_status: "status", map_time: "updated_at", map_line_skip_if_set: "parent_item_id", accept_values: "processing,pending", cancel_values: "canceled,closed",
    },
  },
  amazon: {
    label: "Amazon Selling Partner API (Orders v0, EU region, UAE marketplace)",
    note: "Sign-in uses Login with Amazon (client id, client secret and refresh token). Recipient names and addresses are restricted data: your SP-API application must hold the right PII role, and this profile first asks for a Restricted Data Token for the orders list. Without that role Amazon withholds the address and the orders are reported as lacking a delivery address. Order lines are fetched with one extra call per new order (at most 100 per pull). FBA orders are fulfilled by Amazon and should not be pulled; Unshipped and PartiallyShipped only.",
    hint: { url: "https://sellingpartnerapi-eu.amazon.com/orders/v0/orders", secret: 'JSON: {"client_id":"amzn1.application-oa2-client…","client_secret":"…","refresh_token":"Atzr|…"}' },
    defaults: {
      auth_scheme: "oauth2_refresh", token_url: "https://api.amazon.com/auth/o2/token", token_header: "x-amz-access-token", channel: "amazon", items_path: "payload.Orders", page_mode: "cursor", page_param: "NextToken", next_path: "payload.NextToken", cursor_only: true,
      max_pages: 10, lookback_days: 7, since_format: "iso", since_param: "LastUpdatedAfter", static_params: { MarketplaceIds: "A2VIGQ35RCS4UG", OrderStatuses: "Unshipped,PartiallyShipped,Canceled", MaxResultsPerPage: "100" },
      exchange_url: "https://sellingpartnerapi-eu.amazon.com/tokens/2021-03-01/restrictedDataToken", exchange_token_path: "restrictedDataToken",
      exchange_body: JSON.stringify({ restrictedResources: [{ method: "GET", path: "/orders/v0/orders", dataElements: ["buyerInfo", "shippingAddress"] }] }),
      detail_url: "https://sellingpartnerapi-eu.amazon.com/orders/v0/orders/{ref}/orderItems",
      map_ref: "AmazonOrderId", map_name: "ShippingAddress.Name", map_phone: "ShippingAddress.Phone", map_address: "ShippingAddress.AddressLine1,ShippingAddress.AddressLine2", map_city: "ShippingAddress.City", map_country: "ShippingAddress.CountryCode",
      map_lines_path: "detail.payload.OrderItems", map_sku: "SellerSKU", map_qty: "QuantityOrdered", map_status: "OrderStatus", map_time: "LastUpdateDate", accept_values: "unshipped,partiallyshipped", cancel_values: "canceled",
    },
  },
};
export const orderProfile = (name: unknown) => (typeof name === "string" ? ORDER_PROFILES[name] : undefined);
