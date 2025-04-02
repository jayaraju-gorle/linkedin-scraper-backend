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
          maxPages: 100,
          currentPage: 1,
          resultsPerPage: 10,
          ...options
      };

      // Take a screenshot for debugging
      await page.screenshot({ path: `debug-page-${settings.currentPage}.png` });
      
      // Get total search results info
      const totalResultsInfo = await getTotalSearchResultsInfo(page);
      console.log(`Total search results: ${totalResultsInfo.totalResults}`);
      
      // Calculate total profiles to extract
      const totalProfilesToExtract = calculateTotalProfilesToExtract(
          totalResultsInfo.totalResults,
          settings.maxPages,
          settings.resultsPerPage
      );
      
      // Use human-like scroll to ensure all content is loaded
      await humanLikeScroll(page);
      
      // Extract profiles based on structural patterns rather than specific classes
      const extractedProfiles = await page.evaluate(() => {
          // Text cleaning helper function for browser context
          const cleanText = (text) => {
              if (!text) return '';
              
              return text
                  .replace(/\s+/g, ' ')        // Replace multiple spaces, tabs, newlines with a single space
                  .replace(/^\s+|\s+$/g, '')   // Trim whitespace from start and end
                  .replace(/\n/g, ' ')         // Replace any remaining newlines with spaces
                  .replace(/\t/g, ' ')         // Replace any tabs with spaces
                  .replace(/\s{2,}/g, ' ')     // Make sure there are no double spaces left
                  .trim();                     // Final trim to ensure no leading/trailing spaces
          };
          
          // Parse position and company from title
          const parsePositionAndCompany = (title) => {
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
          };
          
          const profiles = [];
          
          // Step 1: Find the profile list container using structural hints
          const findProfileListContainer = () => {
              // Try to find a list with role="list" first (most reliable)
              const roleLists = document.querySelectorAll('[role="list"]');
              for (const list of roleLists) {
                  if (list.querySelectorAll('li').length > 0) {
                      return list;
                  }
              }
              
              // Try to find a ul inside a search container
              const searchContainers = document.querySelectorAll('div[class*="search-results"], div[class*="results-container"]');
              for (const container of searchContainers) {
                  const uls = container.querySelectorAll('ul');
                  if (uls.length > 0) {
                      return uls[0];
                  }
              }
              
              // Last resort: find any ul with multiple li elements that might be profiles
              const allULs = document.querySelectorAll('ul');
              for (const ul of allULs) {
                  const items = ul.querySelectorAll('li');
                  if (items.length >= 5) { // Assume profile list has multiple items
                      return ul;
                  }
              }
              
              return null;
          };
          
          // Find the profile list container
          const listContainer = findProfileListContainer();
          if (!listContainer) {
              console.error('Could not find profile list container');
              return profiles;
          }
          
          // Get all list items from the container
          const listItems = listContainer.querySelectorAll('li');
          console.log(`Found ${listItems.length} potential profile items`);
          
          // Process each list item to extract profile information
          Array.from(listItems).forEach((item, index) => {
              try {
                  // STRUCTURAL APPROACH TO PROFILE DATA EXTRACTION
                  
                  // 1. Name extraction - using consistent structural patterns
                  const extractName = (item) => {
                      // Pattern 1: Look for anchor tags with proper LinkedIn member links
                      const anchors = item.querySelectorAll('a');
                      for (const a of anchors) {
                          // Skip anchors without href or with empty text
                          if (!a.href || !a.textContent.trim()) continue;
                          
                          // Skip anchors that only contain images
                          if (a.querySelector('img') && !a.textContent.trim()) continue;
                          
                          // Find anchors that contain profile links and have text content
                          if ((a.href.includes('/in/') || a.href.includes('/headless')) && a.textContent.trim()) {
                              const name = cleanText(a.textContent);
                              // Clean the name
                              return name.replace(/Status is offline/i, '')
                                        .replace(/View\s+profile/i, '')
                                        .trim();
                          }
                      }
                      
                      // Pattern 2: Look for prominent text that might be a name
                      // Names are often in larger or emphasized text and near the top of the item
                      const possibleNameElements = item.querySelectorAll('span[class*="t-16"], span[class*="t-14"], span[class*="font-bold"], span[class*="name"]');
                      for (const el of possibleNameElements) {
                          const text = cleanText(el.textContent);
                          if (text && !text.includes('Status is') && text.length > 1) {
                              return text;
                          }
                      }
                      
                      return null;
                  };
                  
                  // 2. Title extraction - typically follows name in the hierarchy
                  const extractTitle = (item) => {
                      // First try: look for small/medium sized text elements after the name
                      const titleContainers = Array.from(item.querySelectorAll('div, span')).filter(el => {
                          const text = cleanText(el.textContent);
                          return text && text.length > 5 && text.length < 100;
                      });
                      
                      for (const container of titleContainers) {
                          const text = cleanText(container.textContent);
                          
                          // Skip location patterns
                          if (text.match(/\b(India|United States|UAE|Canada|UK|Australia)\b/i) && 
                              text.length < 25) continue;
                              
                          // Check for title patterns (job roles)
                          const titlePatterns = [
                              /\b(Software|Sr|Senior|Junior|Lead|Principal|Staff|Associate)\b/i,
                              /\b(Engineer|Developer|Architect|Manager|Director|VP|CEO|CTO|Founder)\b/i,
                              /\b(Analyst|Consultant|Specialist|Designer|Officer|Head|Executive)\b/i
                          ];
                          
                          if (titlePatterns.some(pattern => pattern.test(text)) || 
                              text.includes(' at ') || 
                              text.includes(' - ') ||
                              text.includes(' | ')) {
                              return text;
                          }
                      }
                      
                      return null;
                  };
                  
                  // 3. Location extraction - typically appears after title
                  const extractLocation = (item) => {
                      // Location patterns that identify geographic locations
                      const locationPatterns = [
                          /\b(India|United States|UAE|Canada|UK|Australia)\b/i,
                          /\b(New York|London|Mumbai|Delhi|Bangalore|Hyderabad|Chennai|Pune)\b/i,
                          /\b(California|Texas|Florida|Michigan|Illinois)\b/i
                      ];
                      
                      // Look for elements containing location text
                      const allTextElements = item.querySelectorAll('div, span');
                      for (const el of allTextElements) {
                          const text = cleanText(el.textContent);
                          
                          // Skip empty or very long text
                          if (!text || text.length > 50) continue;
                          
                          // Check if text contains location patterns
                          if (locationPatterns.some(pattern => pattern.test(text))) {
                              // If it looks like a pure location (not mixed with other info)
                              if (!text.includes(' at ') && !text.includes('Engineer') && !text.includes('Manager')) {
                                  return text;
                              }
                          }
                      }
                      
                      // Look for text elements that are likely to be locations (third text block often)
                      const textBlocks = Array.from(item.querySelectorAll('div')).filter(div => {
                          const text = cleanText(div.textContent);
                          return text && text.length > 2 && text.length < 50;
                      });
                      
                      // If we have multiple text blocks, the location is often the last one
                      if (textBlocks.length >= 3) {
                          return cleanText(textBlocks[textBlocks.length - 1].textContent);
                      }
                      
                      return null;
                  };
                  
                  // 4. Profile URL extraction - look for proper LinkedIn profile links
                  const extractProfileUrl = (item) => {
                      // Look for anchors with /in/ in the URL (real profiles)
                      const profileAnchors = item.querySelectorAll('a');
                      for (const a of profileAnchors) {
                          if (a.href && a.href.includes('/in/')) {
                              // Clean the URL by removing parameters
                              return a.href.split('?')[0];
                          }
                      }
                      
                      // Check for headless profile indicator
                      if (item.innerHTML.includes('headless')) {
                          return 'https://www.linkedin.com/search/results/people/headless';
                      }
                      
                      // Check if there's a data attribute that contains profile info
                      const resultElement = item.querySelector('[data-chameleon-result-urn], [data-entity-urn]');
                      if (resultElement) {
                          const urn = resultElement.getAttribute('data-chameleon-result-urn') || 
                                     resultElement.getAttribute('data-entity-urn');
                          if (urn && urn.includes('member:')) {
                              // Extract member ID if possible
                              const memberId = urn.split('member:')[1];
                              if (memberId && !memberId.includes('headless')) {
                                  return `https://www.linkedin.com/in/${memberId}`;
                              } else {
                                  return 'https://www.linkedin.com/search/results/people/headless';
                              }
                          }
                      }
                      
                      return null;
                  };
                  
                  // 5. Profile image extraction
                  const extractProfileImage = (item) => {
                      // Look for img tags with profile photos
                      const imgElements = item.querySelectorAll('img');
                      for (const img of imgElements) {
                          // Skip tiny images that are likely icons
                          if (img.width < 20 || img.height < 20) continue;
                          
                          // Check for common profile image patterns
                          if (img.src && 
                              (img.src.includes('profile-displayphoto') || 
                               img.src.includes('licdn.com/dms/image'))) {
                              return img.src;
                          }
                          
                          // Check alt text for profile indicators
                          if (img.alt && 
                              (img.alt.includes('profile') || 
                               img.alt.includes('photo') || 
                               img.alt.includes('picture'))) {
                              return img.src;
                          }
                          
                          // Check parent element classes
                          const parent = img.parentElement;
                          if (parent && 
                              (parent.className.includes('presence-entity') || 
                               parent.className.includes('photo') ||
                               parent.className.includes('image'))) {
                              return img.src;
                          }
                      }
                      
                      return null;
                  };
                  
                  // 6. Connection degree extraction
                  const extractConnectionDegree = (item) => {
                      // Look for text containing connection degree information
                      const connectionPatterns = [
                          /1st\s+degree\s+connection/i,
                          /2nd\s+degree\s+connection/i,
                          /3rd\s+degree\s+connection/i,
                          /\d+th\s+degree\s+connection/i
                      ];
                      
                      const fullText = item.textContent;
                      for (const pattern of connectionPatterns) {
                          const match = fullText.match(pattern);
                          if (match) {
                              return match[0].trim();
                          }
                      }
                      
                      return null;
                  };
                  
                  // 7. Mutual connections extraction
                  const extractMutualConnections = (item) => {
                      // Look for text mentioning mutual connections
                      const mutualPattern = /(\d+)\s+mutual\s+connections?/i;
                      const text = item.textContent;
                      const match = text.match(mutualPattern);
                      if (match && match[1]) {
                          return parseInt(match[1], 10);
                      }
                      
                      return null;
                  };
                  
                  // 8. Active status extraction
                  const extractActiveStatus = (item) => {
                      // Check for special status indicators
                      const activePatterns = [
                          /#OpenToWork/i,
                          /Open to work/i,
                          /#Hiring/i,
                          /Currently hiring/i
                      ];
                      
                      for (const pattern of activePatterns) {
                          if (pattern.test(item.textContent)) {
                              return pattern.source.replace(/[/#i]/g, '').trim();
                          }
                      }
                      
                      // Check for online status indicator
                      const presenceIndicator = item.querySelector('.presence-entity__indicator:not(.hidden)');
                      if (presenceIndicator) {
                          return 'Online';
                      }
                      
                      return null;
                  };
                  
                  // Extract raw data
                  const rawName = extractName(item);
                  const rawTitle = extractTitle(item);
                  const rawLocation = extractLocation(item);
                  const profileUrl = extractProfileUrl(item);
                  const profileImage = extractProfileImage(item);
                  const connectionDegree = extractConnectionDegree(item);
                  const mutualConnections = extractMutualConnections(item);
                  const activeStatus = extractActiveStatus(item);
                  
                  // Clean text data
                  const name = cleanText(rawName);
                  const title = cleanText(rawTitle);
                  const location = cleanText(rawLocation);
                  
                  // Parse position and company
                  const { position, company } = parsePositionAndCompany(title);
                  
                  // Determine if this is an anonymous profile
                  const isAnonymous = 
                      !name || 
                      name === 'LinkedIn Member' ||
                      (profileUrl && profileUrl.includes('headless'));
                  
                  // Extract LinkedIn ID from profile URL if available
                  let linkedinId = 'unknown';
                  if (profileUrl && profileUrl.includes('/in/')) {
                      linkedinId = profileUrl.split('/in/')[1].split('?')[0];
                  } else if (profileUrl && profileUrl.includes('headless')) {
                      linkedinId = 'headless';
                  }
                  
                  // Format the display name
                  let displayName = name;
                  if (isAnonymous) {
                      // Use position if available, otherwise title
                      const jobInfo = position || title;
                      displayName = jobInfo ? `Anonymous LinkedIn Member (${jobInfo})` : 'Anonymous LinkedIn Member';
                  }
                  
                  // Only add the profile if we have at least one piece of valid data
                  if (name || title || location || profileUrl) {
                      profiles.push({
                          name: displayName || 'Anonymous LinkedIn Member',
                          title: title || 'No title listed',
                          position: position || title || 'No position listed',
                          company: company || 'Not specified',
                          location: location || 'No location listed',
                          profileUrl: profileUrl || '',
                          profileImage: profileImage || '',
                          linkedinId: linkedinId,
                          connectionDegree: connectionDegree || null,
                          mutualConnections: mutualConnections || 0,
                          activeStatus: activeStatus || null,
                          isAnonymous: isAnonymous
                      });
                  }
              } catch (e) {
                  console.error(`Error parsing profile #${index+1}:`, e);
              }
          });
          
          return profiles;
      });
      
      console.log(`Extracted ${extractedProfiles.length} profiles from page ${settings.currentPage}`);
      
      // Stream profiles to client as they're processed
      for (let i = 0; i < extractedProfiles.length; i++) {
          const profile = extractedProfiles[i];
          
          // Calculate progress
          const profilesScraped = (settings.currentPage - 1) * settings.resultsPerPage + (i + 1);
          const progress = Math.min(100, Math.floor(100 * profilesScraped / totalProfilesToExtract));
          
          // Stream profile to client
          if (onProfileExtracted) {
              onProfileExtracted({
                  profile,
                  progress,
                  totalProfiles: totalProfilesToExtract,
                  profilesScraped,
                  totalAvailable: totalResultsInfo.totalResults
              });
          }
          
          // Small delay between emissions
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
    let consecutiveErrorCount = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    let lastSuccessfulPageNumber = 0;
    
    // Add randomized user-agent rotation
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
    ];

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

    // Helper function for adaptive delays based on page number
    const getPageDelay = (pageNum) => {
        // Progressively increase delay as we move through pages
        const baseDelay = 3000; // 3 seconds
        const pageMultiplier = Math.min(3, Math.floor(pageNum / 5) + 1); // Increase multiplier every 5 pages, max 3x
        const randomFactor = 0.5 + Math.random(); // Random factor between 0.5 and 1.5
        
        return baseDelay * pageMultiplier * randomFactor;
    };
    
    // Helper function to detect LinkedIn's rate limiting or suspicious activity patterns
    const checkForRateLimiting = async (page) => {
        const indicators = await page.evaluate(() => {
            // Check for common rate limiting or security challenge indicators
            const body = document.body.textContent.toLowerCase();
            return {
                captchaPresent: 
                    document.querySelector('#captcha-internal') !== null || 
                    document.querySelector('input[name="captcha"]') !== null ||
                    body.includes('security verification') ||
                    body.includes('verify it\'s you') ||
                    body.includes('suspicious activity'),
                rateLimitMsg: 
                    body.includes('rate limit') || 
                    body.includes('try again later') ||
                    body.includes('too many requests'),
                maintenanceMsg:
                    body.includes('maintenance') ||
                    body.includes('temporarily unavailable'),
                loginRedirect: 
                    window.location.href.includes('/login') ||
                    window.location.href.includes('/checkpoint') ||
                    document.querySelector('form[action*="login"]') !== null
            };
        });
        
        return indicators;
    };
    
    // Add tracking and jitter for page navigation
    const baseNavigationTimeoutMs = 45000; // 45 seconds
    let navigationTimeout = baseNavigationTimeoutMs;
    const cookieRefreshInterval = 5; // Refresh cookies every 5 pages
    
    for (let currentPage = 1; currentPage <= numPages; currentPage++) {
        // Use a more complex page URL construction with slight random parameter variation
        // Add a timestamp parameter to avoid caching
        const timestamp = Date.now();
        const jitter = Math.floor(Math.random() * 100);
        
        // Build the URL with proper pagination parameter (LinkedIn uses both page and start)
        const pageParam = currentPage > 1 ? `page=${currentPage}` : '';
        const startParam = currentPage > 1 ? `start=${(currentPage-1) * 10}` : '';
        
        let pageUrl = searchUrl;
        
        // Add pagination parameters
        if (currentPage > 1) {
            if (pageUrl.includes('?')) {
                // Already has query parameters
                if (!pageUrl.includes('page=') && !pageUrl.includes('start=')) {
                    pageUrl += `&${pageParam}&${startParam}`;
                } else if (pageUrl.includes('page=')) {
                    // Replace existing page parameter
                    pageUrl = pageUrl.replace(/page=\d+/, pageParam);
                    if (!pageUrl.includes('start=')) {
                        pageUrl += `&${startParam}`;
                    }
                }
            } else {
                // No existing query parameters
                pageUrl += `?${pageParam}&${startParam}`;
            }
        }
        
        // Add cache-busting parameters
        pageUrl += pageUrl.includes('?') ? `&_=${timestamp}&jitter=${jitter}` : `?_=${timestamp}&jitter=${jitter}`;
        
        try {
            // Randomize user agent for each page
            const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            await page.setUserAgent(randomUserAgent);
            
            // Refresh cookies periodically if needed
            if (currentPage > 1 && currentPage % cookieRefreshInterval === 0) {
                emitter.emit('progress', { 
                    status: 'refreshing_session', 
                    message: `Refreshing session on page ${currentPage}` 
                });
                
                // Visit LinkedIn feed briefly to refresh session
                await page.goto('https://www.linkedin.com/feed/', { 
                    waitUntil: 'domcontentloaded',
                    timeout: 20000
                }).catch(e => console.log('Feed refresh had an error, continuing anyway:', e.message));
                
                // Brief delay after refreshing session
                await delay(1000 + Math.random() * 2000);
            }
            
            // Log navigation and update UI
            console.log(`Navigating to: ${pageUrl}`);
            emitter.emit('progress', { 
                status: 'navigating', 
                message: `Navigating to page ${currentPage}`, 
                page: currentPage 
            });
            
            // Adaptive navigation timeout with jitter
            navigationTimeout = baseNavigationTimeoutMs + Math.floor(Math.random() * 5000);
            
            // More resilient navigation approach with retries
            let navigationSuccess = false;
            let navigationAttempts = 0;
            const maxNavigationAttempts = 3;
            
            while (!navigationSuccess && navigationAttempts < maxNavigationAttempts) {
                navigationAttempts++;
                
                try {
                    // Clear cache and cookies if this is a retry
                    if (navigationAttempts > 1) {
                        const client = await page.target().createCDPSession();
                        await client.send('Network.clearBrowserCache');
                        emitter.emit('progress', { 
                            status: 'retry_navigation', 
                            message: `Retry navigation attempt ${navigationAttempts} for page ${currentPage}` 
                        });
                        
                        // Add a random delay before retry
                        await delay(2000 + Math.random() * 3000);
                    }
                    
                    // First try with a shorter timeout and domcontentloaded
                    await page.goto(pageUrl, { 
                        waitUntil: 'domcontentloaded',
                        timeout: navigationTimeout 
                    });
                    
                    navigationSuccess = true;
                } catch (navError) {
                    console.log(`Navigation attempt ${navigationAttempts} failed:`, navError.message);
                    
                    // Check if we're on a valid page despite the error
                    const url = page.url();
                    
                    if (url.includes('/login') || url.includes('/checkpoint')) {
                        throw new Error('LinkedIn session expired. Please provide new cookies.');
                    }
                    
                    if (url.includes('linkedin.com/search')) {
                        console.log('Still on LinkedIn search page, continuing despite timeout');
                        navigationSuccess = true;
                    }
                    
                    // If last attempt and still failed, throw error
                    if (navigationAttempts >= maxNavigationAttempts && !navigationSuccess) {
                        throw new Error(`Failed to navigate to page ${currentPage} after ${maxNavigationAttempts} attempts`);
                    }
                }
            }
            
            // Wait for page to settle after navigation
            await delay(2000 + Math.random() * 1000);
            
            // Check for rate limiting or security challenges
            const rateLimitCheck = await checkForRateLimiting(page);
            if (rateLimitCheck.captchaPresent) {
                // Take a screenshot for review
                await page.screenshot({ path: `captcha-detected-page-${currentPage}.png` });
                throw new Error('CAPTCHA or security verification detected. Please try again later with new cookies.');
            }
            if (rateLimitCheck.rateLimitMsg) {
                throw new Error('Rate limiting detected. LinkedIn is asking to slow down requests.');
            }
            if (rateLimitCheck.maintenanceMsg) {
                throw new Error('LinkedIn reports maintenance or temporary unavailability.');
            }
            if (rateLimitCheck.loginRedirect) {
                throw new Error('Redirected to login. Session may have expired.');
            }
            
            // Advanced waiting strategy with multiple selector attempts and fallbacks
            let resultsFound = false;
            const selectorSets = [
                // Latest LinkedIn structure selectors (2024)
                [
                    'li.eFNvtmZzTTJeAFaqYEszRmPedngAGKDE',
                    'div.XbSDRFUSbGBpQPKjsigDankzSjQsnIyFKHI',
                    'ul.mRINvsmBJFpXGsGCEXfkuAyiKqOjbhxMnshkMw'
                ],
                // Previous LinkedIn structure selectors
                [
                    '.search-results-container',
                    '.reusable-search__result-container',
                    '.search-results',
                    '.scaffold-layout__list'
                ],
                // Most generic selectors (last resort)
                [
                    'div[data-chameleon-result-urn]',
                    '.entity-result',
                    'li.scaffold-layout__list-item'
                ]
            ];
            
            // Try each selector set with its own timeout
            for (const selectors of selectorSets) {
                try {
                    await page.waitForSelector(selectors.join(','), { 
                        timeout: 15000
                    });
                    resultsFound = true;
                    console.log('Search results container found');
                    break;
                } catch (selectorError) {
                    console.log(`Selector set not found: ${selectors.join(',')}`);
                    // Continue to next selector set
                }
            }
            
            // Even if no selectors matched, we'll still try to extract data
            if (!resultsFound) {
                console.log('No results selectors matched, will try direct extraction anyway');
                await page.screenshot({ path: `no-selectors-page-${currentPage}.png` });
            }
            
            // Wait with dynamic delay - longer for later pages
            const dynamicDelay = 5000 + (Math.random() * 2000) + (currentPage * 100);
            await delay(dynamicDelay);
            
            // Perform scrolling with more human-like behavior
            await humanLikeScroll(page);
            
            // Additional waiting after scrolling
            await delay(3000 + Math.random() * 2000);
            
            // Check current URL again to ensure we're still on search results
            const currentUrl = page.url();
            if (currentUrl.includes('/login') || currentUrl.includes('/checkpoint')) {
                throw new Error('LinkedIn session expired. Please provide new cookies.');
            }
            
            emitter.emit('progress', { 
                status: 'page_loaded', 
                message: `Page ${currentPage} loaded successfully`, 
                page: currentPage, 
                url: currentUrl 
            });
            
            // Let the page settle a bit more before extraction
            await delay(1000 + Math.random() * 1000);
            
            emitter.emit('progress', { 
                status: 'extracting', 
                message: `Extracting data from page ${currentPage}`, 
                page: currentPage 
            });

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
            
            // Reset consecutive error count since we succeeded
            consecutiveErrorCount = 0;
            lastSuccessfulPageNumber = currentPage;
            
            // If we have no results, we've reached the end
            if (hasNoResults) {
                // Add debugging to understand why no results were found
                console.log(`No results found on page ${currentPage}, taking screenshot for debugging`);
                await page.screenshot({ path: `no-results-page-${currentPage}.png` });
                
                // Check for "No more results" message or other indicators
                const endOfResultsCheck = await page.evaluate(() => {
                    const bodyText = document.body.textContent.toLowerCase();
                    return {
                        explicitNoResults: 
                            bodyText.includes('no results found') || 
                            bodyText.includes('no matching results') ||
                            bodyText.includes('we couldn\'t find any results'),
                        noMoreResults:
                            bodyText.includes('end of results') ||
                            bodyText.includes('no more results'),
                        totalResultsText: document.querySelector('h2.mUkRIIczmilxfKxF3dXujMgFXZ9fFrQXcSW')?.textContent || 
                                         document.querySelector('div.pb2 h2')?.textContent || ''
                    };
                });
                
                const message = endOfResultsCheck.explicitNoResults ? 
                    'No results found for this search' : 
                    `No more results found after page ${currentPage-1}`;
                
                emitter.emit('progress', { 
                    status: 'no_more_results', 
                    message: message,
                    page: currentPage,
                    debugInfo: endOfResultsCheck
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
            
            // Adaptive delay between pages, increasing for later pages
            const pageDelay = getPageDelay(currentPage);
            console.log(`Waiting ${pageDelay}ms before next page...`);
            await delay(pageDelay);
            
        } catch (error) {
            console.error(`Search failed on page ${currentPage}:`, error);
            consecutiveErrorCount++;
            
            // Take screenshot for debugging
            try {
                await page.screenshot({ path: `error-page-${currentPage}.png` });
            } catch (screenshotError) {
                console.error('Failed to take screenshot:', screenshotError);
            }
            
            emitter.emit('error', { 
                status: 'error', 
                message: `Search failed on page ${currentPage}: ${error.message}`, 
                page: currentPage 
            });
            
            // If we hit too many consecutive errors, stop the search
            if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
                emitter.emit('error', {
                    status: 'stopped',
                    message: `Stopping search after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`,
                    lastSuccessfulPage: lastSuccessfulPageNumber
                });
                break;
            }
            
            // For specific errors that indicate we should stop immediately
            if (error.message.includes('CAPTCHA') || 
                error.message.includes('security verification') ||
                error.message.includes('rate limiting') ||
                error.message.includes('session expired')) {
                emitter.emit('error', {
                    status: 'blocked',
                    message: `LinkedIn is blocking further requests: ${error.message}`,
                    lastSuccessfulPage: lastSuccessfulPageNumber
                });
                break;
            }
            
            // Longer delay after an error before trying the next page
            const errorDelay = 8000 + (Math.random() * 5000);
            console.log(`Error encountered, waiting ${errorDelay}ms before continuing...`);
            await delay(errorDelay);
            
            // Only break if we fail on the first page or hit max consecutive errors
            if (currentPage === 1) {
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