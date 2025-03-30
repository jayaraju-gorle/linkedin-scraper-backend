const puppeteer = require('puppeteer');
require('dotenv').config();

const LINKEDIN_URL = 'https://www.linkedin.com';
const DEFAULT_SEARCH_URL = `${LINKEDIN_URL}/search/results/people/`;

// Function to introduce a delay
function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time);
    });
}

async function setCookies(page, cookiesString) {
    if (!cookiesString) {
        throw new Error('No cookies provided.');
    }
    try {
        const cookies = cookiesString.split(';').map(cookie => {
            const [name, value] = cookie.trim().split('=');
            return { name, value, domain: '.linkedin.com' };
        });
        await page.setCookie(...cookies);
    } catch (error) {
        console.error("Error setting cookies:", error);
        throw new Error(`Error setting cookies: ${error.message}`);
    }
}

async function performPeopleSearch(page, searchUrl, maxPages) {
    let allResults = [];
    const numPages = maxPages === undefined ? 50 : maxPages; // Use default if undefined, changed to 50
    for (let currentPage = 1; currentPage <= numPages; currentPage++) {
        const pageUrl = currentPage === 1 ? searchUrl : `${searchUrl}&page=${currentPage}`;
        try {
            console.log(`Navigating to: ${pageUrl}`);
            await page.goto(pageUrl, { timeout: 60000 }); // Increased timeout
            try {
                await page.waitForSelector('li.AdHMbgDGIMDafLgUlAYlroYNrSpshgCHY', { timeout: 60000 }); // Increased timeout
            } catch (timeoutError) {
                if (timeoutError instanceof puppeteer.TimeoutError) { // Corrected line
                    console.log(`Timeout waiting for results on page ${currentPage}. Assuming no more results.`);
                    break; // Exit the loop if there's a timeout
                } else {
                    throw timeoutError; // Re-throw other errors
                }
            }
            const searchResults = await extractSearchResults(page);
            allResults = allResults.concat(searchResults);
            // Add a delay between page requests
            await delay(2000); // Wait for 2 seconds (adjust as needed)
        } catch (error) {
            console.error(`Search failed on page ${currentPage}:`, error);
            throw new Error(`Search failed on page ${currentPage}: ${error.message}`);
        }
    }
    return allResults;
}

async function extractSearchResults(page) {
    try {
        const results = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('li.AdHMbgDGIMDafLgUlAYlroYNrSpshgCHY')); // Select the list items
            return items.map(item => {
                try {
                    const nameElement = item.querySelector('span.mkMastUmWkELhAcaaNYzKMdrjlCmJXnYgZE.t-16 > a.dgePcUVTyZcmWIuOySyndWdGoBMukAZsio');
                    const headlineElement = item.querySelector('div.mTjnOwtMxHPffEIRcJLDWXTPzwQcTgTqrfveo.t-14.t-black.t-normal');
                    const locationElement = item.querySelector('div.bPSmFcwecOKZVgXSLAwwTDITpxNrJUrPIOE.t-14.t-normal');
                    const profileUrlElement = item.querySelector('a.dgePcUVTyZcmWIuOySyndWdGoBMukAZsio');
                    const profileImageElement = item.querySelector('img.presence-entity__image');
                    const statusElement = item.querySelector('div.presence-entity__indicator > span.visually-hidden');

                    const name = nameElement ? nameElement.textContent.trim() : null;
                    const headline = headlineElement ? headlineElement.textContent.trim() : null;
                    const location = locationElement ? locationElement.textContent.trim() : null;
                    const profileUrl = profileUrlElement ? profileUrlElement.href : null;
                    const profileImageUrl = profileImageElement ? profileImageElement.src : null;
                    const status = statusElement ? statusElement.textContent.trim() : null;

                    return { name, headline, location, profileUrl, profileImageUrl, status };
                } catch (error) {
                    console.error("Error extracting data:", error);
                    return null;
                }
            });
        });
        return results.filter(result => result !== null);
    } catch (error) {
        console.error("Error in extractSearchResults:", error);
        throw new Error(`Error in extractSearchResults: ${error.message}`);
    }
}

async function searchLinkedInPeople(searchUrl, cookiesString, maxPages) {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    try {
        await setCookies(page, cookiesString);
        const results = await performPeopleSearch(page, searchUrl, maxPages);
        return results;
    } catch (error) {
        console.error("Error in searchLinkedInPeople:", error);
        throw new Error(`Error in searchLinkedInPeople: ${error.message}`);
    } finally {
        await browser.close();
    }
}

module.exports = { searchLinkedInPeople, DEFAULT_SEARCH_URL };
