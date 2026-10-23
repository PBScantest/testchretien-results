// api/chat.js - Vercel Serverless Function
const fetch = require('node-fetch');

// Rate limiting simple (en mémoire)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 10; // 10 requêtes par minute

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

module.exports = async (req, res) => {
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
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
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
    const sanitizedSystem = sanitizeInput(systemInstruction || '');

    // Construction du prompt
    let promptComplet = sanitizedSystem + "\n\n";
    
    if (context && Array.isArray(context)) {
      const lastMessages = context.slice(-6);
      lastMessages.forEach(msg => {
        const role = msg.role === 'user' ? 'Utilisateur' : 'Assistant';
        const content = sanitizeInput(msg.content);
        promptComplet += `${role}: ${content}\n`;
      });
    }
    
    promptComplet += `Utilisateur: ${sanitizedMessage}\nAssistant:`;

    // Appel à Gemini API (clé sécurisée)
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error('GEMINI_API_KEY not configured');
      return res.status(500).json({ error: 'Configuration serveur manquante' });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptComplet }] }]
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      return res.status(500).json({ 
        error: 'Erreur de communication avec l\'IA' 
      });
    }

    const data = await response.json();
    const aiResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiResponse) {
      return res.status(500).json({ 
        error: 'Réponse IA invalide' 
      });
    }

    return res.status(200).json({ response: aiResponse });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ 
      error: 'Une erreur technique est survenue' 
    });
  }
};