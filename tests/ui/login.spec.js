const { test, expect } = require("@playwright/test");
const path = require("path");

test("login page exposes SSO and admin login paths", async ({ page }) => {
  const loginPath = path.resolve(__dirname, "../../dashboard/login/index.html");

  await page.goto(`file://${loginPath}`);

  await expect(page.getByRole("heading", { name: "Log Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Login with PSU Passport/i })).toBeVisible();

  await page.getByRole("button", { name: "Or Login as Admin" }).click();

  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "เข้าสู่ระบบ" })).toBeVisible();
});

