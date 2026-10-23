// api/chat_claude.js - Vercel Serverless Function avec Claude (Anthropic)

// Rate limiting simple (en mémoire)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 120000; // 2 minute
const MAX_REQUESTS = 45; // 10 requêtes par minute

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = rateLimitMap.get(ip) || [];
  
  // Nettoyer les anciennes requêtes
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
  return true;
}

function sanitizeInput(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/[<>\"\']/g, '')
    .substring(0, 1000)
    .trim();
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ 
      error: 'Trop de requêtes. Veuillez patienter une minute.' 
    });
  }

  try {
    const { message, systemInstruction, context } = req.body;

    // Validation
    if (!message || message.length > 2000) {
      return res.status(400).json({ error: 'Message invalide' });
    }

    const sanitizedMessage = sanitizeInput(message);
    const sanitizedSystem = sanitizeInput(systemInstruction || 'Tu es un coach en développement personnel bienveillant et professionnel.');

    // Construction des messages pour Claude
    const messages = [];
    
    // Ajouter le contexte de conversation
    if (context && Array.isArray(context)) {
      const lastMessages = context.slice(-6);
      lastMessages.forEach(msg => {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: sanitizeInput(msg.content)
        });
      });
    }
    
    // Ajouter le message actuel
    messages.push({
      role: 'user',
      content: sanitizedMessage
    });

    // Récupérer la clé API Claude
    const apiKey = process.env.CLAUDE_API_KEY;
    
    if (!apiKey) {
      console.error('CLAUDE_API_KEY not configured');
      return res.status(500).json({ error: 'Configuration serveur manquante' });
    }

    // Appel à l'API Claude (Anthropic)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5', // modèles dispo : https://platform.claude.com/docs/fr/about-claude/models/overview
        max_tokens: 4000,
        system: sanitizedSystem,
        messages: messages
      })
    });

    // Vérifier le type de contenu
    const contentType = response.headers.get('content-type');
    
    if (!response.ok) {
      let errorMessage = 'Erreur de communication avec l\'IA';
      
      try {
        if (contentType && contentType.includes('application/json')) {
          const errorData = await response.json();
          errorMessage = errorData.error?.message || errorData.message || errorMessage;
          console.error('Claude API error:', errorData);
        } else {
          const errorText = await response.text();
          console.error('Claude API error (non-JSON):', errorText);
          errorMessage = `Erreur API (${response.status})`;
        }
      } catch (parseError) {
        console.error('Error parsing Claude error:', parseError);
      }
      
      return res.status(500).json({ error: errorMessage });
    }

    // Parser la réponse JSON
    let data;
    try {
      data = await response.json();
    } catch (jsonError) {
      console.error('JSON parse error:', jsonError);
      const rawText = await response.text();
      console.error('Raw response:', rawText);
      return res.status(500).json({ 
        error: 'Réponse API invalide' 
      });
    }

    // Extraire la réponse de Claude
    const aiResponse = data.content?.[0]?.text;

    if (!aiResponse) {
      console.error('Invalid AI response structure:', data);
      return res.status(500).json({ 
        error: 'Réponse IA invalide' 
      });
    }

    return res.status(200).json({ response: aiResponse });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      error: 'Une erreur technique est survenue',
      details: error.message
    });
  }
}