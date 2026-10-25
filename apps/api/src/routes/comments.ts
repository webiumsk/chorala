import { comments } from '@chorala/core'
import { createCommentInput } from '@chorala/types'
import { Hono } from 'hono'
import type { AppEnv } from '../types.ts'
import { reqParam } from '../util.ts'

// mounted at /projects/:projectId/posts/:postId/comments
export const commentsRoutes = new Hono<AppEnv>()
  .get('/', async (c) =>
    c.json(
      await comments.listAdminComments(
        c.get('auth'),
        reqParam(c, 'projectId'),
        reqParam(c, 'postId'),
      ),
    ),
  )
  .post('/', async (c) => {
    const ctx = c.get('auth')
    const input = createCommentInput.parse(await c.req.json())
    return c.json(
      await comments.createAdminComment(
        ctx,
        reqParam(c, 'projectId'),
        reqParam(c, 'postId'),
        input,
      ),
      201,
    )
  })
  .delete('/:id', async (c) =>
    c.json(
      await comments.deleteAdminComment(
        c.get('auth'),
        reqParam(c, 'projectId'),
        reqParam(c, 'postId'),
        c.req.param('id'),
      ),
    ),
  )
