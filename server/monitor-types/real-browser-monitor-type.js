const { MonitorType } = require("./monitor-type");
const { chromium } = require("playwright-core");
const { UP, log } = require("../../src/util");
const { Settings } = require("../settings");
const childProcess = require("child_process");
const path = require("path");
const Database = require("../database");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { RemoteBrowser } = require("../remote-browser");
const { commandExists } = require("../util-server");

/**
 * Cached instance of the local browser
 * @type {import ("playwright-core").Browser}
 */
let localBrowser = null;
let localCloudflareBrowser = null;

/**
 * Cached instances of remote browser connections by remote browser ID
 * @type {Map<number, { url: string, browser: import ("playwright-core").Browser }>}
 */
const remoteBrowserConnections = new Map();

let allowedList = [];
let lastAutoDetectChromeExecutable = null;
const CLOUDFLARE_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CLOUDFLARE_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

if (process.platform === "win32") {
    allowedList.push(process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Google\\Chrome\\Application\\chrome.exe");

    // Allow Chromium too
    allowedList.push(process.env.LOCALAPPDATA + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Chromium\\Application\\chrome.exe");

    // Allow MS Edge
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe");

    // For Loop A to Z
    for (let i = 65; i <= 90; i++) {
        let drive = String.fromCharCode(i);
        allowedList.push(drive + ":\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
        allowedList.push(drive + ":\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
    }
} else if (process.platform === "linux") {
    allowedList = [
        "chromium",
        "chromium-browser",
        "google-chrome",

        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/snap/bin/chromium", // Ubuntu
    ];
} else if (process.platform === "darwin") {
    allowedList = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
}

/**
 * Is the executable path allowed?
 * @param {string} executablePath Path to executable
 * @returns {Promise<boolean>} The executable is allowed?
 */
async function isAllowedChromeExecutable(executablePath) {
    if (config.args["allow-all-chrome-exec"] || process.env.UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC === "1") {
        return true;
    }

    // Check if the executablePath is in the list of allowed executables
    return allowedList.includes(executablePath);
}

/**
 * Get the current instance of the browser. If there isn't one, create
 * it.
 * @returns {Promise<import ("playwright-core").Browser>} The browser
 */
async function getBrowser() {
    if (localBrowser && localBrowser.isConnected()) {
        return localBrowser;
    } else {
        let executablePath = await Settings.get("chromeExecutable");

        executablePath = await prepareChromeExecutable(executablePath);

        localBrowser = await chromium.launch({
            //headless: false,
            executablePath,
        });

        return localBrowser;
    }
}

/**
 * Get a local browser instance optimized for Cloudflare-protected pages.
 * It prefers headed mode and falls back to headless if the environment has no display.
 * @returns {Promise<import ("playwright-core").Browser>} The browser
 */
async function getCloudflareBrowser() {
    if (localCloudflareBrowser && localCloudflareBrowser.isConnected()) {
        return localCloudflareBrowser;
    }

    let executablePath = await Settings.get("chromeExecutable");
    executablePath = await prepareChromeExecutable(executablePath);

    const launchOptions = {
        executablePath,
        headless: false,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
        ],
    };

    try {
        localCloudflareBrowser = await chromium.launch(launchOptions);
    } catch (error) {
        const message = (error && error.message) || "";
        const looksLikeDisplayIssue =
            message.includes("Missing X server") ||
            message.includes("ozone_platform_x11") ||
            message.includes("headed mode") ||
            message.includes("DISPLAY");

        if (!looksLikeDisplayIssue) {
            throw error;
        }

        log.warn(
            "chromium",
            "Could not start headed Chromium for Cloudflare mode, falling back to headless mode."
        );

        localCloudflareBrowser = await chromium.launch({
            executablePath,
            args: launchOptions.args,
        });
    }

    return localCloudflareBrowser;
}

/**
 * Checks if a page looks like a Cloudflare challenge page.
 * @param {import("playwright-core").Page} page Browser page
 * @returns {Promise<boolean>} True if challenge markers are detected
 */
async function isCloudflareChallengePage(page) {
    const markers = [
        "checking your browser before accessing",
        "performing security verification",
        "just a moment",
        "verify you are human",
        "attention required!",
    ];

    const content = await page.evaluate(() => {
        const title = (document?.title || "").toLowerCase();
        const body = (document?.body?.innerText || "").toLowerCase();
        return `${title}\n${body}`;
    });

    return markers.some((marker) => content.includes(marker));
}

/**
 * Wait for a Cloudflare challenge to clear if detected.
 * @param {import("playwright-core").Page} page Browser page
 * @param {number} timeout Check timeout in milliseconds
 * @param {string} monitorName Monitor display name
 * @returns {Promise<void>}
 */
async function waitForCloudflareChallengeIfNeeded(page, timeout, monitorName) {
    const hasChallenge = await isCloudflareChallengePage(page);
    if (!hasChallenge) {
        return;
    }

    const waitTimeout = Math.max(3000, Math.min(20000, Math.floor(timeout * 0.7)));

    log.info(
        "monitor",
        `[${monitorName}] Cloudflare challenge detected, waiting up to ${waitTimeout}ms for completion`
    );

    try {
        await page.waitForFunction(
            () => {
                const text = `${(document?.title || "").toLowerCase()}\n${(document?.body?.innerText || "").toLowerCase()}`;
                const challengeMarkers = [
                    "checking your browser before accessing",
                    "performing security verification",
                    "just a moment",
                    "verify you are human",
                    "attention required!",
                ];
                return !challengeMarkers.some((marker) => text.includes(marker));
            },
            {
                timeout: waitTimeout,
            }
        );
    } catch (_) {
        throw new Error("Cloudflare challenge was not solved within the timeout.");
    }
}

/**
 * Get the current instance of the browser. If there isn't one, create it
 * @param {integer} remoteBrowserID Path to executable
 * @param {integer} userId User ID
 * @returns {Promise<Browser>} The browser
 */
async function getRemoteBrowser(remoteBrowserID, userId) {
    let remoteBrowser = await RemoteBrowser.get(remoteBrowserID, userId);
    if (!remoteBrowser) {
        throw new Error(`Remote browser #${remoteBrowserID} not found`);
    }

    const cacheKey = remoteBrowser.id;
    const cachedConnection = remoteBrowserConnections.get(cacheKey);

    if (cachedConnection && cachedConnection.browser.isConnected() && cachedConnection.url === remoteBrowser.url) {
        return cachedConnection.browser;
    }

    if (cachedConnection) {
        try {
            await cachedConnection.browser.close();
        } catch (_) {}
        remoteBrowserConnections.delete(cacheKey);
    }

    log.debug("chromium", `Using remote browser: ${remoteBrowser.name} (${remoteBrowser.id})`);
    const remoteConnection = await chromium.connect(remoteBrowser.url);

    remoteConnection.on("disconnected", () => {
        const current = remoteBrowserConnections.get(cacheKey);
        if (current && current.browser === remoteConnection) {
            remoteBrowserConnections.delete(cacheKey);
        }
    });

    remoteBrowserConnections.set(cacheKey, {
        url: remoteBrowser.url,
        browser: remoteConnection,
    });

    return remoteConnection;
}

/**
 * Clear cached remote browser connection by remote browser ID
 * @param {number} remoteBrowserID Remote browser ID
 * @returns {Promise<void>}
 */
async function clearRemoteBrowserConnection(remoteBrowserID) {
    const cachedConnection = remoteBrowserConnections.get(remoteBrowserID);
    if (!cachedConnection) {
        return;
    }

    try {
        await cachedConnection.browser.close();
    } catch (_) {}

    remoteBrowserConnections.delete(remoteBrowserID);
}

/**
 * Determine if an error is caused by browser/page/context being closed
 * @param {Error & { message?: string }} error Error
 * @returns {boolean} True if browser connection is closed
 */
function isBrowserClosedError(error) {
    const message = error?.message || "";
    return (
        message.includes("Target page, context or browser has been closed") ||
        message.includes("Target closed") ||
        message.includes("Browser has been closed") ||
        message.includes("Connection closed")
    );
}

/**
 * Determine if an error is a navigation timeout
 * @param {Error & { name?: string, message?: string }} error Error
 * @returns {boolean} True if timeout
 */
function isNavigationTimeoutError(error) {
    const message = error?.message || "";
    return error?.name === "TimeoutError" || message.includes("Timeout") || message.includes("timed out");
}

/**
 * Prepare the chrome executable path
 * @param {string} executablePath Path to chrome executable
 * @returns {Promise<string>} Executable path
 */
async function prepareChromeExecutable(executablePath) {
    // Special code for using the playwright_chromium
    if (typeof executablePath === "string" && executablePath.toLocaleLowerCase() === "#playwright_chromium") {
        // Set to undefined = use playwright_chromium
        executablePath = undefined;
    } else if (!executablePath) {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            executablePath = "/usr/bin/chromium";
            await installChromiumViaApt(executablePath);
        } else {
            executablePath = await findChrome(allowedList);
        }
    } else {
        // User specified a path
        // Check if the executablePath is in the list of allowed
        if (!(await isAllowedChromeExecutable(executablePath))) {
            throw new Error(
                "This Chromium executable path is not allowed by default. If you are sure this is safe, please add an environment variable UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC=1 to allow it."
            );
        }
    }
    return executablePath;
}

/**
 * Installs Chromium and required font packages via APT if the Chromium executable
 * is not already available.
 * @async
 * @param {string} executablePath - Path to the Chromium executable used to check
 * whether Chromium is available and to query its version after installation.
 * @returns {Promise<void>} Resolves when Chromium is successfully installed or
 * when no installation is required.
 * @throws {Error} If the APT installation fails or exits with an unexpected
 * exit code.
 */
async function installChromiumViaApt(executablePath) {
    if (await commandExists(executablePath)) {
        return;
    }
    await new Promise((resolve, reject) => {
        log.info("chromium", "Installing Chromium...");
        let child = childProcess.exec(
            "apt update && apt --yes --no-install-recommends install chromium fonts-indic fonts-noto fonts-noto-cjk"
        );

        // On exit
        child.on("exit", (code) => {
            log.info("chromium", "apt install chromium exited with code " + code);

            if (code === 0) {
                log.info("chromium", "Installed Chromium");
                let version = childProcess.execSync(executablePath + " --version").toString("utf8");
                log.info("chromium", "Chromium version: " + version);
                resolve();
            } else if (code === 100) {
                reject(new Error("Installing Chromium, please wait..."));
            } else {
                reject(new Error("apt install chromium failed with code " + code));
            }
        });
    });
}

/**
 * Find the chrome executable
 * @param {string[]} executables Executables to search through
 * @returns {Promise<string>} Executable
 * @throws {Error} Could not find executable
 */
async function findChrome(executables) {
    // Use the last working executable, so we don't have to search for it again
    if (lastAutoDetectChromeExecutable) {
        if (await commandExists(lastAutoDetectChromeExecutable)) {
            return lastAutoDetectChromeExecutable;
        }
    }

    for (let executable of executables) {
        if (await commandExists(executable)) {
            lastAutoDetectChromeExecutable = executable;
            return executable;
        }
    }
    throw new Error("Chromium not found, please specify Chromium executable path in the settings page.");
}

/**
 * Reset chrome
 * @returns {Promise<void>}
 */
async function resetChrome() {
    if (localBrowser) {
        await localBrowser.close();
        localBrowser = null;
    }

    if (localCloudflareBrowser) {
        await localCloudflareBrowser.close();
        localCloudflareBrowser = null;
    }
}

/**
 * Test if the chrome executable is valid and return the version
 * @param {string} executablePath Path to executable
 * @returns {Promise<string>} Chrome version
 */
async function testChrome(executablePath) {
    try {
        executablePath = await prepareChromeExecutable(executablePath);

        log.info("chromium", "Testing Chromium executable: " + executablePath);

        const browser = await chromium.launch({
            executablePath,
        });
        const version = browser.version();
        await browser.close();
        return version;
    } catch (e) {
        throw new Error(e.message);
    }
}
// test remote browser
/**
 * @param {string} remoteBrowserURL Remote Browser URL
 * @returns {Promise<boolean>} Returns if connection worked
 */
async function testRemoteBrowser(remoteBrowserURL) {
    try {
        const browser = await chromium.connect(remoteBrowserURL);
        browser.version();
        await browser.close();
        return true;
    } catch (e) {
        throw new Error(e.message);
    }
}
class RealBrowserMonitorType extends MonitorType {
    name = "real-browser";

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const isCloudflareMode = monitor.subtype === "cf";

        const runCheck = async (browser) => {
            const contextOptions = {
                ignoreHTTPSErrors: monitor.getIgnoreTls(),
            };

            if (isCloudflareMode) {
                contextOptions.userAgent = CLOUDFLARE_USER_AGENT;
                contextOptions.locale = "en-US";
                contextOptions.viewport = {
                    width: 1366,
                    height: 768,
                };
            }

            const context = await browser.newContext(contextOptions);

            try {
                if (isCloudflareMode) {
                    await context.addInitScript(() => {
                        Object.defineProperty(navigator, "webdriver", {
                            get: () => undefined,
                        });
                    });
                }

                const page = await context.newPage();

                if (isCloudflareMode) {
                    await page.setExtraHTTPHeaders({
                        "Accept-Language": CLOUDFLARE_ACCEPT_LANGUAGE,
                    });
                }

                // Prevent Local File Inclusion
                // Accept only http:// and https://
                // https://github.com/louislam/uptime-kuma/security/advisories/GHSA-2qgm-m29m-cj2h
                let url = new URL(monitor.url);
                if (url.protocol !== "http:" && url.protocol !== "https:") {
                    throw new Error("Invalid url protocol, only http and https are allowed.");
                }

                const timeout = Math.max(1000, Math.floor(monitor.interval * 1000 * 0.8));
                let res;

                if (isCloudflareMode) {
                    res = await page.goto(monitor.url, {
                        waitUntil: "domcontentloaded",
                        timeout,
                    });

                    await waitForCloudflareChallengeIfNeeded(page, timeout, monitor.name);

                    // Re-check once after challenge so status reflects the final destination page.
                    const verifyTimeout = Math.max(3000, Math.floor(timeout * 0.6));
                    const verifyResponse = await page.goto(monitor.url, {
                        waitUntil: "domcontentloaded",
                        timeout: verifyTimeout,
                    });

                    if (verifyResponse) {
                        res = verifyResponse;
                    }
                } else {
                    try {
                        res = await page.goto(monitor.url, {
                            waitUntil: "networkidle",
                            timeout,
                        });
                    } catch (error) {
                        if (!isNavigationTimeoutError(error)) {
                            throw error;
                        }

                        // Some sites keep long-lived network connections and never reach "networkidle".
                        // Retry once with a less strict load condition.
                        const fallbackTimeout = Math.max(1000, Math.floor(timeout * 0.6));
                        log.warn(
                            "monitor",
                            `[${monitor.name}] page.goto timeout with waitUntil=networkidle, retrying with waitUntil=domcontentloaded`
                        );
                        res = await page.goto(monitor.url, {
                            waitUntil: "domcontentloaded",
                            timeout: fallbackTimeout,
                        });
                    }
                }

                if (!res) {
                    throw new Error("Failed to navigate to page: no response returned by browser.");
                }

                // Wait for additional time before taking screenshot if configured
                if (monitor.screenshot_delay > 0) {
                    await page.waitForTimeout(monitor.screenshot_delay);
                }

                let filename = jwt.sign(monitor.id, server.jwtSecret) + ".png";

                await page.screenshot({
                    path: path.join(Database.screenshotDir, filename),
                });

                if (res.status() >= 200 && res.status() < 400) {
                    heartbeat.status = UP;
                    heartbeat.msg = res.status();

                    const timing = res.request().timing();
                    heartbeat.ping = timing.responseEnd;
                } else {
                    throw new Error(res.status() + "");
                }
            } finally {
                try {
                    await context.close();
                } catch (_) {}
            }
        };

        if (!monitor.remote_browser) {
            const browser = isCloudflareMode ? await getCloudflareBrowser() : await getBrowser();
            await runCheck(browser);
            return;
        }

        try {
            const browser = await getRemoteBrowser(monitor.remote_browser, monitor.user_id);
            await runCheck(browser);
        } catch (error) {
            if (!isBrowserClosedError(error)) {
                throw error;
            }

            log.warn(
                "chromium",
                `Remote browser connection dropped for monitor #${monitor.id} (${monitor.name}), reconnecting once`
            );
            await clearRemoteBrowserConnection(monitor.remote_browser);

            const browser = await getRemoteBrowser(monitor.remote_browser, monitor.user_id);
            await runCheck(browser);
        }
    }
}

module.exports = {
    RealBrowserMonitorType,
    testChrome,
    resetChrome,
    testRemoteBrowser,
};
