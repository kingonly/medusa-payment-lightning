import Medusa from "@medusajs/js-sdk"

// Defined by the admin bundler; "/" when the dashboard is served by the backend.
declare const __BACKEND_URL__: string | undefined

export const sdk = new Medusa({
  baseUrl: typeof __BACKEND_URL__ !== "undefined" && __BACKEND_URL__ ? __BACKEND_URL__ : "/",
  auth: { type: "session" },
})
