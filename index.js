const path = require("path");
const { chromium } = require("playwright");

const userDataDir = path.join(__dirname, "browser-data");

(async () => {
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: "chrome",
    });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto("https://x.com/home");

    // Keep the browser open
    await new Promise(() => {});
  } catch (error) {
    console.error("Failed to launch browser or open X:", error.message);
    if (context) {
      await context.close().catch(() => {});
    }
    process.exit(1);
  }
})();
