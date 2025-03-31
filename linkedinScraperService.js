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
        const hasJsessionID = cookies.some(c => c.name === 'JSESSIONID');
        
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

async function extractProfileData(page) {
    try {
        return await page.evaluate(() => {
            const profiles = [];
            const results = document.querySelectorAll('.reusable-search__result-container');
            
            // If no results found, check for specific messages
            if (results.length === 0) {
                // Check if there's a "no results" message
                const noResultsMsg = document.querySelector('.search-reusables__no-results-message');
                if (noResultsMsg) {
                    return { 
                        profiles: [],
                        message: noResultsMsg.textContent.trim(),
                        hasNoResults: true
                    };
                }
            }
            
            results.forEach(result => {
                try {
                    const nameElement = result.querySelector('.entity-result__title-text a');
                    const titleElement = result.querySelector('.entity-result__primary-subtitle');
                    const locationElement = result.querySelector('.entity-result__secondary-subtitle');
                    const profileUrl = nameElement?.href?.split('?')[0] || '';
                    
                    profiles.push({
                        name: nameElement?.textContent?.trim() || '',
                        title: titleElement?.textContent?.trim() || '',
                        location: locationElement?.textContent?.trim() || '',
                        profileUrl: profileUrl,
                        linkedinId: profileUrl.split('/in/')[1] || ''
                    });
                } catch (e) {
                    console.error('Error parsing profile:', e);
                }
            });
            
            return { 
                profiles,
                hasNoResults: false
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
            
            // Use a shorter timeout and more reliable load criteria
            await page.goto(pageUrl, { 
                waitUntil: 'domcontentloaded', 
                timeout: 30000 
            });
            
            // Wait for search results or error message with a shorter timeout
            await Promise.race([
                page.waitForSelector('.reusable-search__result-container', { timeout: 10000 }),
                page.waitForSelector('.search-reusables__no-results-message', { timeout: 10000 })
            ]).catch(() => {
                console.log('Could not find results or no-results message');
            });
            
            // Check if we're redirected to login page
            const currentUrl = page.url();
            if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
                throw new Error('LinkedIn session expired. Please provide new cookies.');
            }
            
            emitter.emit('progress', { status: 'page_loaded', message: `Page ${currentPage} loaded successfully`, page: currentPage, url: currentUrl });

            // Small delay to ensure page is fully rendered
            await delay(1000);
            
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
            
            // Monitor for any navigation errors
            page.on('error', err=> {
                console.error('Page error:', err);
                emitter.emit('error', { status: 'error', message: `Browser page error: ${err.message}` });
            });
            
            // Set a realistic user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            
            // Modify request interception to be more selective - only block unnecessary resources
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const resourceType = request.resourceType();
                const url = request.url();
                
                if (
                    // Block resource-heavy content but allow essential LinkedIn functionality
                    (resourceType === 'image' && !url.includes('profile-displayphoto')) || 
                    resourceType === 'media' || 
                    resourceType === 'font' ||
                    url.includes('ads') ||
                    url.includes('tracking') ||
                    url.includes('analytics')
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