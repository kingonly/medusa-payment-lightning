import { loadEnv, defineConfig, Modules } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

if (!process.env.LIGHTNING_ADDRESS) {
  throw new Error(
    "LIGHTNING_ADDRESS is not set. Install Glow (https://breez.technology/glow/), copy your name@breez.tips address into .env, and start again."
  )
}

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  plugins: [
    {
      resolve: "medusa-payment-lightning",
      options: {},
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-lightning/providers/lightning",
            id: "lightning",
            options: {
              lightningAddress: process.env.LIGHTNING_ADDRESS,
              // Optional. How long each invoice stays payable, in seconds (default 900).
              expirySeconds: process.env.LIGHTNING_EXPIRY_SECONDS
                ? Number(process.env.LIGHTNING_EXPIRY_SECONDS)
                : undefined,
            },
          },
        ],
      },
    },
  ],
})
