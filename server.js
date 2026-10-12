const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const fetch = globalThis.fetch ?? ((...args) =>
  import('node-fetch').then(({ default: nodeFetch }) => nodeFetch(...args)));

async function fetchWithDnsRetry(url, options) {
  const retryDelays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error.cause?.code !== 'EAI_AGAIN' || attempt >= retryDelays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

function getRetryDelay(response, retryNumber) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Number.isNaN(seconds) ? Date.parse(retryAfter) : NaN;
    const delay = Number.isNaN(seconds)
      ? retryAt - Date.now()
      : seconds * 1000;
    if (Number.isFinite(delay) && delay > 10000) return null;
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return Math.min(500 * (2 ** (retryNumber - 1)), 2000) + Math.floor(Math.random() * 250);
}

async function fetchWithProviderRetry(url, options) {
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  const maxRetries = 2;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchWithDnsRetry(url, options);
    if (!retryableStatuses.has(response.status) || attempt >= maxRetries) return response;

    const delay = getRetryDelay(response, attempt + 1);
    if (delay === null) return response;
    console.warn(`Provider returned ${response.status}; retrying chat request (${attempt + 1}/${maxRetries}).`);
    await response.body?.cancel().catch((error) => {
      console.warn('Could not close the previous provider response:', error.message);
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
const APP_ACCESS_KEYS = [
  process.env.APP_ACCESS_KEY?.trim(),
  process.env.APP_ACCESS_KEY_2?.trim()
].map((key, index) => key ? { key, canViewAnalytics: index === 0 } : null)
  .filter(Boolean);
const CHAT_BODY_LIMIT = process.env.CHAT_BODY_LIMIT || '64mb';
const ACCESS_COOKIE = 'ei_access';
const ACCESS_SESSION_MS = 12 * 60 * 60 * 1000;
const ANALYTICS_ACTIVE_WINDOW_MS = 90 * 1000;
const analyticsSessions = new Map();
const analyticsVisitors = new Set();
const analyticsDailyViews = new Map();
let analyticsPageViews = 0;
const loginAttempts = new Map();
const providers = {
  'nvidia-nim': {
    name: 'NVIDIA NIM',
    chatUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    modelsFormat: 'openai'
  },
  'google-ai-studio': {
    name: 'Google AI Studio',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    modelsFormat: 'google'
  },
  openrouter: {
    name: 'OpenRouter (free models)',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    modelsFormat: 'openai'
  }
};

// Video uploads are sampled into images, so vision-capable models can analyze them.
const GROK_STYLE_SYSTEM_PROMPT = 'You are a Grok-style assistant: helpful, direct, truth-seeking, and concise. Avoid filler and unsolicited lectures, reason independently, and use light wit only when it fits. Maintain a professional tone. Do not claim to be the xAI Grok model.';
const NVIDIA_MODEL_CAPABILITIES = {
  'meta/llama-3.2-11b-vision-instruct': ['image', 'video'],
  'meta/llama-3.2-90b-vision-instruct': ['image', 'video'],
  'moonshotai/kimi-k3': ['image', 'video']
};
const discoveredModelCapabilities = new Map();

app.use(express.json({ limit: CHAT_BODY_LIMIT }));

function getAccessSessionAnalyticsPermission(req) {
  if (!APP_ACCESS_KEYS.length) return null;
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${ACCESS_COOKIE}=`));
  if (!cookie) return null;

  const [expiresAtText, signature] = cookie.slice(ACCESS_COOKIE.length + 1).split('.');
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
      expiresAt > Date.now() + ACCESS_SESSION_MS) return null;

  let providedSignature;
  try {
    providedSignature = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  for (const { key, canViewAnalytics } of APP_ACCESS_KEYS) {
    const expectedSignature = crypto.createHmac('sha256', key)
      .update(expiresAtText)
      .digest();
    if (providedSignature.length === expectedSignature.length
        && crypto.timingSafeEqual(providedSignature, expectedSignature)) {
      return canViewAnalytics;
    }
  }
  return null;
}

function createAccessCookie(req, res, key) {
  const expiresAt = Date.now() + ACCESS_SESSION_MS;
  const signature = crypto.createHmac('sha256', key)
    .update(String(expiresAt))
    .digest('base64url');
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ACCESS_COOKIE}=${expiresAt}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ACCESS_SESSION_MS / 1000}${secure}`
  );
}

function checkLoginRateLimit(req, res) {
  const now = Date.now();
  const address = req.ip || req.socket.remoteAddress || 'unknown';
  const windowMs = 15 * 60 * 1000;
  const limit = 8;
  const attempts = (loginAttempts.get(address) || []).filter((time) => now - time < windowMs);
  if (attempts.length >= limit) {
    const retryAfter = Math.ceil((windowMs - (now - attempts[0])) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many attempts. Wait a while, then try again.' });
    loginAttempts.set(address, attempts);
    return false;
  }
  attempts.push(now);
  loginAttempts.set(address, attempts);
  if (loginAttempts.size > 1000) {
    for (const [key, times] of loginAttempts) {
      if (!times.some((time) => now - time < windowMs)) loginAttempts.delete(key);
    }
  }
  return true;
}

app.get('/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.css'));
});

app.get('/login.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.js'));
});

app.post('/api/access/login', (req, res) => {
  if (!APP_ACCESS_KEYS.length) {
    return res.status(503).json({ error: 'App access is not configured. Set APP_ACCESS_KEY in the server .env file.' });
  }
  if (!checkLoginRateLimit(req, res)) return;

  const submittedKey = typeof req.body?.key === 'string' ? req.body.key : '';
  if (submittedKey.length > 512) {
    return res.status(401).json({ error: 'That access key is not correct.' });
  }
  const submittedHash = crypto.createHash('sha256').update(submittedKey).digest();
  const matchingKey = APP_ACCESS_KEYS.find(({ key }) => {
    const expectedHash = crypto.createHash('sha256').update(key).digest();
    return crypto.timingSafeEqual(expectedHash, submittedHash);
  });
  if (!matchingKey) {
    return res.status(401).json({ error: 'That access key is not correct.' });
  }

  loginAttempts.delete(req.ip || req.socket.remoteAddress || 'unknown');
  createAccessCookie(req, res, matchingKey.key);
  res.json({ ok: true });
});

app.post('/api/access/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${ACCESS_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const canViewAnalytics = getAccessSessionAnalyticsPermission(req);
  if (canViewAnalytics !== null) {
    req.canViewAnalytics = canViewAnalytics;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Enter the app access key to continue.' });
  }
  return res.redirect('/login');
});

app.get('/api/access/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ canViewAnalytics: req.canViewAnalytics });
});

function pruneAnalyticsSessions(now = Date.now()) {
  for (const [sessionId, session] of analyticsSessions) {
    if (now - session.lastSeenAt > ANALYTICS_ACTIVE_WINDOW_MS) {
      analyticsSessions.delete(sessionId);
    }
  }
}

app.get('/analytics', (req, res) => {
  if (!req.canViewAnalytics) {
    return res.status(403).send('Analytics access is restricted.');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});

app.get('/api/analytics/summary', (req, res) => {
  if (!req.canViewAnalytics) {
    return res.status(403).json({ error: 'Analytics access is restricted.' });
  }
  pruneAnalyticsSessions();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    activeUsers: new Set([...analyticsSessions.values()].map((session) => session.visitorId)).size,
    pageViews: analyticsPageViews,
    uniqueVisitors: analyticsVisitors.size,
    dailyViews: [...analyticsDailyViews.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-14)
      .map(([date, views]) => ({ date, views }))
  });
});

app.post('/api/analytics/heartbeat', (req, res) => {
  if (!req.canViewAnalytics) {
    return res.status(403).json({ error: 'Analytics access is restricted.' });
  }
  const visitorId = req.body?.visitorId;
  const sessionId = req.body?.sessionId;
  const validId = (value) => typeof value === 'string' && /^[\w-]{16,64}$/.test(value);
  if (!validId(visitorId) || !validId(sessionId)) {
    return res.status(400).json({ error: 'Invalid analytics session.' });
  }

  const now = Date.now();
  pruneAnalyticsSessions(now);
  const existingSession = analyticsSessions.get(sessionId);
  if (!existingSession) {
    analyticsPageViews += 1;
    const today = new Date(now).toISOString().slice(0, 10);
    analyticsDailyViews.set(today, (analyticsDailyViews.get(today) || 0) + 1);
  }
  analyticsSessions.set(sessionId, { visitorId, lastSeenAt: now });
  analyticsVisitors.add(visitorId);
  res.sendStatus(204);
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

async function readApiResponse(response) {
  const text = await response.text();
  if (!text) return { text: '' };

  try {
    return { ...JSON.parse(text), text };
  } catch {
    return { text };
  }
}

function getApiError(data, response) {
  const metadata = data.error?.metadata;
  const detail = [
    metadata?.raw,
    metadata?.provider_name,
    metadata?.message,
    data.error?.message,
    data.error,
    data.detail,
    data.message,
    data.text,
    response.statusText
  ].map((value) => (
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? JSON.stringify(value)
        : ''
  )).find((value) => value.trim());
  return detail ? detail.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

function getRequestError(error) {
  const code = error.cause?.code;
  const host = error.cause?.hostname || 'AI provider';
  if (code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return `Could not resolve AI provider host ${host} (${code}). Check your internet or DNS connection, then retry.`;
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `Could not connect to the AI provider${code ? ` (${code})` : ''}. Check your internet connection and retry.`;
  }
  return error.message || 'Internal server error';
}

function getProvider(provider) {
  const config = providers[provider];
  if (!config) {
    const error = new Error('Choose a supported AI provider.');
    error.status = 400;
    throw error;
  }
  return config;
}

function getProviderApiKey(req, res, provider) {
  const apiKey = req.get('x-provider-api-key')?.trim();
  if (!apiKey) {
    res.status(401).json({ error: `Add your ${providers[provider].name} API key in API Key settings to continue.` });
    return null;
  }
  return apiKey;
}

function providerAuthorizationHeaders(apiKey, provider, requestType) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (provider === 'google-ai-studio' && requestType === 'models') {
    headers.set('x-goog-api-key', apiKey);
    return headers;
  }

  headers.set('Authorization', `Bearer ${apiKey}`);
  if (provider === 'openrouter') {
    headers.set('X-Title', 'Grok Chat');
    headers.set('HTTP-Referer', 'http://localhost');
  }
  return headers;
}

function isGoogleFreeModel(modelId) {
  return /^gemini-[\w.-]*flash[\w.-]*$/i.test(modelId);
}

function isFreeOpenRouterModel(model) {
  return typeof model?.id === 'string'
    && model.id.endsWith(':free')
    && Number(model.pricing?.prompt) === 0
    && Number(model.pricing?.completion) === 0;
}

function getDiscoveredCapabilities(provider, model) {
  if (provider === 'nvidia-nim') return NVIDIA_MODEL_CAPABILITIES[model.id] || [];
  if (provider === 'google-ai-studio') {
    return isGoogleFreeModel(model.id) ? ['image', 'video'] : [];
  }
  return model.architecture?.input_modalities?.includes('image') ? ['image', 'video'] : [];
}

app.get('/api/models', async (req, res) => {
  try {
    const provider = req.query.provider;
    const config = getProvider(provider);
    const apiKey = getProviderApiKey(req, res, provider);
    if (!apiKey) return;

    const response = await fetchWithDnsRetry(config.modelsUrl, {
      headers: providerAuthorizationHeaders(apiKey, provider, 'models')
    });
    const data = await readApiResponse(response);

    if (!response.ok) {
      const detail = getApiError(data, response);
      throw new Error(`Model discovery failed (${response.status})${detail ? `: ${detail}` : '.'}`);
    }

    const catalog = config.modelsFormat === 'google' ? data.models : data.data;
    const models = Array.isArray(catalog)
      ? catalog
          .map((model) => ({
            source: model,
            id: config.modelsFormat === 'google'
              ? model.name?.replace(/^models\//, '')
              : model.id
          }))
          .filter(({ source, id }) => {
            if (typeof id !== 'string') return false;
            if (provider === 'nvidia-nim') return !['nvidia/vila'].includes(id);
            if (provider === 'openrouter') return isFreeOpenRouterModel(source);
            if (provider === 'google-ai-studio') {
              return isGoogleFreeModel(id) && source.supportedGenerationMethods?.includes('generateContent');
            }
            return true;
          })
          .map(({ source, id }) => ({
            id,
            name: provider === 'openrouter'
              ? `${source.name || id} · free`
              : (source.displayName || source.name || id),
            capabilities: getDiscoveredCapabilities(provider, { ...source, id })
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    discoveredModelCapabilities.set(provider, new Map(models.map((model) => [model.id, model.capabilities])));
    res.json({ models });
  } catch (error) {
    console.error('Error in /api/models:', error);
    res.status(error.status || 502).json({ error: getRequestError(error) });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, provider, model } = req.body;
    if (!Array.isArray(messages) || !provider || !model) {
      return res.status(400).json({
        error: 'Missing or invalid required fields: messages, provider, or model.'
      });
    }

    const config = getProvider(provider);
    const apiKey = getProviderApiKey(req, res, provider);
    if (!apiKey) return;

    if (provider === 'openrouter' && !model.endsWith(':free')) {
      return res.status(400).json({ error: 'Only OpenRouter models with the :free suffix are allowed.' });
    }
    if (provider === 'google-ai-studio' && !isGoogleFreeModel(model)) {
      return res.status(400).json({ error: 'Only Gemini Flash models with free-tier access are allowed.' });
    }
    if (provider !== 'nvidia-nim' && !discoveredModelCapabilities.get(provider)?.has(model)) {
      return res.status(400).json({ error: 'Scan the provider model list and choose one of its available models.' });
    }
    const mediaTypes = [...new Set(messages.flatMap((message) => message.mediaTypes || []))];
    const capabilities = provider === 'nvidia-nim'
      ? NVIDIA_MODEL_CAPABILITIES[model] || []
      : discoveredModelCapabilities.get(provider)?.get(model) || [];
    const unsupportedType = mediaTypes.find((type) => !capabilities.includes(type));
    if (unsupportedType) {
      return res.status(400).json({
        error: `The selected model does not support ${unsupportedType} input. Choose a model from the ${unsupportedType}-capable group.`
      });
    }

    const apiMessages = messages.map(({ mediaTypes: ignored, ...message }) => message);
    const response = await fetchWithProviderRetry(config.chatUrl, {
      method: 'POST',
      headers: providerAuthorizationHeaders(apiKey, provider),
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: GROK_STYLE_SYSTEM_PROMPT }, ...apiMessages],
        stream: provider !== 'openrouter'
      })
    });

    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
      if (!res.destroyed) res.end();
      return;
    }

    const data = await readApiResponse(response);

    if (!response.ok) {
      const detail = getApiError(data, response);
      const isOpenRouterAuthError = provider === 'openrouter' && response.status === 401;
      const isOpenRouterMediaError = provider === 'openrouter'
        && response.status === 400
        && mediaTypes.length > 0;
      const error = response.status === 404
        ? new Error(`Model "${model}" is not available for this ${config.name} API key. Choose another chat model.`)
        : isOpenRouterAuthError
          ? new Error('OpenRouter rejected the API key or did not receive it. Re-enter your OpenRouter key and try again.')
          : isOpenRouterMediaError
            ? new Error(`This OpenRouter free model rejected the image frames from your video${detail ? `: ${detail}` : '. Try another image-capable free model.'}`)
            : new Error(`${config.name} request failed (${response.status})${detail ? `: ${detail}` : '.'}`);
      if (response.status === 404) {
        error.status = 404;
        error.unavailableModel = model;
      }
      if (isOpenRouterAuthError) {
        error.status = 401;
        error.providerAuthenticationError = true;
      }
      if (isOpenRouterMediaError) {
        error.status = 400;
        error.unavailableModel = model;
        error.unsupportedMediaModel = true;
      }
      throw error;
    }

    const aiMessage = data.choices?.[0]?.message?.content;
    if (typeof aiMessage !== 'string' && !Array.isArray(aiMessage)) {
      throw new Error('Provider response did not include a message. Check the selected model.');
    }

    res.json({ message: aiMessage });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    if (res.headersSent) {
      if (!res.destroyed) {
        res.write(`data: ${JSON.stringify({ error: getRequestError(error) })}\n\n`);
        res.end();
      }
      return;
    }
    res.status(error.status || 502).json({
      error: getRequestError(error),
      ...(error.unavailableModel && { unavailableModel: error.unavailableModel }),
      ...(error.providerAuthenticationError && { providerAuthenticationError: true }),
      ...(error.unsupportedMediaModel && { unsupportedMediaModel: true })
    });
  }
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: `Request exceeds this server's ${CHAT_BODY_LIMIT} JSON body limit. Increase CHAT_BODY_LIMIT and the hosting platform's request limit.`
    });
  }
  next(error);
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
