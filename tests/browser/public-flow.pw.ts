import { expect, test } from '@playwright/test'

test('public home explains how to open a shared code without exposing admin navigation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'View a shared sign-in code.' })).toBeVisible()
  await expect(page.getByLabel('Share ID')).toBeVisible()
  await expect(page.getByRole('button', { name: 'View shared code' })).toBeDisabled()
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0)
  await expect(page.getByText('Admin sign in')).toHaveCount(0)
})

test('homepage extracts the Share ID from a pasted share URL', async ({ page }) => {
  const shareId = 'aB7kP2mQ9xR4tY6vN8zW3c'
  await page.goto('/')
  const input = page.getByLabel('Share ID')
  await input.fill('https://totpnest.example/s/' + shareId)
  await expect(input).toHaveValue(shareId)
  await page.getByRole('button', { name: 'View shared code' }).click()
  await expect(page).toHaveURL(new RegExp('/s/' + shareId + '
  await page.goto('/s/not-a-valid-share-id')
  await expect(page.getByRole('heading', { name: "Can't open this link" })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Enter another Share ID' })).toHaveAttribute('href', '/')
  await expect(page.getByText('Admin sign in')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
})

test('valid share paths render the shared-code experience without admin controls', async ({ page }) => {
  await page.goto('/s/aB7kP2mQ9xR4tY6vN8zW3c')
  await expect(page.getByRole('region', { name: 'Verification code' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy current code' })).toBeVisible()
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0)
})

test('public layout remains within a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth
  }))
  expect(widths.document).toBeLessThanOrEqual(widths.viewport)
  await expect(page.getByLabel('Share ID')).toBeVisible()
})
))
  await expect(page.getByRole('region', { name: 'Verification code' })).toBeVisible()
})

test('invalid share paths render a public-only recovery screen', async ({ page }) => {
  await page.goto('/s/not-a-valid-share-id')
  await expect(page.getByRole('heading', { name: "Can't open this link" })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Enter another Share ID' })).toHaveAttribute('href', '/')
  await expect(page.getByText('Admin sign in')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
})

test('valid share paths render the shared-code experience without admin controls', async ({ page }) => {
  await page.goto('/s/aB7kP2mQ9xR4tY6vN8zW3c')
  await expect(page.getByRole('region', { name: 'Verification code' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy current code' })).toBeVisible()
  await expect(page.locator('a[href="/admin"]')).toHaveCount(0)
})

test('public layout remains within a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/')
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth
  }))
  expect(widths.document).toBeLessThanOrEqual(widths.viewport)
  await expect(page.getByLabel('Share ID')).toBeVisible()
})
