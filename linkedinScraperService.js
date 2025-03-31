const puppeteer = require('puppeteer');
const { EventEmitter } = require('events');

async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function setCookies(page, cookiesString, emitter) {
    try {
        // First clear any existing cookies
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        
        // Parse cookie string more robustly
        const cookies = [];
        const cookieParts = cookiesString.split(';');
        
        for (const part of cookieParts) {
            if (!part.trim()) continue;
            
            const [name, ...valueParts] = part.trim().split('=');
            // Join back in case the value itself contains = signs
            const value = valueParts.join('=');
            
            if (name && value) {
                cookies.push({ 
                    name, 
                    value, 
                    domain: '.linkedin.com',
                    path: '/',
                    httpOnly: false,
                    secure: true
                });
            }
        }
        
        // Check if we have important LinkedIn cookies
        const hasLiAt = cookies.some(c => c.name === 'li_at');
        
        if (!hasLiAt) {
            throw new Error('Missing required LinkedIn authentication cookie (li_at)');
        }
        
        await page.setCookie(...cookies);
        console.log("Cookies set successfully");
        emitter.emit('progress', { status: 'cookies_set', message: 'Cookies set successfully' });
    } catch (error) {
        console.error("Error setting cookies:", error);
        emitter.emit('error', { status: 'error', message: `Failed to set cookies: ${error.message}` });
        throw error;
    }
}

// Extract LinkedIn profile information to know who the session belongs to
async function getCurrentUserInfo(page, emitter) {
    try {
        emitter.emit('progress', { status: 'fetching_user_info', message: 'Fetching current user information' });
        
        // Visit the feed or home page which is less likely to timeout
        await page.goto('https://www.linkedin.com/feed/', { 
            waitUntil: 'domcontentloaded',  // Use domcontentloaded instead of networkidle2
            timeout: 30000  // Reduced timeout
        });
        
        // Wait for the navigation menu which contains user info
        await page.waitForSelector('nav', { timeout: 15000 }).catch(() => {
            console.log('Nav menu not found, continuing anyway');
        });
        
        // Retrieve user information
        const userInfo = await page.evaluate(() => {
            // Try to get profile info from the nav menu
            const profileSection = document.querySelector('nav a[data-control-name="identity_profile_photo"]') || 
                                   document.querySelector('.global-nav__me-photo') ||
                                   document.querySelector('[data-control-name="nav.settings_view_profile"]');
                                   
            // Try to get the profile URL
            const profileUrl = profileSection ? 
                (profileSection.href || '').split('?')[0] : '';
                
            // Try to get display name from various possible elements
            let displayName = '';
            const nameElem = document.querySelector('.global-nav__me-photo') || 
                            document.querySelector('.feed-identity-module__actor-meta a');
            
            if (nameElem) {
                // If it's an image, try to get the alt text which often contains the name
                if (nameElem.tagName === 'IMG') {
                    displayName = nameElem.alt || '';
                } else {
                    displayName = nameElem.textContent.trim();
                }
            }
            
            return {
                profileUrl,
                displayName,
                loggedIn: !!document.querySelector('.global-nav__me') || 
                          !document.querySelector('[data-tracking-control-name="guest_homepage-basic_sign-in-link"]')
            };
        });
        
        if (!userInfo.loggedIn) {
            throw new Error('Not logged in to LinkedIn. Please provide valid cookies.');
        }
        
        emitter.emit('progress', { 
            status: 'user_info_fetched', 
            message: 'Current user information fetched',
            userInfo: userInfo
        });
        
        return userInfo;
    } catch (error) {
        console.error("Error fetching user info:", error);
        emitter.emit('error', { 
            status: 'error', 
            message: `Failed to fetch user info: ${error.message}` 
        });
        throw error;
    }
}

// Validate session before proceeding with search
async function validateSession(page, emitter) {
    try {
        // Go to LinkedIn feed page instead of homepage - often more reliable
        emitter.emit('progress', { status: 'validating', message: 'Validating LinkedIn session' });
        
        // Get user info first - this also validates the session
        const userInfo = await getCurrentUserInfo(page, emitter);
        
        // If we got here, session is valid
        emitter.emit('progress', { 
            status: 'validated', 
            message: 'LinkedIn session validated',
            userInfo: userInfo
        });
        
        return true;
    } catch (error) {
        console.error("Session validation error:", error);
        emitter.emit('error', { status: 'error', message: `Session validation failed: ${error.message}` });
        throw error;
    }
}

// Take a screenshot and log page content for debugging
async function debugPageContent(page, label = "debug") {
    try {
        console.log(`---DEBUG ${label}---`);
        
        // Save screenshot for visual debugging
        const screenshotPath = `./debug-${label}-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot saved to ${screenshotPath}`);
        
        // Log page title and URL
        const title = await page.title();
        const url = page.url();
        console.log(`Page title: ${title}`);
        console.log(`Page URL: ${url}`);
        
        // Log HTML structure to see what selectors we need
        const bodyHTML = await page.evaluate(() => {
            return document.body.innerHTML.substring(0, 1000); // First 1000 chars to avoid huge logs
        });
        console.log("Page HTML snippet:");
        console.log(bodyHTML);
        
        // Check for common elements
        const commonSelectors = [
            '.search-results-container',
            '.reusable-search__result-container',
            '.entity-result__item',
            '.search-results',
            '.search-results__cluster',
            // Add newer possible selectors here
            '.scaffold-layout__list',
            '.artdeco-list',
            '.artdeco-list__item',
            '.search-reusables__result-container'
        ];
        
        const foundSelectors = await page.evaluate((selectors) => {
            return selectors.map(selector => {
                const elements = document.querySelectorAll(selector);
                return {
                    selector,
                    count: elements.length,
                    exists: elements.length > 0
                };
            });
        }, commonSelectors);
        
        console.log("Found elements:");
        console.log(foundSelectors);
        console.log(`---END DEBUG ${label}---`);
    } catch (e) {
        console.error("Error during debugging:", e);
    }
}

async function extractProfileData(page) {
    try {
        // Debug the page content to see what's happening
        await debugPageContent(page, "before-extraction");
        
        // Wait a bit more to ensure all content is loaded
        await delay(2000);
        
        return await page.evaluate(() => {
            const profiles = [];
            
            // Try multiple potential selectors for search results
            // LinkedIn occasionally changes their HTML structure
            const selectors = [
                '.reusable-search__result-container',
                '.entity-result',
                '.search-results__list .search-result',
                '.scaffold-layout__list-item',
                '.artdeco-list__item', 
                '.search-reusables__result-container',
                // Add more selectors as LinkedIn updates their structure
                '[data-chameleon-result-urn]'
            ];
            
            // Try each selector until we find results
            let results = [];
            for (const selector of selectors) {
                results = document.querySelectorAll(selector);
                if (results.length > 0) {
                    console.log(`Found ${results.length} results with selector: ${selector}`);
                    break;
                }
            }
            
            // Detect "no results" message with multiple possible selectors
            const noResultsSelectors = [
                '.search-reusables__no-results-message',
                '.search-no-results',
                '.artdeco-empty-state',
                '.search-results--empty'
            ];
            
            let noResultsFound = false;
            let noResultsMessage = '';
            
            for (const selector of noResultsSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    noResultsFound = true;
                    noResultsMessage = element.textContent.trim();
                    break;
                }
            }
            
            // If we didn't find any results using our selectors and have no explicit "no results" message,
            // check if there's any indication this is a search results page
            if (results.length === 0 && !noResultsFound) {
                // Check if we're on the right page
                const isSearchPage = !!document.querySelector('.search-results-container') || 
                                      !!document.querySelector('.search-results') ||
                                      !!document.querySelector('.search-reusables');
                
                if (!isSearchPage) {
                    return {
                        profiles: [],
                        message: 'Not on a LinkedIn search results page. LinkedIn may have redirected.',
                        hasNoResults: true
                    };
                }
            }
            
            // If no results found, return accordingly
            if (results.length === 0 || noResultsFound) {
                return {
                    profiles: [],
                    message: noResultsMessage || 'No search results found',
                    hasNoResults: true
                };
            }
            
            // Extract data from each result
            results.forEach(result => {
                try {
                    // Try multiple selectors for each piece of information
                    const nameSelectors = [
                        '.entity-result__title-text a',
                        '.actor-name a',
                        '.search-result__result-title a',
                        '.artdeco-entity-lockup__title a',
                        '.app-aware-link[data-field="name"]'
                    ];
                    
                    const titleSelectors = [
                        '.entity-result__primary-subtitle',
                        '.search-result__truncate',
                        '.artdeco-entity-lockup__subtitle',
                        'div[data-field="headline"]'
                    ];
                    
                    const locationSelectors = [
                        '.entity-result__secondary-subtitle',
                        '.search-result__location',
                        '.artdeco-entity-lockup__caption',
                        'div[data-field="location"]'
                    ];
                    
                    // Function to try multiple selectors
                    const findElement = (parent, selectors) => {
                        for (const selector of selectors) {
                            const element = parent.querySelector(selector);
                            if (element) return element;
                        }
                        return null;
                    };
                    
                    const nameElement = findElement(result, nameSelectors);
                    const titleElement = findElement(result, titleSelectors);
                    const locationElement = findElement(result, locationSelectors);
                    
                    // Skip this result if we can't find a name
                    if (!nameElement) return;
                    
                    const profileUrl = nameElement?.href?.split('?')[0] || '';
                    const name = nameElement?.textContent?.trim() || '';
                    const title = titleElement?.textContent?.trim() || '';
                    const location = locationElement?.textContent?.trim() || '';
                    const linkedinId = profileUrl.split('/in/')[1] || '';
                    
                    if (name) {
                        profiles.push({
                            name,
                            title,
                            location,
                            profileUrl,
                            linkedinId
                        });
                    }
                } catch (e) {
                    console.error('Error parsing profile:', e);
                }
            });
            
            return { 
                profiles,
                hasNoResults: profiles.length === 0
            };
        });
    } catch (error) {
        console.error("Error extracting profile data:", error);
        return { profiles: [], error: error.message };
    }
}

async function performPeopleSearch(page, searchUrl, maxPages, emitter) {
    let allResults = [];
    const numPages = maxPages || 10;

    // Fix URL encoding issues with special characters in the URL
    try {
        const url = new URL(searchUrl);
        
        // Clean up the search URL to avoid encoding issues
        for (const [key, value] of url.searchParams.entries()) {
            // Handle array parameters like currentCompany=["1586"]
            if (value.includes('[') && value.includes(']')) {
                try {
                    // Parse and re-encode properly
                    const parsedValue = JSON.parse(value.replace(/'/g, '"'));
                    url.searchParams.set(key, JSON.stringify(parsedValue));
                } catch (e) {
                    console.warn(`Failed to parse parameter ${key}=${value}`, e);
                }
            }
        }
        
        searchUrl = url.toString();
    } catch (e) {
        console.warn("Error parsing search URL, using as-is:", e);
    }

    for (let currentPage = 1; currentPage <= numPages; currentPage++) {
        const pageUrl = currentPage === 1 ? searchUrl : `${searchUrl}${searchUrl.includes('?') ? '&' : '?'}page=${currentPage}`;
        try {
            console.log(`Navigating to: ${pageUrl}`);
            emitter.emit('progress', { status: 'navigating', message: `Navigating to page ${currentPage}`, page: currentPage });
            
            // CHANGED: More resilient page navigation approach
            try {
                // First try with a shorter timeout and domcontentloaded
                await page.goto(pageUrl, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 25000 
                });
            } catch (navError) {
                console.log('Initial navigation timed out, checking if page loaded anyway...');
                // Even if timeout occurred, the page might have loaded enough to work with
                const url = page.url();
                
                if (url.includes('/login') || url.includes('/checkpoint')) {
                    throw new Error('LinkedIn session expired. Please provide new cookies.');
                }
                
                if (!url.includes('linkedin.com/search')) {
                    throw new Error(`Navigation failed, redirected to: ${url}`);
                }
                
                // If we're still on LinkedIn and on a search page, continue
                console.log('Still on LinkedIn search page, continuing despite timeout');
            }
            
            // Additional waiting strategies
            try {
                // Wait for search results container with a shorter timeout
                await page.waitForSelector([
                    '.search-results-container',
                    '.reusable-search__result-container',
                    '.search-results',
                    '.scaffold-layout__list'
                ].join(','), { timeout: 10000 });
            } catch (selectorError) {
                console.log('Search results container not found, will try direct extraction anyway');
            }
            
            // Wait a bit for JavaScript to load more content
            await delay(5000);
            
            // Check if we're redirected to login page (double check)
            const currentUrl = page.url();
            if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
                throw new Error('LinkedIn session expired. Please provide new cookies.');
            }
            
            emitter.emit('progress', { status: 'page_loaded', message: `Page ${currentPage} loaded successfully`, page: currentPage, url: currentUrl });
            
            emitter.emit('progress', { status: 'extracting', message: `Extracting data from page ${currentPage}`, page: currentPage });
            
            const { profiles, hasNoResults, message } = await extractProfileData(page);
            
            // If we have no results, we've reached the end
            if (hasNoResults || profiles.length === 0) {
                emitter.emit('progress', { 
                    status: 'no_more_results', 
                    message: message || `No more results found after page ${currentPage-1}`,
                    page: currentPage
                });
                break;
            }
            
            allResults = [...allResults, ...profiles];
            
            emitter.emit('progress', { 
                status: 'extracted', 
                message: `Extracted ${profiles.length} profiles from page ${currentPage}`,
                page: currentPage,
                count: profiles.length,
                totalSoFar: allResults.length,
                pageResults: profiles
            });
            
            // Random delay between 2-4 seconds to avoid rate limiting
            const randomDelay = 2000 + Math.random() * 2000;
            await delay(randomDelay);
            
        } catch (error) {
            console.error(`Search failed on page ${currentPage}:`, error);
            emitter.emit('error', { 
                status: 'error', 
                message: `Search failed on page ${currentPage}: ${error.message}`, 
                page: currentPage 
            });
            // Don't break the loop on errors, try the next page
            if (currentPage === 1) {
                // Only break if we fail on the first page
                break;
            }
        }
    }
    
    emitter.emit('done', { 
        status: 'done', 
        message: 'Scraping completed', 
        resultsCount: allResults.length,
        results: allResults 
    });
    
    return allResults;
}

function searchLinkedInPeople(searchUrl, cookiesString, maxPages) {
    const emitter = new EventEmitter();

    // Start async operations immediately
    (async () => {
        let browser;
        try {
            // Launch browser with additional options to avoid detection
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-accelerated-2d-canvas",
                    "--no-first-run",
                    "--no-zygote",
                    "--disable-gpu",
                    "--disable-features=IsolateOrigins,site-per-process",
                    // Additional flags to help with LinkedIn access
                    "--disable-web-security",
                    "--disable-features=site-per-process",
                    "--disable-site-isolation-trials",
                ],
                defaultViewport: { width: 1280, height: 800 },
                timeout: 60000,
            });
            
            const page = await browser.newPage();
            
            // ADDED: Disable JavaScript timeouts
            const session = await page.target().createCDPSession();
            await session.send('Emulation.setScriptExecutionDisabled', { value: false });
            await session.send('Runtime.enable');
            
            // Monitor for any navigation errors
            page.on('error', err=> {
                console.error('Page error:', err);
                emitter.emit('error', { status: 'error', message: `Browser page error: ${err.message}` });
            });
            
            // Set a realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            
            // MODIFIED: More targeted request interception
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const resourceType = request.resourceType();
                const url = request.url();
                
                // Only block truly unnecessary resources to ensure page loads properly
                if (
                    // Block heavy media files
                    (resourceType === 'media') || 
                    // Block analytics and tracking
                    url.includes('analytics') ||
                    url.includes('/li/track') ||
                    url.includes('tracking') ||
                    url.includes('/pixel/') ||
                    // Block other non-essential resources
                    url.includes('ads.linkedin.com') ||
                    (resourceType === 'font') ||
                    (url.endsWith('.mp4') || url.endsWith('.avi') || url.endsWith('.flv'))
                ) {
                    request.abort();
                } else {
                    request.continue();
                }
            });

            // Set cookies and validate session
            await setCookies(page, cookiesString, emitter);
            
            // This function will also extract and emit user info
            await validateSession(page, emitter);
            
            // Now perform the search with valid session
            await performPeopleSearch(page, searchUrl, maxPages, emitter);
        } catch (error) {
            console.error("Error in searchLinkedInPeople:", error);
            emitter.emit('error', { status: 'error', message: `Error in searchLinkedInPeople: ${error.message}` });
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (e) {
                    console.error("Error closing browser:", e);
                }
            }
        }
    })();

    return emitter;
}

module.exports = { searchLinkedInPeople };