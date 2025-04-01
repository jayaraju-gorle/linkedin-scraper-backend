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

        // Wait for search results to load using multiple possible selectors
        // Updated selectors to match LinkedIn's current HTML structure
        await page.waitForSelector([
            'li.eFNvtmZzTTJeAFaqYEszRmPedngAGKDE', // Current LinkedIn structure (2024)
            'div.XbSDRFUSbGBpQPKjsigDankzSjQsnIyFKHI',
            '.search-results-container',
            'div[data-chameleon-result-urn]',
            '.entity-result',
            '.scaffold-layout__list-item'
        ].join(','), { timeout: 15000 })
        .catch(() => console.log('Search results container not found, continuing anyway'));
            
        // Get total search results info
        const totalResultsInfo = await getTotalSearchResultsInfo(page);
        console.log(`Total search results: ${totalResultsInfo.totalResults}`);
        
        // Calculate total profiles to extract based on available results and max pages
        const totalProfilesToExtract = calculateTotalProfilesToExtract(
            totalResultsInfo.totalResults,
            settings.maxPages,
            settings.resultsPerPage
        );
        
        // Add a debugging step to log the HTML of the first result for inspection
        await page.evaluate(() => {
            const firstResult = document.querySelector('li.eFNvtmZzTTJeAFaqYEszRmPedngAGKDE');
            if (firstResult) {
                console.log('First result HTML structure:', firstResult.outerHTML.substring(0, 500) + '...');
            } else {
                console.log('No results found with the primary selector');
            }
        });
        
        // Scroll to load all results on current page
        await autoScroll(page);
        
        // Extract profiles with the updated HTML structure
        const extractedProfiles = await page.evaluate(async () => {
            const profiles = [];
            
            // Updated selectors for 2024 LinkedIn structure
            const selectors = [
                'li.eFNvtmZzTTJeAFaqYEszRmPedngAGKDE', // Primary current structure
                'div.XbSDRFUSbGBpQPKjsigDankzSjQsnIyFKHI', // Alternative current container
                'li.AdHMbgDGIMDafLgUlAYlroYNrSpshgCHY',  // Previous structure
                'div[data-chameleon-result-urn]',
                'li.reusable-search__result-container',
                '.entity-result',
                '.scaffold-layout__list-item'
            ];
            
            // Find results using the selectors
            let results = [];
            for (const selector of selectors) {
                results = document.querySelectorAll(selector);
                if (results.length > 0) {
                    console.log(`Found ${results.length} results using selector: ${selector}`);
                    break;
                }
            }
            
            // If no results found, try the parent container approach
            if (results.length === 0) {
                console.log("No results found with direct selectors, trying parent containers");
                const containers = document.querySelectorAll([
                    '.search-results-container',
                    '.scaffold-layout__list',
                    '.search-results',
                    'ul.mRINvsmBJFpXGsGCEXfkuAyiKqOjbhxMnshkMw'  // LinkedIn list container
                ].join(','));
                
                if (containers.length > 0) {
                    // Get the first container and look for profile items inside
                    const container = containers[0];
                    // Look for list items that might be profiles
                    results = container.querySelectorAll('li');
                    console.log(`Found ${results.length} results from container approach`);
                }
            }
            
            // Debug information
            console.log(`Total results found: ${results.length}`);
            
            // Process results one by one
            Array.from(results).forEach((result, index) => {
                try {
                    // UPDATED SELECTORS FOR 2024 LINKEDIN STRUCTURE
                    
                    // Name selectors - updated with current class names
                    const nameSelectors = [
                        '.DOgZOenwMQbHzVlKpcdwpsKlJNhiKoDGZrrVVbuM', // Profile link - reliable for latest structure
                        'span.HbdewERYkXYyIwoqJHzosFORfHVGnNOktHA a', 
                        'span.YIPpMkpvyHufpUvGlDJQcQyWbRMeLRUih a',
                        '.entity-result__title-text a',
                        '.app-aware-link[data-field="name"]'
                    ];
                    
                    // Title selectors - updated with current class names
                    const titleSelectors = [
                        'div.wtgFWgtdWSnthiUGZWskuFvgrwFWQdGNoM', // Current LinkedIn structure
                        '.mTjnOwtMxHPffEIRcJLDWXTPzwQcTgTqrfveo',
                        '.entity-result__primary-subtitle'
                    ];
                    
                    // Location selectors - updated with current class names
                    const locationSelectors = [
                        'div.IyewRhKoYbBUgqucsJrXLGsvrdIFFXZdHp', // Current LinkedIn structure
                        '.bPSmFcwecOKZVgXSLAwwTDITpxNrJUrPIOE',
                        '.entity-result__secondary-subtitle'
                    ];
                    
                    // URL selectors for profile links - updated with current class names
                    const urlSelectors = [
                        '.DOgZOenwMQbHzVlKpcdwpsKlJNhiKoDGZrrVVbuM', // Current LinkedIn link class
                        'a.dgePcUVTyZcmWIuOySyndWdGoBMukAZsio',
                        '.entity-result__title-text a'
                    ];
                    
                    // HELPER FUNCTIONS - IMPROVED FOR ACCURACY
                    
                    // Function to extract text from elements matching selectors
                    const getText = (parent, selectors) => {
                        for (const selector of selectors) {
                            const elements = parent.querySelectorAll(selector);
                            for (const element of elements) {
                                const text = element.textContent.trim();
                                // Skip elements that contain "Status is offline" text
                                if (text && text !== '' && !text.includes('Status is offline')) {
                                    return text;
                                }
                            }
                        }
                        return '';
                    };
                    
                    // Function to extract URLs from anchor elements
                    const getUrl = (parent, selectors) => {
                        // First try the specific selectors
                        for (const selector of selectors) {
                            const elements = parent.querySelectorAll(selector);
                            for (const element of elements) {
                                if (element && element.href) {
                                    // Clean the URL by removing query parameters
                                    const url = element.href.split('?')[0];
                                    // Only return profile URLs
                                    if (url.includes('/in/')) {
                                        return url;
                                    }
                                }
                            }
                        }
                        
                        // Fallback: look for any anchor with '/in/' in href
                        const allAnchors = parent.querySelectorAll('a');
                        for (const a of allAnchors) {
                            if (a.href && a.href.includes('/in/')) {
                                return a.href.split('?')[0];
                            }
                        }
                        
                        // If this is a headless profile, use the data-chameleon-result-urn
                        if (parent.getAttribute('data-chameleon-result-urn')?.includes('headless')) {
                            // For headless profiles, we can't get a real URL
                            return 'https://www.linkedin.com/search/results/people/headless';
                        }
                        
                        return '';
                    };
                    
                    // EXTRACTION LOGIC
                    
                    // IMPROVED NAME EXTRACTION FOR 2024 LINKEDIN STRUCTURE
                    
                    // First, explicitly check for the proper name element - this is more targeted
                    const getNameDirectly = (parent) => {
                        // Try direct name extraction methods - focusing on the name link
                        const nameLink = parent.querySelector('.DOgZOenwMQbHzVlKpcdwpsKlJNhiKoDGZrrVVbuM') || 
                                        parent.querySelector('span.HbdewERYkXYyIwoqJHzosFORfHVGnNOktHA a');
                        
                        if (nameLink) {
                            // Make sure we don't get the "Status is offline" text that appears in alt text
                            // Filter out status text and get just the name
                            const linkText = nameLink.textContent.trim();
                            if (linkText && !linkText.includes('Status is') && linkText !== '') {
                                return linkText;
                            }
                        }
                        
                        // Fall back to other methods if direct extraction didn't work
                        return null;
                    };
                    
                    // Get name directly with the dedicated function
                    let rawName = getNameDirectly(result);
                    
                    // If direct method failed, try the general text extraction
                    if (!rawName || rawName === '') {
                        // Skip nameSelectors that contain "Status is offline" text
                        rawName = getText(result, nameSelectors);
                    }
                    
                    // Extract other profile data
                    const title = getText(result, titleSelectors);
                    const location = getText(result, locationSelectors);
                    const profileUrl = getUrl(result, urlSelectors);
                    
                    // Extract LinkedIn ID from profile URL
                    const linkedinId = profileUrl.includes('/in/') ? 
                        profileUrl.split('/in/')[1]?.split('?')[0] || '' : 
                        'headless';
                    
                    // Extract connection degree
                    let connectionDegree = null;
                    const degreeMatch = rawName ? rawName.match(/(\d)(?:st|nd|rd|th)\+?\s+degree\s+connection/i) : null;
                    if (degreeMatch) {
                        connectionDegree = degreeMatch[0].trim();
                    }
                    
                    // Clean the name
                    let name = rawName;
                    
                    // Filter out problematic texts that aren't real names
                    const invalidNames = ['Status is offline', 'Status is', 'LinkedIn', 'View', 'undefined'];
                    const isInvalidName = name && invalidNames.some(invalid => name.includes(invalid));
                    
                    // Handle LinkedIn Member and other anonymous profiles 
                    const isAnonymous = !name || name === 'LinkedIn Member' || name === '' || isInvalidName;
                    
                    if (isAnonymous) {
                        // For anonymous profiles, use a consistent naming pattern
                        name = title ? `Anonymous LinkedIn Member (${title})` : 'Anonymous LinkedIn Member';
                    } else {
                        // Clean name only if it's not anonymous (we already set a clean name for anonymous)
                        
                        // Remove "View [name]'s profile"
                        if (name && name.includes("View")) {
                            name = name.split("View")[0].trim();
                        }
                        
                        // Remove connection degree from name
                        if (connectionDegree && name) {
                            name = name.replace(`• ${connectionDegree}`, '')
                                    .replace(connectionDegree, '').trim();
                        }
                        
                        // Clean up all newlines and extra spaces
                        name = name.replace(/\n/g, ' ')
                               .replace(/\s+/g, ' ')
                               .replace(/•.*$/, '') // Remove anything after bullet point
                               .trim();
                    }
                    
                    // DEBUG: Log the extraction attempt for this profile
                    console.log(`Extraction attempt ${index+1}: ${name || 'Unnamed'} / ${title || 'No title'} / ${location || 'No location'}`);
                    
                    // Only add the profile if we have at least one piece of valid data
                    if (title || location || profileUrl) {
                        profiles.push({
                            name: name || 'Anonymous LinkedIn Member',
                            title: title || 'No title listed',
                            location: location || 'No location listed',
                            profileUrl: profileUrl || '',
                            linkedinId: linkedinId || '',
                            connectionDegree: connectionDegree || null,
                            isAnonymous: isAnonymous
                        });
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
            // Updated selectors for result count in 2024 LinkedIn structure
            const selectors = [
                // Current LinkedIn structure 2024
                'h2.mUkRIIczmilxfKxF3dXujMgFXZ9fFrQXcSW',
                'div.Iqb2SRNaOlKgFzuHjxk2xaR7RJSQGE2K h2',
                // Previous selectors as fallback
                'div[id="MxSzfgMARBWJrAnGrYlV6w=="] h2.t-14',
                'h2.pb2.t-black--light.t-14',
                '.search-results__total',
                '.pb2.t-black--light.t-14 div',
                // Most generic selector as last resort
                'h2.t-14'
            ];
            
            let resultText = '';
            
            // Try each selector until we find a matching element with result text
            for (const selector of selectors) {
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
            
            // If no element found with the specific selectors, try a more general approach
            if (!resultText) {
                // Look for any heading that might contain result count
                const headings = document.querySelectorAll('h1, h2, h3');
                for (const heading of headings) {
                    const text = heading.textContent.trim();
                    if (text.includes('result') && text.match(/\d+/)) {
                        resultText = text;
                        break;
                    }
                }
            }
            
            // Parse the number from text like "About 13,700,000 results"
            let totalResults = 0;
            if (resultText) {
                const numberMatch = resultText.match(/(?:About\s+)?([,\d]+)(?:\+)?\s+results?/i);
                if (numberMatch) {
                    totalResults = parseInt(numberMatch[1].replace(/,/g, ''), 10);
                } else {
                    // Try to find any number in the text
                    const anyNumber = resultText.match(/(\d[\d,]+)/);
                    if (anyNumber) {
                        totalResults = parseInt(anyNumber[1].replace(/,/g, ''), 10);
                    }
                }
            }
            
            // LinkedIn caps at 1000 viewable results according to their help page
            const linkedInMaxResults = 1000;
            
            // If the total is more than LinkedIn's limit, cap it
            if (totalResults > linkedInMaxResults) {
                console.log(`LinkedIn shows ${totalResults} results but only allows viewing ${linkedInMaxResults}`);
            }
            
            return { 
                totalResults: totalResults || 10, // Default to 10 if we couldn't find the count
                displayedTotal: totalResults,
                actuallyAvailable: Math.min(totalResults || 10, linkedInMaxResults)
            };
        });
    } catch (error) {
        console.error('Error getting total search results:', error);
        return { totalResults: 10, displayedTotal: 10, actuallyAvailable: 10 };
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
            const scrollInterval = 100; // Time between scrolls
            let scrollAttempts = 0;
            const maxScrollAttempts = 30; // Limit the number of scroll attempts
            
            const timer = setInterval(() => {
                const prevHeight = totalHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                scrollAttempts++;
                
                // Check if we've reached the bottom or max attempts
                if ((totalHeight >= document.body.scrollHeight) || 
                    (scrollAttempts >= maxScrollAttempts)) {
                    clearInterval(timer);
                    resolve();
                }
            }, scrollInterval);
        });
    });
    // Additional waiting time after scrolling
    await new Promise(resolve => setTimeout(resolve, 2000));
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
            
            // IMPROVED: More resilient page navigation approach
            try {
                // First try with a shorter timeout and domcontentloaded
                await page.goto(pageUrl, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 30000 
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
            
            // Additional waiting strategies for new LinkedIn structure
            try {
                // Wait for search results container with various selectors
                await page.waitForSelector([
                    // New LinkedIn structure selectors 2023/2024
                    'li.eFNvtmZzTTJeAFaqYEszRmPedngAGKDE',
                    'div.XbSDRFUSbGBpQPKjsigDankzSjQsnIyFKHI',
                    'ul.mRINvsmBJFpXGsGCEXfkuAyiKqOjbhxMnshkMw',
                    // Previous selectors as fallback
                    '.search-results-container',
                    '.reusable-search__result-container',
                    '.search-results',
                    '.scaffold-layout__list'
                ].join(','), { timeout: 15000 });
                
                console.log('Search results container found');
            } catch (selectorError) {
                console.log('Search results container not found, will try direct extraction anyway:', selectorError);
                
                // Add debug screenshot
                await page.screenshot({ path: `debug-search-page-${currentPage}.png` });
                
                // Print the page title to help diagnose issues
                const pageTitle = await page.title();
                console.log(`Current page title: ${pageTitle}`);
                
                // Check if we're on a login page
                const isLoginPage = await page.evaluate(() => {
                    return document.body.textContent.includes('Sign in') || 
                           document.body.textContent.includes('Log in') ||
                           document.body.textContent.includes('Sign In') ||
                           document.body.textContent.includes('Log In');
                });
                
                if (isLoginPage) {
                    throw new Error('Redirected to login page. LinkedIn session may have expired.');
                }
            }
            
            // Wait a bit longer for JavaScript to load more content
            await delay(7000);
            
            // Check if we're redirected to login page (double check)
            const currentUrl = page.url();
            if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
                throw new Error('LinkedIn session expired. Please provide new cookies.');
            }
            
            emitter.emit('progress', { status: 'page_loaded', message: `Page ${currentPage} loaded successfully`, page: currentPage, url: currentUrl });
            
            // Scroll to ensure all content is loaded
            await autoScroll(page);
            
            // Wait a bit more after scrolling
            await delay(3000);
            
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
                // IMPROVED: Add debugging to understand why no results were found
                console.log(`No results found on page ${currentPage}, taking screenshot for debugging`);
                await page.screenshot({ path: `no-results-page-${currentPage}.png` });
                
                // Check the current page HTML for common patterns
                const pageHtml = await page.content();
                console.log(`Page HTML length: ${pageHtml.length} characters`);
                
                // Log whether certain key elements are present
                const hasElements = await page.evaluate(() => {
                    return {
                        hasNewListItems: document.querySelectorAll('li.eFNvtmZzTTJeAFaqYEszRmPedngAGKDE').length,
                        hasOldListItems: document.querySelectorAll('li.reusable-search__result-container').length,
                        hasChameleonResults: document.querySelectorAll('div[data-chameleon-result-urn]').length,
                        hasAnyListItems: document.querySelectorAll('li').length,
                        hasSearchContainer: document.querySelectorAll('.search-results-container').length,
                        hasNoResultsMessage: document.body.textContent.includes('No results found')
                    };
                });
                console.log('Page element presence check:', hasElements);
                
                const message = `No more results found after page ${currentPage-1}`;
                emitter.emit('progress', { 
                    status: 'no_more_results', 
                    message: message,
                    page: currentPage,
                    debugInfo: hasElements
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
            
            // Random delay between 3-6 seconds to avoid rate limiting
            const randomDelay = 3000 + Math.random() * 3000;
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