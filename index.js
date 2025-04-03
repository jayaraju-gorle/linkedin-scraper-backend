const express = require('express');
const cors = require('cors');
const { searchLinkedInPeople } = require('./linkedinScraperService');

const app = express();
const port = process.env.PORT || 3001; // Use the PORT environment variable or default to 3001

// Add proper error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Keep the server running despite the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Keep the server running despite the error
});

app.use(cors());

app.get('/api/linkedin-search', (req, res) => {
    const searchTerm = req.query.q;
    const cookiesString = req.query.cookies;
    const maxPages = parseInt(req.query.maxPages) || 100;

    if (!cookiesString) {
        return res.status(400).json({ error: 'LinkedIn cookies are required' });
    }
    const decodedCookies = decodeURIComponent(cookiesString);

    let searchUrl = req.query.searchUrl;
    const DEFAULT_SEARCH_URL = 'https://www.linkedin.com/search/results/people/';
    if (searchUrl) {
        searchUrl = decodeURIComponent(searchUrl);
    } else if (searchTerm) {
        searchUrl = `${DEFAULT_SEARCH_URL}?keywords=${encodeURIComponent(searchTerm)}`;
    } else {
        return res.status(400).json({ error: 'Either searchUrl or searchTerm is required' });
    }

    // Flag to track if response has been ended
    let isResponseEnded = false;

    // Helper function to safely write to response
    const safeWrite = (data) => {
        if (!isResponseEnded && !res.writableEnded) {
            res.write(data);
        }
    };

    // Helper function to safely end response
    const safeEnd = () => {
        if (!isResponseEnded && !res.writableEnded) {
            isResponseEnded = true;
            res.end();
        }
    };

    // Set headers for SSE with explicit timeouts
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // Set longer timeouts for the request and response
    req.socket.setTimeout(900000); // 15 minutes
    
    // Implement heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
        if (!isResponseEnded && !res.writableEnded) {
        safeWrite(':heartbeat\n\n'); // SSE comment line as heartbeat
        } else {
        clearInterval(heartbeatInterval);
        }
    }, 30000); // Every 30 seconds
    
    // Send initial message to establish connection
    safeWrite('data: {"status":"connected","message":"SSE connection established"}\n\n');

    const emitter = searchLinkedInPeople(searchUrl, decodedCookies, maxPages);

    // Store a reference to the emitter for cleanup
    let scraperEmitter = emitter;
    let isCancelled = false;

    emitter.on('progress', (data) => {
        console.log('Progress:', data);
        safeWrite(`data: ${JSON.stringify(data)}\n\n`);
    });

    emitter.on('error', (data) => {
        console.error('Error:', data);
        safeWrite(`data: ${JSON.stringify(data)}\n\n`);
        safeEnd();
    });

    emitter.on('done', (data) => {
        console.log('Done:', data);
        safeWrite(`data: ${JSON.stringify(data)}\n\n`);
        safeEnd();
    });

    // Handle client disconnect
    req.on('close', () => {
        clearInterval(heartbeatInterval);
        console.log('Client disconnected');
        
        // Set the cancelled flag
        isCancelled = true;
        
        // Emit a cancel event to stop the scraping process
        if (scraperEmitter) {
            scraperEmitter.emit('cancel');
            scraperEmitter.removeAllListeners();
            scraperEmitter = null;
        }
        
        safeEnd();
    });
});

app.get('/api', (req, res) => {
    res.send('Hi, server is up and running');
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});