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

async function extractProfileData(page, onProfileExtracted, options = {}) {
    try {
        // Set defaults
        const settings = {
            maxPages: 100,  // Default max pages to scrape
            currentPage: 1, // Current page being processed
            resultsPerPage: 10, // LinkedIn shows 10 results per page
            ...options
        };
        
        // Wait for search results to load
        await page.waitForSelector('div[data-chameleon-result-urn], .search-results-container', { timeout: 10000 })
            .catch(() => console.log('Search results container not found, continuing anyway'));
            
        // First, determine the total number of search results
        const totalResultsInfo = await getTotalSearchResultsInfo(page);
        console.log(`Total search results: ${totalResultsInfo.totalResults}`);
        
        // Calculate total profiles to extract based on available results and max pages
        const totalProfilesToExtract = calculateTotalProfilesToExtract(
            totalResultsInfo.totalResults,
            settings.maxPages,
            settings.resultsPerPage
        );
        
        // Scroll to load all results on current page
        await autoScroll(page);
        
        // Extract profiles
        const extractedProfiles = await page.evaluate(async () => {
            const profiles = [];
            
            // Updated selectors including the new one from the sample HTML
            const selectors = [
                'li.AdHMbgDGIMDafLgUlAYlroYNrSpshgCHY',  
                'div[data-chameleon-result-urn]',
                'li.reusable-search__result-container',
                '.entity-result',
                '.scaffold-layout__list-item'
            ];
            
            // Find results using the selectors
            let results = [];
            for (const selector of selectors) {
                results = document.querySelectorAll(selector);
                if (results.length > 0) break;
            }
            
            // Process results one by one
            Array.from(results).forEach(result => {
                try {
                    // Name selectors
                    const nameSelectors = [
                        '.mkMastUmWkELhAcaaNYzKMdrjlCmJXnYgZE',
                        '.entity-result__title-text a',
                        '.app-aware-link[data-field="name"]'
                    ];
                    
                    // Title selectors
                    const titleSelectors = [
                        '.mTjnOwtMxHPffEIRcJLDWXTPzwQcTgTqrfveo',
                        '.entity-result__primary-subtitle'
                    ];
                    
                    // Location selectors
                    const locationSelectors = [
                        '.bPSmFcwecOKZVgXSLAwwTDITpxNrJUrPIOE',
                        '.entity-result__secondary-subtitle'
                    ];
                    
                    // URL selectors
                    const urlSelectors = [
                        'a.dgePcUVTyZcmWIuOySyndWdGoBMukAZsio',
                        '.entity-result__title-text a'
                    ];
                    
                    // Extract text/URL helper functions
                    const getText = (parent, selectors) => {
                        for (const selector of selectors) {
                            const element = parent.querySelector(selector);
                            if (element) return element.textContent.trim();
                        }
                        return '';
                    };
                    
                    const getUrl = (parent, selectors) => {
                        for (const selector of selectors) {
                            const element = parent.querySelector(selector);
                            if (element && element.href) return element.href.split('?')[0];
                        }
                        
                        // Fallback: look for any anchor with '/in/' in href
                        const allAnchors = parent.querySelectorAll('a');
                        for (const a of allAnchors) {
                            if (a.href && a.href.includes('/in/')) {
                                return a.href.split('?')[0];
                            }
                        }
                        return '';
                    };
                    
                    // Extract raw data
                    let rawName = getText(result, nameSelectors);
                    const title = getText(result, titleSelectors);
                    const location = getText(result, locationSelectors);
                    const profileUrl = getUrl(result, urlSelectors);
                    const linkedinId = profileUrl.split('/in/')[1] || '';
                    
                    // Only process if we have a name
                    if (rawName) {
                        // Extract connection degree
                        let connectionDegree = null;
                        const degreeMatch = rawName.match(/(\d)(?:st|nd|rd|th)\+?\s+degree\s+connection/i);
                        if (degreeMatch) {
                            connectionDegree = degreeMatch[0].trim();
                        }
                        
                        // Clean the name
                        let name = rawName;
                        
                        // Remove "View [name]'s profile"
                        if (name.includes("View")) {
                            name = name.split("View")[0].trim();
                        }
                        
                        // Remove connection degree from name
                        if (connectionDegree) {
                            name = name.replace(`• ${connectionDegree}`, '')
                                        .replace(connectionDegree, '').trim();
                        }
                        
                        // Clean up all newlines and extra spaces
                        name = name.replace(/\n/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .replace(/•.*$/, '') // Remove anything after bullet point
                                    .trim();
                        
                        // Only add the profile if we have valid data
                        if (name) {
                            profiles.push({
                                name,
                                title,
                                location,
                                profileUrl,
                                linkedinId,
                                connectionDegree: connectionDegree || null
                            });
                        }
                    }
                } catch (e) {
                    console.error('Error parsing profile:', e);
                }
            });
            
            return profiles;
        });
        
        console.log(`Extracted ${extractedProfiles.length} profiles from page ${settings.currentPage}`);
        
        // Stream profiles to client as they're processed
        for (let i = 0; i < extractedProfiles.length; i++) {
            const profile = extractedProfiles[i];
            
            // Calculate how many profiles we've processed so far
            const profilesScraped = (settings.currentPage - 1) * settings.resultsPerPage + (i + 1);
            
            // Calculate progress percentage
            const progress = Math.min(100, Math.floor(100 * profilesScraped / totalProfilesToExtract));
            
            // Stream the profile to the client with progress information
            if (onProfileExtracted) {
                onProfileExtracted({
                    profile,
                    progress,
                    totalProfiles: totalProfilesToExtract,
                    profilesScraped,
                    totalAvailable: totalResultsInfo.totalResults
                });
            }
            
            // Optional small delay between profile emissions to prevent overwhelming the client
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        return {
            profiles: extractedProfiles,
            hasNoResults: extractedProfiles.length === 0,
            totalResults: totalResultsInfo.totalResults,
            progress: Math.min(100, Math.floor(100 * settings.currentPage * settings.resultsPerPage / totalProfilesToExtract))
        };
    } catch (error) {
        console.error("Error extracting profile data:", error);
        return { profiles: [], error: error.message, hasNoResults: true };
    }
}

// Helper function to get total search results info
async function getTotalSearchResultsInfo(page) {
    try {
        return await page.evaluate(() => {
            // Target the specific div containing the results count
            const resultsCountDiv = document.querySelector('div[id="MxSzfgMARBWJrAnGrYlV6w=="] h2.t-14');
            
            // Also try alternative selectors in case LinkedIn changes the ID
            const alternativeSelectors = [
                'h2.pb2.t-black--light.t-14',
                '.search-results__total',
                '.pb2.t-black--light.t-14 div'
            ];
            
            let resultText = '';
            
            // First try the exact div with ID
            if (resultsCountDiv) {
                resultText = resultsCountDiv.textContent.trim();
            } else {
                // Try alternative selectors if the specific ID isn't found
                for (const selector of alternativeSelectors) {
                    const elements = document.querySelectorAll(selector);
                    for (const el of elements) {
                        const text = el.textContent.trim();
                        if (text.includes('result') || text.match(/\d+,?\d*/)) {
                            resultText = text;
                            break;
                        }
                    }
                    if (resultText) break;
                }
            }
            
            // Parse the number from text like "About 13,700,000 results"
            let totalResults = 0;
            if (resultText) {
                const numberMatch = resultText.match(/(?:About\s+)?([,\d]+)(?:\+)?\s+results?/i);
                if (numberMatch) {
                    totalResults = parseInt(numberMatch[1].replace(/,/g, ''), 10);
                }
            }
            
            // LinkedIn caps at 1000 viewable results according to their help page
            const linkedInMaxResults = 1000;
            
            // If the total is more than LinkedIn's limit, cap it
            if (totalResults > linkedInMaxResults) {
                console.log(`LinkedIn shows ${totalResults} results but only allows viewing ${linkedInMaxResults}`);
            }
            
            return { 
                totalResults,
                displayedTotal: totalResults,
                actuallyAvailable: Math.min(totalResults, linkedInMaxResults)
            };
        });
    } catch (error) {
        console.error('Error getting total search results:', error);
        return { totalResults: 0, displayedTotal: 0, actuallyAvailable: 0 };
    }
}

// Calculate total profiles to extract based on requirements
function calculateTotalProfilesToExtract(totalAvailable, maxPages, resultsPerPage) {
    // LinkedIn limits to 1000 results max (100 pages)
    const linkedInMaxResults = 1000;

    // Calculate based on max pages (if specified)
    const maxByPages = maxPages * resultsPerPage;

    // Return the minimum of all constraints
    return Math.min(
        totalAvailable,           // Total available from search
        maxByPages,               // Max based on page limit
        linkedInMaxResults        // LinkedIn's hard limit
    );
}

// Helper function to scroll and load all content
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                
                if (totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
}

// Debug function to understand what's on the page
async function debugPageContent(page, label) {
    try {
        // Take a screenshot
        await page.screenshot({ path: `debug-${label}.png` });
        
        // Count elements matching each selector
        const selectors = [
            'li.AdHMbgDGIMDafLgUlAYlroYNrSpshgCHY',  // New LinkedIn structure
            'div[data-chameleon-result-urn]',
            '.entity-result',
            '.reusable-search__result-container'
        ];
        
        for (const selector of selectors) {
            const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
            console.log(`Selector "${selector}" found ${count} elements`);
        }
        
        // Log the HTML structure of the first result for debugging
        await page.evaluate(() => {
            const result = document.querySelector('div[data-chameleon-result-urn]') || 
                           document.querySelector('.entity-result') ||
                           document.querySelector('li.AdHMbgDGIMDafLgUlAYlroYNrSpshgCHY');
            
            if (result) {
                console.log('First result HTML:', result.outerHTML);
            } else {
                console.log('No results found to debug');
            }
        });
    } catch (error) {
        console.error(`Error during debug (${label}):`, error);
    }
}

// Helper function to send profile data to client through emitter
function sendToClient(emitter, data) {
    // Send the profile data in a 'profile' event
    emitter.emit('profile', data.data.profile);
    
    // Send the progress information in a separate 'progress' event
    emitter.emit('progress', { 
        status: 'extracting_progress', 
        message: `Extracted profile: ${data.data.profile.name} (${data.data.profilesScraped}/${data.data.totalProfiles}) - ${data.data.progress}%`,
        progress: data.data.progress,
        profilesScraped: data.data.profilesScraped,
        totalProfiles: data.data.totalProfiles,
        currentProfile: data.data.profile.name
    });
}

async function performPeopleSearch(page, searchUrl, maxPages, emitter) {
    let allResults = [];
    const numPages = maxPages || 100;

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

            const profiles = [];

            const result = await extractProfileData(
                page, 
                // Callback function that receives each profile as it's extracted
                ({ profile, progress, totalProfiles, profilesScraped }) => {
                    // Add profile to the collection
                    profiles.push(profile);
                    
                    // Send profile and progress to client
                    sendToClient(emitter, {
                        type: 'profile',
                        data: {
                            profile,
                            progress,
                            totalProfiles,
                            profilesScraped
                        }
                    });
                    
                    console.log(`Extracted profile: ${profile.name} (${profilesScraped}/${totalProfiles}) - ${progress}%`);
                },
                {
                    maxPages: maxPages ? parseInt(maxPages) : 100,
                    currentPage: currentPage
                }
            );

            const hasNoResults = result.hasNoResults || profiles.length === 0;
            
            // If we have no results, we've reached the end
            if (hasNoResults) {
                const message = `No more results found after page ${currentPage-1}`;
                emitter.emit('progress', { 
                    status: 'no_more_results', 
                    message: message,
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
                    console.log("Browser closed successfully");
                } catch (e) {
                    console.error("Error closing browser:", e);
                }
            }
        }
    })();

    return emitter;
}

module.exports = { searchLinkedInPeople };