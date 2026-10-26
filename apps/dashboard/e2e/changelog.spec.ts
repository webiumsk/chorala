import { expect, test } from '@playwright/test'

const email = process.env.E2E_ADMIN_EMAIL
const password = process.env.E2E_ADMIN_PASSWORD
if (!email || !password) throw new Error('Explicit disposable E2E admin credentials are required')

/** Uses the loopback-only disposable fixture required by playwright.config.ts. */
test('an existing draft publishes with its ID and stays published when edited', async ({
  page,
}) => {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(/\/admin\/[^/]+\/posts/)
  const projectId = page.url().match(/admin\/([^/]+)\/posts/)?.[1]
  expect(projectId).toBeTruthy()
  const title = `E2E changelog ${Date.now()}`
  const originalBody = '## Original draft\n\n- A reviewed improvement.'
  const endpoint = `/api/v1/projects/${projectId}/changelog`
  const entries = async () => {
    const response = await page.request.get(endpoint)
    expect(response.ok()).toBe(true)
    return (await response.json()) as Array<{
      id: string
      title: string
      body: string
      status: string
      publishedAt: string | null
    }>
  }
  let entryId: string | undefined
  try {
    await page.goto(`/admin/${projectId}/changelog`)
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Body (Markdown)', { exact: true }).fill(originalBody)
    await page.getByLabel('Labels (comma-separated)', { exact: true }).fill('e2e, improved')
    await page.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible()
    const draft = (await entries()).find((entry) => entry.title === title)
    expect(draft?.status).toBe('draft')
    expect(draft?.publishedAt).toBeNull()
    expect(draft?.id).toBeTruthy()
    entryId = draft?.id

    await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click()
    await expect(page.locator('input[name="id"]')).toHaveValue(entryId as string)
    await expect(page.getByLabel('Body (Markdown)', { exact: true })).toHaveValue(originalBody)
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await expect(page.getByText('Published entry saved.', { exact: true })).toBeVisible()
    const published = (await entries()).find((entry) => entry.id === entryId)
    expect(published?.status).toBe('published')
    expect(published?.publishedAt).toBeTruthy()

    const changedBody = '## Reviewed update\n\n- Updated without changing publication status.'
    await page.getByLabel('Body (Markdown)', { exact: true }).fill(changedBody)
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Published entry saved.', { exact: true })).toBeVisible()
    const edited = (await entries()).find((entry) => entry.id === entryId)
    expect(edited?.status).toBe('published')
    expect(edited?.publishedAt).toBe(published?.publishedAt)
    expect(edited?.body.replace(/\r\n/g, '\n')).toBe(changedBody)
    await page.goto(`/portal/${projectId}/changelog`)
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
    const article = page.locator('article').filter({
      has: page.getByRole('heading', { name: title, exact: true }),
    })
    await expect(
      article.getByRole('heading', { name: 'Reviewed update', exact: true }),
    ).toBeVisible()
  } finally {
    if (entryId) {
      const response = await page.request.delete(`${endpoint}/${entryId}`, {
        headers: { origin: new URL(page.url()).origin },
      })
      expect(response.ok()).toBe(true)
    }
  }
})
