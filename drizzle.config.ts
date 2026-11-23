import { defineConfig } from 'drizzle-kit'

// Migration generation does not need a database. For push/pull, pass the same
// path the relay uses (WA_DB_PATH), e.g.
//   WA_DB_PATH=./relay.db pnpm exec drizzle-kit push
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/store/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.WA_DB_PATH ?? './data/relay.db'
  }
})
