const express = require('express');
const cors = require('cors');
const { searchLinkedInPeople, DEFAULT_SEARCH_URL } = require('./linkedinScraperService');
const app = express();
//const port = 3001; // Remove the hardcoded port
const port = process.env.PORT || 3001; // Use the PORT environment variable or default to 3001

app.use(cors());

app.get('/api/linkedin-search', async (req, res) => {
    const searchTerm = req.query.q;
    const cookiesString = req.query.cookies; // Get cookies from query parameter
    let maxPages = parseInt(req.query.maxPages);

    if (isNaN(maxPages)) {
        maxPages = undefined; // Set to undefined if NaN
    }

    const searchUrl = req.query.searchUrl;

    if (!cookiesString) {
        return res.status(400).json({ error: 'LinkedIn cookies are required' });
    }

    let finalSearchUrl;
    if (searchUrl) {
        finalSearchUrl = searchUrl;
    } else if (searchTerm) {
        finalSearchUrl = `${DEFAULT_SEARCH_URL}?keywords=${encodeURIComponent(searchTerm)}`;
    } else {
        return res.status(400).json({ error: 'Either searchUrl or searchTerm is required' });
    }

    try {
        const results = await searchLinkedInPeople(finalSearchUrl, cookiesString, maxPages);
        res.json(results);
    } catch (error) {
        console.error("Error in API endpoint:", error);
        if (error.message.includes("Error setting cookies")) {
            res.status(400).json({ error: error.message });
        } else if (error.message.includes("Search failed")) {
            res.status(500).json({ error: error.message });
        } else if (error.message.includes("Error in extractSearchResults")) {
            res.status(500).json({ error: error.message });
        } else if (error.message.includes("Error in searchLinkedInPeople")) {
            res.status(500).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'An error occurred during the search' });
        }
    }
});

app.get('/api', (req, res) => {
    res.send('Hi, server is up and running');
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
