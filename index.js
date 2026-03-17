const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/total', (req, res) => {
  const data = Array.from(sessions.values()).map((s, index) => ({
    session: index + 1,
    url: s.url,
    count: s.count,
    id: s.id,
    target: s.target,
    interval: s.interval,
    error: s.error || null,
    logs: s.logs || [],
  }));
  res.json(data);
});

app.post('/api/submit', async (req, res) => {
  const { cookie, url, amount, interval } = req.body;

  if (!cookie || !url || !amount || !interval) {
    return res.status(400).json({ error: 'Missing required fields: cookie, url, amount, interval' });
  }

  const parsedAmount = parseInt(amount);
  const parsedInterval = parseInt(interval);

  if (isNaN(parsedAmount) || parsedAmount < 1) {
    return res.status(400).json({ error: 'Amount must be a valid number greater than 0' });
  }

  if (isNaN(parsedInterval) || parsedInterval < 1) {
    return res.status(400).json({ error: 'Interval must be a valid number greater than 0' });
  }

  try {
    const cookies = await convertCookie(cookie);
    if (!cookies) {
      return res.status(400).json({ error: 'Invalid cookies format' });
    }

    const postId = await getPostID(url);
    if (!postId) {
      return res.status(400).json({ error: 'Unable to get post ID. Check if URL is valid and post is public.' });
    }

    const accessToken = await getAccessToken(cookies);
    if (!accessToken) {
      return res.status(400).json({ error: 'Unable to retrieve access token. Check your cookies.' });
    }

    res.status(200).json({ status: 200, message: 'Boost session started successfully' });

    startSharing(cookies, url, postId, accessToken, parsedAmount, parsedInterval);

  } catch (err) {
    console.error('Submit error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

function startSharing(cookies, url, postId, accessToken, amount, interval) {
  const sessionId = Date.now().toString();

  sessions.set(sessionId, {
    url,
    id: postId,
    count: 0,
    target: amount,
    interval,
    error: null,
    logs: [],
    startTime: Date.now(),
  });

  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate',
    'connection': 'keep-alive',
    'cookie': cookies,
    'host': 'graph.facebook.com',
  };

  let sharedCount = 0;
  let timer = null;
  let stopped = false;

  function stopSession(errorMsg = null) {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);

    const current = sessions.get(sessionId);
    if (current) {
      sessions.set(sessionId, {
        ...current,
        error: errorMsg || current.error,
      });
    }

    const cleanupDelay = 5 * 60 * 1000;
    setTimeout(() => {
      sessions.delete(sessionId);
    }, cleanupDelay);
  }

  async function sharePost() {
    if (stopped) return;

    try {
      const response = await axios.post(
        `https://graph.facebook.com/me/feed`,
        {},
        {
          params: {
            link: `https://m.facebook.com/${postId}`,
            published: 0,
            access_token: accessToken,
          },
          headers,
          timeout: 15000,
        }
      );

      if (response.status === 200) {
        sharedCount++;
        const current = sessions.get(sessionId);
        if (!current) return;

        const logEntry = `[${new Date().toLocaleTimeString()}] Share #${sharedCount} successful.`;
        sessions.set(sessionId, {
          ...current,
          count: sharedCount,
          error: null,
          logs: [...(current.logs || []), logEntry].slice(-20),
        });

        if (sharedCount >= amount) {
          const logDone = `[${new Date().toLocaleTimeString()}] Target reached. Session complete.`;
          const updated = sessions.get(sessionId);
          if (updated) {
            sessions.set(sessionId, {
              ...updated,
              logs: [...(updated.logs || []), logDone].slice(-20),
            });
          }
          stopSession();
        }
      }
    } catch (error) {
      const fbError = error.response?.data?.error?.message;
      const errorMsg = fbError || error.message || 'Unknown error occurred';

      console.error(`[Session ${sessionId}] Share error:`, errorMsg);

      const current = sessions.get(sessionId);
      if (!current) return;

      const logEntry = `[${new Date().toLocaleTimeString()}] Error: ${errorMsg}`;
      sessions.set(sessionId, {
        ...current,
        error: errorMsg,
        logs: [...(current.logs || []), logEntry].slice(-20),
      });

      if (
        errorMsg.includes('Invalid OAuth') ||
        errorMsg.includes('access token') ||
        errorMsg.includes('session') ||
        error.response?.status === 401 ||
        error.response?.status === 403
      ) {
        stopSession(errorMsg);
      }
    }
  }

  timer = setInterval(sharePost, interval * 1000);

  const maxRunTime = (amount * interval + 60) * 1000;
  setTimeout(() => {
    if (!stopped) {
      stopSession('Session timed out.');
    }
  }, maxRunTime);
}

async function getPostID(url) {
  try {
    const response = await axios.post(
      'https://id.traodoisub.com/api.php',
      `link=${encodeURIComponent(url)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    if (response.data && response.data.id) {
      return response.data.id;
    }
    return null;
  } catch (error) {
    console.error('getPostID error:', error.message);
    return null;
  }
}

async function getAccessToken(cookie) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'max-age=0',
      'cookie': cookie,
      'referer': 'https://www.facebook.com/',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'upgrade-insecure-requests': '1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    const response = await axios.get('https://business.facebook.com/content_management', {
      headers,
      timeout: 15000,
    });

    const tokenMatch = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (tokenMatch && tokenMatch[1]) {
      return tokenMatch[1];
    }

    const altMatch = response.data.match(/access_token=([^&"]+)/);
    if (altMatch && altMatch[1]) {
      return altMatch[1];
    }

    return null;
  } catch (error) {
    console.error('getAccessToken error:', error.message);
    return null;
  }
}

async function convertCookie(cookie) {
  return new Promise((resolve) => {
    try {
      const trimmed = cookie.trim();

      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        const cookies = JSON.parse(trimmed);
        const cookieArray = Array.isArray(cookies) ? cookies : [cookies];

        const sbCookie = cookieArray.find((c) => c.key === 'sb' || c.name === 'sb');
        if (!sbCookie) {
          return resolve(null);
        }

        const datrCookie = cookieArray.find((c) => c.key === 'datr' || c.name === 'datr');

        let formatted = `sb=${sbCookie.value}; `;
        if (datrCookie) {
          formatted += `datr=${datrCookie.value}; `;
        }

        formatted += cookieArray
          .filter((c) => {
            const k = c.key || c.name;
            return k !== 'sb' && k !== 'datr';
          })
          .map((c) => `${c.key || c.name}=${c.value}`)
          .join('; ');

        return resolve(formatted.trim());
      }

      if (trimmed.includes('c_user=') || trimmed.includes('sb=') || trimmed.includes('xs=')) {
        return resolve(trimmed);
      }

      return resolve(null);
    } catch (error) {
      if (
        cookie.includes('c_user=') ||
        cookie.includes('sb=') ||
        cookie.includes('xs=')
      ) {
        return resolve(cookie.trim());
      }
      console.error('convertCookie error:', error.message);
      return resolve(null);
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
