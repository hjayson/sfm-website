// Refreshes every client's Client Hub numbers at the top of every hour.
// Scheduled functions run on the published site only, so test copies use the admin "Update now" button.
import { stores, refreshAll } from "../hub-core.mjs";

export default async (req, context) => {
  const results = await refreshAll(stores(context));
  console.log("Client Hub hourly refresh", JSON.stringify(results));
};

export const config = { schedule: "@hourly" };
