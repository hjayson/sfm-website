// Refreshes every client's Client Hub numbers each morning (11:00 UTC = 6 AM Eastern in winter).
// Scheduled functions run on the published site only, so test copies use the admin "Update now" button.
import { stores, refreshAll } from "../hub-core.mjs";

export default async (req, context) => {
  const results = await refreshAll(stores(context));
  console.log("Client Hub daily refresh", JSON.stringify(results));
};

export const config = { schedule: "0 11 * * *" };
