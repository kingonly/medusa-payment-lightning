import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import LightningProviderService from "./service"

export { LightningProviderService }
export type { LightningProviderOptions } from "../../lib/lightning"

export default ModuleProvider(Modules.PAYMENT, {
  services: [LightningProviderService],
})
