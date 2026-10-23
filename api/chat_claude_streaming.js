// api/chat_claude_streaming.js - Vercel Serverless Function avec Claude (Anthropic) - VERSION STREAMING

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
    .replace(/[<>"']/g, '')
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

    // ============================================
    // STREAMING : Configuration des headers SSE
    // ============================================
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Appel à l'API Claude avec streaming activé
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', // Modèle Claude Sonnet 4.5
        max_tokens: 4000,
        system: sanitizedSystem,
        messages: messages,
        stream: true // ✅ Activation du streaming
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Claude API error:', errorData);
      res.write(`data: ${JSON.stringify({ error: errorData.error?.message || 'Erreur API' })}\n\n`);
      return res.end();
    }

    // ============================================
    // STREAMING : Lecture du flux de données
    // ============================================
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          // Envoyer un signal de fin
          res.write('data: [DONE]\n\n');
          res.end();
          break;
        }

        // Décoder le chunk reçu
        buffer += decoder.decode(value, { stream: true });
        
        // Traiter les lignes complètes
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Garder la dernière ligne incomplète

        for (const line of lines) {
          const trimmedLine = line.trim();
          
          // Ignorer les lignes vides ou de ping
          if (!trimmedLine || trimmedLine === 'event: ping') {
            continue;
          }

          // Traiter les événements SSE
          if (trimmedLine.startsWith('data:')) {
            const jsonStr = trimmedLine.slice(5).trim();
            
            // Ignorer les lignes vides après "data:"
            if (!jsonStr) continue;

            try {
              const data = JSON.parse(jsonStr);
              
              // Type d'événement : content_block_delta (contient le texte)
              if (data.type === 'content_block_delta' && data.delta?.text) {
                // Envoyer le texte au client
                res.write(`data: ${JSON.stringify({ 
                  type: 'text', 
                  content: data.delta.text 
                })}\n\n`);
              }
              
              // Type d'événement : message_stop (fin du streaming)
              else if (data.type === 'message_stop') {
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              
              // Type d'événement : error
              else if (data.type === 'error') {
                res.write(`data: ${JSON.stringify({ 
                  type: 'error', 
                  content: data.error?.message || 'Erreur inconnue' 
                })}\n\n`);
                res.end();
                return;
              }
              
            } catch (parseError) {
              console.error('Error parsing SSE data:', parseError, jsonStr);
              // Continuer même en cas d'erreur de parsing
            }
          }
        }
      }
    } catch (streamError) {
      console.error('Streaming error:', streamError);
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        content: 'Erreur lors du streaming' 
      })}\n\n`);
      res.end();
    }

  } catch (error) {
    console.error('Server error:', error);
    
    // Si les headers n'ont pas encore été envoyés, renvoyer une erreur JSON
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'Une erreur technique est survenue',
        details: error.message
      });
    }
    
    // Sinon, envoyer l'erreur via SSE
    res.write(`data: ${JSON.stringify({ 
      type: 'error', 
      content: error.message 
    })}\n\n`);
    res.end();
  }
}