import { expect, test } from '@playwright/test'

const email = process.env.E2E_ADMIN_EMAIL
const password = process.env.E2E_ADMIN_PASSWORD
if (!email || !password) throw new Error('Explicit disposable E2E admin credentials are required')
const ADMIN = { email, password }

/**
 * SPEC §13 end-to-end journey:
 *   submit idea via the widget/public API → appears on the board → vote →
 *   admin changes its status → it shows on the public roadmap.
 * Provisioning contract: BASE_URL is the disposable edge origin, and the explicit
 * admin fixture belongs to a project containing a public `feature-requests` board
 * and an `In Progress` status shown on the roadmap. Migrate/bootstrap/seed only
 * that disposable database before running; the test never provisions a live stack.
 */
test('feedback journey: submit → board → vote → triage → roadmap', async ({ page, request }) => {
  const base = test.info().project.use.baseURL as string

  // --- Admin signs in ---
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(ADMIN.email)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(/\/admin\/[^/]+\/posts/)
  const projectId = page.url().match(/admin\/([^/]+)\/posts/)?.[1]
  expect(projectId).toBeTruthy()

  // --- Discover the project public key from settings ---
  await page.goto(`/admin/${projectId}/settings`)
  const publicKey = (
    await page
      .getByText('Public key (publishable)', { exact: true })
      .locator('..')
      .locator('code')
      .first()
      .innerText()
  ).trim()
  expect(publicKey).toMatch(/^pk_/)

  // --- Submit an idea via the public API (what the widget does), then vote ---
  const title = `E2E idea ${Date.now()}`
  const created = await request.post(`${base}/api/v1/public/posts`, {
    headers: { 'x-chorala-key': publicKey, 'content-type': 'application/json' },
    data: { boardSlug: 'feature-requests', title, body: 'created by the e2e test' },
  })
  expect(created.ok()).toBeTruthy()
  const postId = ((await created.json()) as { post: { id: string } }).post.id

  const voteRes = await request.post(`${base}/api/v1/public/posts/${postId}/vote`, {
    headers: { 'x-chorala-key': publicKey },
  })
  expect(((await voteRes.json()) as { voteCount: number }).voteCount).toBeGreaterThan(0)

  // --- It appears on the admin board ---
  await page.goto(`/admin/${projectId}/posts`)
  await expect(page.getByRole('link', { name: title })).toBeVisible()

  // --- Admin opens it and moves it to a roadmap status ---
  await page.getByRole('link', { name: title }).click()
  await page.waitForURL(/\/posts\/post_/)
  const status = page.getByLabel('status', { exact: true })
  const inProgress = await status
    .locator('option', { hasText: /^In Progress$/ })
    .getAttribute('value')
  expect(inProgress).toBeTruthy()
  await status.selectOption(inProgress as string)
  // Wait for the server action's durable update, rather than a timing-dependent sleep.
  await expect
    .poll(async () => {
      const response = await request.get(`${base}/api/v1/public/roadmap`, {
        headers: { 'x-chorala-key': publicKey },
      })
      expect(response.ok()).toBeTruthy()
      const roadmap = (await response.json()) as {
        columns: Array<{ status: { id: string }; posts: Array<{ id: string }> }>
      }
      return roadmap.columns.some(
        (column) =>
          column.status.id === inProgress && column.posts.some((post) => post.id === postId),
      )
    })
    .toBe(true)

  // --- It now shows on the public roadmap under In Progress ---
  await page.goto(`/portal/${projectId}/roadmap`)
  await expect(page.getByText(title)).toBeVisible()
})
