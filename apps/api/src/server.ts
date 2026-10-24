import { env } from '@chorala/config'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'

// Public URL ports belong to the edge proxy; the application listens internally.
const port = env.CHORALA_API_PORT

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(
    `✓ chorala-api listening on http://localhost:${info.port} (${env.CHORALA_DEPLOYMENT})`,
  )
})
