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
    
    // Try to load LinkedIn feed
    await page.goto('https://www.linkedin.com/feed/', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    // Check current URL for redirects to login
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
      throw new Error('LinkedIn session expired or invalid. Please provide valid cookies.');
    }
    
    // Use generic indicators to check login state
    const isLoggedIn = await page.evaluate(() => {
      // Generic approach: look for navigation elements that only exist when logged in
      const hasGlobalNav = !!document.querySelector('header');
      
      // Check for feed elements
      const hasFeed = !!document.querySelector('div[data-test-id="feed-container"]') ||
                     !!document.querySelector('div[class*="feed-container"]');
      
      // Check for profile-related elements (avoid relying on specific class names)
      const hasProfileElements = !!document.querySelector('a[href*="/in/"]') ||
                                !!document.querySelector('a[href*="/profile/"]');
                                
      // Check for login-specific elements that indicate we're NOT logged in
      const hasLoginForm = !!document.querySelector('form[action*="login"]') ||
                          !!document.querySelector('input[name="session_key"]');
                          
      // Check page content for logged-out indicators
      const pageContent = document.body.textContent;
      const hasLoggedOutText = pageContent.includes('Join now') && 
                              pageContent.includes('Sign in') &&
                              !pageContent.includes('Feed');
      
      return (hasGlobalNav || hasFeed || hasProfileElements) && !hasLoginForm && !hasLoggedOutText;
    });
    
    if (!isLoggedIn) {
      throw new Error('Not logged in to LinkedIn. Please provide valid cookies.');
    }
    
    // Get user info with generic selectors
    const userInfo = await page.evaluate(() => {
      // Find display name using various generic approaches
      const findDisplayName = () => {
        // Try profile images with alt text
        const profileImages = document.querySelectorAll('img[class*="profile"]');
        for (const img of profileImages) {
          if (img.alt && img.alt.length > 3 && !img.alt.includes('LinkedIn')) {
            return img.alt;
          }
        }
        
        // Try profile links
        const profileLinks = document.querySelectorAll('a[href*="/in/"]');
        for (const link of profileLinks) {
          if (link.textContent && link.textContent.trim().length > 3 && 
              !link.textContent.includes('LinkedIn')) {
            return link.textContent.trim();
          }
        }
        
        // Look for common profile container patterns
        const containers = document.querySelectorAll('div[class*="profile"], div[class*="identity"]');
        for (const container of containers) {
          if (container.textContent && container.textContent.length > 3) {
            const text = container.textContent.trim().split('\n')[0];
            if (text && text.length > 3 && !text.includes('LinkedIn')) {
              return text;
            }
          }
        }
        
        return 'LinkedIn User';
      };
      
      // Find profile URL
      const findProfileUrl = () => {
        const profileLinks = document.querySelectorAll('a[href*="/in/"]');
        for (const link of profileLinks) {
          // Ensure it's a profile link, not a company or post
          if (link.href && link.href.includes('/in/') && 
              !link.href.includes('/company/') && 
              !link.href.includes('/post/')) {
            return link.href.split('?')[0]; // Remove query parameters
          }
        }
        return '';
      };
      
      return {
        displayName: findDisplayName(),
        profileUrl: findProfileUrl(),
        loggedIn: true
      };
    });
    
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

// Improved helper function for cleaning text content
function cleanText(text) {
    if (!text) return '';
    
    return text
        .replace(/\s+/g, ' ')        // Replace multiple spaces, tabs, newlines with a single space
        .replace(/^\s+|\s+$/g, '')   // Trim whitespace from start and end
        .replace(/\n/g, ' ')         // Replace any remaining newlines with spaces
        .replace(/\t/g, ' ')         // Replace any tabs with spaces
        .replace(/\s{2,}/g, ' ')     // Make sure there are no double spaces left
        .trim();                     // Final trim to ensure no leading/trailing spaces
}

// Extract relevant data from title and position
function parsePositionAndCompany(title) {
    if (!title) return { position: '', company: '' };
    
    const cleanTitle = cleanText(title);
    
    // Check for pattern "Position at Company"
    if (cleanTitle.includes(' at ')) {
        const parts = cleanTitle.split(' at ');
        const position = parts[0].trim();
        const company = parts.slice(1).join(' at ').trim();
        return { position, company };
    }
    
    // Check for pattern "Position - Company"
    if (cleanTitle.includes(' - ')) {
        const parts = cleanTitle.split(' - ');
        const position = parts[0].trim();
        const company = parts.slice(1).join(' - ').trim();
        return { position, company };
    }
    
    // Check for pattern "Position | Company"
    if (cleanTitle.includes(' | ')) {
        const parts = cleanTitle.split(' | ');
        const position = parts[0].trim();
        const company = parts.slice(1).join(' | ').trim();
        return { position, company };
    }
    
    // If no pattern found, the whole thing is likely the position
    return { position: cleanTitle, company: '' };
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

    // Wait for search results to load using generic selectors
    const containerSelectors = [
      'ul[role="list"]',
      'div[class*="search-results"]',
      'div[class*="results-container"]',
      'main div > ul',
      '.scaffold-layout__list',
      'div[class*="marvel-srp"]'
    ];
    
    await page.waitForSelector(containerSelectors.join(','), { timeout: 15000 })
      .catch(() => console.log('Search results container not found with standard selectors, continuing anyway'));
            
    // Get total search results info
    const totalResultsInfo = await getTotalSearchResultsInfo(page);
    console.log(`Total search results: ${totalResultsInfo.totalResults}`);
    
    // Calculate total profiles to extract based on available results and max pages
    const totalProfilesToExtract = calculateTotalProfilesToExtract(
      totalResultsInfo.totalResults,
      settings.maxPages,
      settings.resultsPerPage
    );
    
    // Scroll to load all results on current page
    await humanLikeScroll(page);
    
    // Extract profiles with improved selectors
    const extractedProfiles = await page.evaluate(() => {
      const profiles = [];
      
      // Generic selectors for result items
      const resultsSelectors = [
        'ul[role="list"] > li', // Role-based list items
        'div[class*="search-results"] > div', // Results container children
        'div[data-chameleon-result-urn]', // Data attribute selector
        'div[class*="result-container"]', // Partial class match
        '.entity-result',
        'li', // Most generic fallback
        'div[class*="srp"] li' // Search results page list items
      ];
      
      // Find results using the selectors
      let results = [];
      for (const selector of resultsSelectors) {
        results = document.querySelectorAll(selector);
        if (results.length > 0) {
          console.log(`Found ${results.length} results using selector: ${selector}`);
          break;
        }
      }
      
      // If no results found with selectors, try the parent container approach
      if (results.length === 0) {
        console.log("No results found with direct selectors, trying parent containers");
        
        // Look for any list or content container
        const containers = document.querySelectorAll([
          'div[class*="search-results"]',
          'div[class*="results-container"]',
          'ul[role="list"]',
          'div[role="list"]',
          'div[class*="srp"]',
          'main > div > ul'
        ].join(','));
        
        if (containers.length > 0) {
          const container = containers[0];
          // Look for list items or direct children that might be results
          results = container.querySelectorAll('li') || container.querySelectorAll(':scope > div');
          console.log(`Found ${results.length} results from container approach`);
        }
      }
      
      // Helper function to extract text content safely
      const extractTextContent = (parent, selector, fallbackSelector = null) => {
        try {
          // Try primary selector
          const element = parent.querySelector(selector);
          if (element && element.textContent) {
            return element.textContent.trim();
          }
          
          // Try fallback if provided
          if (fallbackSelector) {
            const fallbackElement = parent.querySelector(fallbackSelector);
            if (fallbackElement && fallbackElement.textContent) {
              return fallbackElement.textContent.trim();
            }
          }
          
          return "";
        } catch (e) {
          console.error("Error extracting text:", e);
          return "";
        }
      };
      
      // IMPROVED: Extract profile name more accurately
      const extractProfileName = (parent) => {
        // Look for the main profile name with specific selectors
        const nameSelectors = [
          // Target exact LinkedIn Member text without additional content
          'span.t-16 a', 
          'a[href*="/in/"] span',
          '.entity-result__title-text a span',
          '.entity-result__title-text a',
          'span[class*="title"] a',
          '.app-aware-link span',
          '.app-aware-link'
        ];
        
        for (const selector of nameSelectors) {
          const nameElement = parent.querySelector(selector);
          if (nameElement && nameElement.textContent.trim()) {
            // Clean up the name
            let name = nameElement.textContent.trim();
            
            // Remove connection degree info if present
            name = name.replace(/\s*•\s*\d(?:st|nd|rd|th)\+? degree(?: connection)?/i, '').trim();
            
            // Check if this is "LinkedIn Member" and return just that without additional text
            if (name.includes('LinkedIn Member')) {
              return 'LinkedIn Member';
            }
            
            return name;
          }
        }
        
        // If we couldn't find the name, return a default
        return 'LinkedIn Member';
      };
      
      // IMPROVED: Extract profile image
      const extractProfileImage = (parent) => {
        // Look for image elements
        const imgSelectors = [
          'img[class*="presence-entity__image"]',
          'img[class*="EntityPhoto-circle"]',
          'img[class*="profile"]',
          '.presence-entity img',
          '.ivm-image-view-model img',
          '.avatar-image'
        ];
        
        for (const selector of imgSelectors) {
          const imgElement = parent.querySelector(selector);
          if (imgElement && imgElement.src) {
            return {
              src: imgElement.src,
              alt: imgElement.alt || '',
              width: imgElement.width || 100,
              height: imgElement.height || 100
            };
          }
        }
        
        return null;
      };
      
      // Get job title more precisely
      const extractJobTitle = (parent) => {
        const titleSelectors = [
          '.entity-result__primary-subtitle',
          'div[class*="primary-subtitle"]',
          'div.t-14.t-black.t-normal',
          'div[class*="subtitle"]',
          '.search-result__subtitle'
        ];
        
        for (const selector of titleSelectors) {
          const element = parent.querySelector(selector);
          if (element && element.textContent.trim()) {
            return element.textContent.trim();
          }
        }
        
        return '';
      };
      
      // Get location more precisely
      const extractLocation = (parent) => {
        const locationSelectors = [
          '.entity-result__secondary-subtitle',
          'div[class*="secondary-subtitle"]',
          'div.t-14.t-normal',
          '.search-result__location'
        ];
        
        for (const selector of locationSelectors) {
          const element = parent.querySelector(selector);
          if (element && element.textContent.trim()) {
            return element.textContent.trim();
          }
        }
        
        return '';
      };
      
      // Generic profile URL extraction
      const extractProfileUrl = (parent) => {
        // Look for LinkedIn profile links
        const links = parent.querySelectorAll('a');
        for (const link of links) {
          if (link.href && link.href.includes('/in/')) {
            return link.href.split('?')[0]; // Remove query parameters
          }
        }
        
        // Look for headless profile indicator
        if (parent.getAttribute('data-chameleon-result-urn')?.includes('headless')) {
          return 'https://www.linkedin.com/search/results/people/headless';
        }
        
        return '';
      };
      
      // Extract connection degree
      const extractConnectionDegree = (parent) => {
        // Try to find the connection info through the profile text
        const text = parent.textContent;
        const degreeMatch = text.match(/(\d)(?:st|nd|rd|th)\+?\s+degree(?:\s+connection)?/i);
        if (degreeMatch) {
          return degreeMatch[0].trim();
        }
        return '';
      };
      
      // Process each result
      Array.from(results).forEach((result, index) => {
        try {
          // Extract profile information
          const name = extractProfileName(result);
          const title = extractJobTitle(result);
          const location = extractLocation(result);
          const profileUrl = extractProfileUrl(result);
          const connectionDegree = extractConnectionDegree(result);
          const profileImage = extractProfileImage(result);
          
          // Determine if this is an anonymous/headless profile
          const isAnonymous = name === 'LinkedIn Member';
          
          // Extract LinkedIn ID from profile URL
          const linkedinId = profileUrl.includes('/in/') ? 
            profileUrl.split('/in/')[1]?.split('/')[0] || '' : 
            'headless';
          
          // Only add profiles that have at least one piece of useful data
          if (title || location || profileUrl) {
            profiles.push({
              name: name || 'LinkedIn Member',
              title: title || 'No title listed',
              location: location || 'No location listed',
              profileUrl: profileUrl || '',
              linkedinId: linkedinId || '',
              connectionDegree: connectionDegree || '',
              isAnonymous: isAnonymous,
              profileImage: profileImage
            });
          }
        } catch (e) {
          console.error('Error parsing profile:', e);
        }
      });
      
      return profiles;
    });
    
    console.log(`Extracted ${extractedProfiles.length} profiles from page ${settings.currentPage}`);
    
    // Stream profiles to client as they're processed, with FIXED progress calculation
    for (let i = 0; i < extractedProfiles.length; i++) {
      const profile = extractedProfiles[i];
      
      // Calculate absolute profile number across all pages
      const profilesScraped = (settings.currentPage - 1) * settings.resultsPerPage + (i + 1);
      
      // Calculate progress percentage based on total profiles to extract
      const progress = Math.min(100, Math.floor(100 * profilesScraped / totalProfilesToExtract));
      
      // Stream the profile to the client with progress information
      if (onProfileExtracted) {
        onProfileExtracted({
          profile,
          progress,
          totalProfiles: totalProfilesToExtract, // This is the FIXED total we use for progress
          profilesScraped,
          totalAvailable: totalResultsInfo.totalResults
        });
      }
      
      // Optional small delay between profile emissions
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
      // Function to find results count text using generic approaches
      const findResultsText = () => {
        // Approach 1: Look for headings with "results" text
        const headings = document.querySelectorAll('h1, h2, h3, h4');
        for (const heading of headings) {
          const text = heading.textContent.trim();
          if (text.includes('result') && text.match(/\d+/)) {
            return text;
          }
        }
        
        // Approach 2: Look for elements with certain text patterns
        const resultsPattern = /([,\d]+)\s*results?/i;
        const allElements = document.querySelectorAll('div, p, span');
        for (const el of allElements) {
          const text = el.textContent.trim();
          if (resultsPattern.test(text) && text.length < 100) {
            return text;
          }
        }
        
        // Approach 3: Look for any element with "about X results" text
        const aboutPattern = /about\s+([,\d]+)\s+results?/i;
        for (const el of allElements) {
          const text = el.textContent.trim();
          if (aboutPattern.test(text)) {
            return text;
          }
        }
        
        // Approach 4: Scan the entire page content for results patterns
        const bodyText = document.body.textContent;
        const bodyMatch = bodyText.match(/(\d[\d,]*)\s*results?/i);
        if (bodyMatch) {
          return `About ${bodyMatch[1]} results`;
        }
        
        // Fallback: check for common phrases in different formats
        if (bodyText.includes('results')) {
          const nearbyNumber = bodyText.match(/(\d[\d,]*)\s*(?:of|results?|profiles?)/i);
          if (nearbyNumber) {
            return `About ${nearbyNumber[1]} results`;
          }
        }
        
        return ''; // No results text found
      };
      
      // Get the results text
      const resultText = findResultsText();
      
      // Parse the number from text
      let totalResults = 0;
      if (resultText) {
        // Try to find any number followed by "results"
        const numberMatch = resultText.match(/([,\d]+)(?:\+)?\s+results?/i);
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
      
      // LinkedIn caps at 1000 viewable results
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

// More human-like scrolling function with random behavior
async function humanLikeScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            // Get the total scrollable height
            const totalHeight = document.body.scrollHeight;
            let scrolledHeight = 0;
            const viewportHeight = window.innerHeight;
            
            // Random scroll variables
            const scrollJitter = () => Math.floor(Math.random() * 120) - 60; // +/- 60px
            const baseScrollAmount = 300; // Base scroll amount
            const randomScrollAmount = () => baseScrollAmount + scrollJitter();
            
            // Random pauses
            const minPause = 50;  // Minimum pause in ms
            const maxPause = 350; // Maximum pause in ms
            const randomPause = () => minPause + Math.floor(Math.random() * (maxPause - minPause));
            
            // Occasionally pause for longer to simulate user reading
            const shouldPauseLonger = () => Math.random() < 0.2; // 20% chance
            const longPauseDuration = () => 1000 + Math.floor(Math.random() * 1500); // 1-2.5 seconds
            
            // Occasionally scroll up slightly as humans do
            const shouldScrollUp = () => Math.random() < 0.1; // 10% chance
            const upScrollAmount = () => Math.floor(Math.random() * 100) + 50; // 50-150px up
            
            const scroll = () => {
                // Sometimes scroll up slightly
                if (shouldScrollUp() && scrolledHeight > viewportHeight) {
                    const upAmount = upScrollAmount();
                    window.scrollBy(0, -upAmount);
                    scrolledHeight = Math.max(0, scrolledHeight - upAmount);
                    console.log(`Scrolled up ${upAmount}px`);
                } else {
                    // Normal down scrolling
                    const scrollAmount = randomScrollAmount();
                    window.scrollBy(0, scrollAmount);
                    scrolledHeight += scrollAmount;
                    console.log(`Scrolled down ${scrollAmount}px`);
                }
                
                // Check if we've reached the bottom or scrolled enough
                if (scrolledHeight >= totalHeight || window.innerHeight + window.scrollY >= document.body.scrollHeight) {
                    clearTimeout(scrollTimeout);
                    resolve();
                    return;
                }
                
                // Determine next pause duration
                let nextPause;
                if (shouldPauseLonger()) {
                    nextPause = longPauseDuration();
                    console.log(`Taking a longer pause: ${nextPause}ms`);
                } else {
                    nextPause = randomPause();
                }
                
                // Schedule next scroll
                scrollTimeout = setTimeout(scroll, nextPause);
            };
            
            // Initial delay before scrolling
            let scrollTimeout = setTimeout(scroll, randomPause());
        });
    });
    
    // Wait a variable amount of time after scrolling completes
    const afterScrollDelay = 1000 + Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, afterScrollDelay));
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
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;

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
      
      // Special handling for problematic pages - LinkedIn often blocks after page 6
      if (currentPage >= 6) {
        console.log(`Approaching high-risk page ${currentPage}, adding extra precautions...`);
        
        // Take a screenshot for debugging
        await page.screenshot({ path: `pre-navigation-page-${currentPage}.png` });
        
        // Add some random interactions before navigation
        await page.evaluate(() => {
          // Scroll slightly in random directions to appear more human-like
          window.scrollBy(0, -100 - Math.random() * 200);
          
          // Small pause in JS execution
          const start = Date.now();
          while (Date.now() - start < 500) { /* Small deliberate pause */ }
          
          // Scroll back
          window.scrollBy(0, 150 + Math.random() * 100);
        });
        
        // Wait a bit after the interactions
        await delay(2000 + Math.random() * 1000);
        
        try {
          // Use a longer timeout for problem pages
          console.log(`Navigating to page ${currentPage} with extended timeout...`);
          await page.goto(pageUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 // 60 second timeout for problem pages
          });
        } catch (navError) {
          console.log(`Initial navigation attempt for page ${currentPage} failed:`, navError.message);
          
          // Take another screenshot to see what happened
          await page.screenshot({ path: `failed-navigation-page-${currentPage}.png` });
          
          // Try an alternative navigation approach
          console.log(`Trying alternative navigation for page ${currentPage}...`);
          try {
            // Try clicking "Next" button instead of direct navigation
            const hasNextButton = await page.evaluate(() => {
              const nextButtons = Array.from(document.querySelectorAll('button, a'))
                .filter(el => el.textContent.includes('Next') || 
                             el.textContent.includes('next') ||
                             el.getAttribute('aria-label')?.includes('Next'));
                             
              if (nextButtons.length > 0) {
                nextButtons[0].click();
                return true;
              }
              return false;
            });
            
            if (hasNextButton) {
              // Wait for navigation to complete
              await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
                .catch(e => console.log('Navigation timeout after clicking Next, continuing anyway'));
            } else {
              // If no Next button, try direct navigation again with minimal wait
              await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                .catch(e => console.log('Retried navigation failed, will check page state anyway'));
            }
          } catch (retryError) {
            console.log(`Alternative navigation also failed:`, retryError.message);
          }
        }
        
        // Verify we're on a search results page regardless of how we got here
        const isSearchPage = await page.evaluate(() => {
          return document.body.textContent.includes('results') || 
                 document.querySelector('div[class*="search-results"]') !== null ||
                 document.querySelector('ul[role="list"]') !== null;
        });
        
        if (!isSearchPage) {
          console.error(`Page ${currentPage} does not appear to be a search results page`);
          await page.screenshot({ path: `not-search-page-${currentPage}.png` });
          throw new Error(`Failed to navigate to search results page ${currentPage}`);
        }
        
      } else {
        // Normal navigation for early pages
        await page.goto(pageUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
      }
      
      // IMPROVED: Check for valid navigation post-load
      const currentUrl = page.url();
      
      if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
        throw new Error('LinkedIn session expired. Please provide new cookies.');
      }
      
      // Check for rate limiting or blocks
      const isBlocked = await page.evaluate(() => {
        return document.body.textContent.includes('unusual activity') || 
              document.body.textContent.includes('verify you\'re not a robot') ||
              document.body.textContent.includes('security check') ||
              document.body.textContent.includes('CAPTCHA');
      });
      
      if (isBlocked) {
        await page.screenshot({ path: 'rate-limited.png' });
        throw new Error('LinkedIn has detected unusual activity and blocked access. Try again later with different cookies.');
      }
      
      emitter.emit('progress', { status: 'page_loaded', message: `Page ${currentPage} loaded successfully`, page: currentPage, url: currentUrl });
      
      // Wait for search results container with various selectors
      try {
        // Wait for search results container with generic selectors
        const containerSelectors = [
          'ul[role="list"]',
          'div[class*="search-results"]',
          'div[class*="results-container"]',
          'main div > ul',
          '.scaffold-layout__list',
          'div[class*="marvel-srp"]'
        ];
        
        await page.waitForSelector(containerSelectors.join(','), { timeout: 15000 });
        console.log('Search results container found');
      } catch (selectorError) {
        console.log('Search results container not found with standard selectors, continuing anyway:', selectorError);
        
        // Check for common issues
        const pageState = await page.evaluate(() => {
          return {
            title: document.title,
            hasResults: document.body.textContent.includes('results'),
            hasNoResultsMessage: document.body.textContent.includes('No results found'),
            bodyTextSample: document.body.textContent.substring(0, 200)
          };
        });
        
        console.log('Page state check:', pageState);
        
        if (pageState.hasNoResultsMessage) {
          console.log('Explicit "No results found" message detected');
          emitter.emit('progress', { 
            status: 'no_more_results', 
            message: `No more results found after page ${currentPage-1}`,
            page: currentPage
          });
          break;
        }
      }
      
      // Wait longer for JavaScript to load more content
      await delay(7000);
      
      // Scroll to ensure all content is loaded
      await humanLikeScroll(page);
      
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
          emitter.emit('profile', profile);
          
          // Send progress information
          emitter.emit('progress', { 
            status: 'extracting_progress', 
            message: `Extracted profile: ${profile.name} (${profilesScraped}/${totalProfiles}) - ${progress}%`,
            progress: progress,
            profilesScraped: profilesScraped,
            totalProfiles: totalProfiles,
            currentProfile: profile.name
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
        // Take a screenshot for debugging
        await page.screenshot({ path: `no-results-page-${currentPage}.png` });
        
        // Check for explicit "no results" message
        const hasNoResultsMessage = await page.evaluate(() => {
          return document.body.textContent.includes('No results found') || 
                 document.body.textContent.includes('couldn\'t find any results');
        });
        
        const message = hasNoResultsMessage 
          ? `LinkedIn reports no more results found` 
          : `No more results found after page ${currentPage-1}`;
        
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
      
      // Reset consecutive errors counter on success
      consecutiveErrors = 0;
      
      // Calculate progressive delay between pages
      const calculateProgressiveDelay = (pageNum) => {
        // Base delay for early pages
        const baseDelay = 5000;
        
        // Additional delay per page
        const additionalDelay = 1000;
        
        // Extra delay for high-risk pages (typically pages 7-10)
        const highRiskPages = [7, 8, 9, 10];
        const highRiskBonus = highRiskPages.includes(pageNum) ? 5000 : 0;
        
        // Add randomness
        const randomFactor = Math.random() * 3000;
        
        // Calculate total delay (increases with page number)
        return baseDelay + (pageNum * additionalDelay) + highRiskBonus + randomFactor;
      };
      
      const waitTime = calculateProgressiveDelay(currentPage);
      console.log(`Waiting ${Math.round(waitTime)}ms before next page...`);
      await delay(waitTime);
      
    } catch (error) {
      console.error(`Search failed on page ${currentPage}:`, error);
      await page.screenshot({ path: `error-page-${currentPage}.png` });
      
      consecutiveErrors++;
      
      // If we have too many consecutive errors, abort the search
      if (consecutiveErrors >= maxConsecutiveErrors) {
        emitter.emit('error', { 
          status: 'error', 
          message: `Aborting search after ${maxConsecutiveErrors} consecutive errors. Last error: ${error.message}`, 
          page: currentPage 
        });
        break;
      }
      
      emitter.emit('error', { 
        status: 'error', 
        message: `Search failed on page ${currentPage}: ${error.message}`, 
        page: currentPage 
      });
      
      // Only break if we fail on the first page
      if (currentPage === 1) {
        break;
      }
      
      // For other pages, wait longer before trying the next page
      await delay(15000);
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