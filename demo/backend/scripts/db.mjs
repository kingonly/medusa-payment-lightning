// Runs a Postgres for the demo without installing one: binaries come from the
// embedded-postgres package, data lives in ./.pgdata. Ctrl+C stops it.
import EmbeddedPostgres from "embedded-postgres"
import { existsSync } from "node:fs"

const DATA_DIR = new URL("../.pgdata", import.meta.url).pathname
const PORT = 54329
const DB = "medusa_lightning_demo"

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres",
  port: PORT,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error(String(e)),
})

const fresh = !existsSync(`${DATA_DIR}/PG_VERSION`)
if (fresh) await pg.initialise()
await pg.start()
if (fresh) await pg.createDatabase(DB)

console.log(`Postgres ready: postgres://postgres:postgres@127.0.0.1:${PORT}/${DB}`)
console.log("Leave this running. Ctrl+C to stop.")

const stop = async () => {
  await pg.stop()
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
