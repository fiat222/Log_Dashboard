const { test, expect } = require("@playwright/test");
const path = require("path");

test("login page exposes local username and password sign-in", async ({ page }) => {
  const loginPath = path.resolve(__dirname, "../../apps/web/login/index.html");

  await page.goto(`file://${loginPath}`);

  await expect(page.getByRole("heading", { name: "Log Dashboard" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Login with SSO/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Or Login as Admin" })).toHaveCount(0);
  const visibleText = await page.locator("body").innerText();
  expect(visibleText).not.toMatch(/[?????????]/);
});
