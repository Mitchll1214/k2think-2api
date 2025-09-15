const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fetch = require('node-fetch');
const { Readable } = require('stream');
const crypto = require('crypto');

// Define interfaces (using JSDoc comments for better IDE support)
/**
 * @typedef {Object} ChatMessage
 * @property {string} role
 * @property {string} content
 */

/**
 * @typedef {Object} ChatCompletionRequest
 * @property {string} model
 * @property {ChatMessage[]} messages
 * @property {boolean} [stream]
 * @property {number} [temperature]
 */

// Constants
const K2THINK_API_URL = "https://www.k2think.ai/api/guest/chat/completions";
const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Content-Type": "application/json",
  "Accept": "text/event-stream",
  "Pragma": "no-cache",
  "Origin": "https://www.k2think.ai",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "Referer": "https://www.k2think.ai/guest",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,zh-TW;q=0.5",
};

const PORT = process.env.PORT || 2001;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || '';

// Create Express app
const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Utility functions
function parseApiKeys(keysString) {
  if (!keysString) return [];
  return keysString.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

function createErrorResponse(res, message, status) {
  return res.status(status).json({ error: message });
}

// Extract reasoning and answer content
function extractReasoningAndAnswer(content) {
  if (!content) return ["", ""];
  try {
    const reasoningPattern = /<details type="reasoning"[^>]*>.*?<summary>.*?<\/summary>(.*?)<\/details>/s;
    const reasoningMatch = content.match(reasoningPattern);
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : "";
    
    const answerPattern = /<answer>(.*?)<\/answer>/s;
    const answerMatch = content.match(answerPattern);
    const answer = answerMatch ? answerMatch[1].trim() : "";
    
    return [reasoning, answer];
  } catch (error) {
    console.error("Error extracting reasoning and answer:", error);
    return ["", ""];
  }
}

// Calculate delta content
function calculateDeltaContent(previous, current) {
  if (!previous) return current;
  if (!current) return "";
  try {
    return current.substring(previous.length);
  } catch (error) {
    console.error("Error calculating delta content:", error);
    return current;
  }
}

// Extract content from JSON
function extractContentFromJson(obj) {
  if (typeof obj !== "object" || obj === null) return ["", false, null, null];
  
  if (obj.usage) return ["", false, obj.usage, null];
  if (obj.done === true) return ["", true, obj.usage, null];
  
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const delta = obj.choices[0].delta || {};
    const role = delta.role || null;
    const contentPiece = delta.content || "";
    return [contentPiece, false, null, role];
  }
  
  if (typeof obj.content === "string") return [obj.content, false, null, null];
  
  return ["", false, null, null];
}

// Create stream response chunk
function createStreamChunk(streamId, createdTime, model, delta, finishReason) {
  const choices = [{
    delta,
    index: 0,
    ...(finishReason && { finish_reason: finishReason })
  }];
  
  const response = {
    id: streamId,
    object: "chat.completion.chunk",
    created: createdTime,
    model,
    choices
  };
  
  return `data: ${JSON.stringify(response)}\n\n`;
}

// Stream generator for Express
function createK2Stream(payload, model) {
  const streamId = `chatcmpl-${crypto.randomUUID()}`;
  const createdTime = Math.floor(Date.now() / 1000);
  let accumulatedContent = "";
  let previousReasoning = "";
  let previousAnswer = "";
  let reasoningPhase = true;

  const stream = new Readable({
    read() {}
  });

  (async () => {
    try {
      // Send initial role
      stream.push(createStreamChunk(streamId, createdTime, model, { role: "assistant" }));

      const response = await fetch(K2THINK_API_URL, {
        method: "POST",
        headers: DEFAULT_HEADERS,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`K2Think API error: ${response.status} ${response.statusText}`, errorBody);
        stream.destroy(new Error(`K2Think API error: ${response.status} ${response.statusText}`));
        return;
      }
      
      let buffer = "";
      response.body.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          
          const dataStr = line.substring(5).trim();
          if (!dataStr || ["-1", "[DONE]", "DONE", "done"].includes(dataStr)) {
            continue;
          }
          
          let contentPiece = "";
          try {
            const obj = JSON.parse(dataStr);
            const [piece, isDone] = extractContentFromJson(obj);
            contentPiece = piece;
            if (isDone) return;
          } catch {
            contentPiece = dataStr;
          }
          
          if (contentPiece) {
            accumulatedContent = contentPiece;
            const [currentReasoning, currentAnswer] = extractReasoningAndAnswer(accumulatedContent);
            
            if (reasoningPhase && currentReasoning) {
              const reasoningDelta = calculateDeltaContent(previousReasoning, currentReasoning);
              if (reasoningDelta.trim()) {
                stream.push(createStreamChunk(streamId, createdTime, model, { reasoning_content: reasoningDelta }));
                previousReasoning = currentReasoning;
              }
            }
            
            if (currentAnswer && reasoningPhase) {
              reasoningPhase = false;
              if (currentReasoning && currentReasoning !== previousReasoning) {
                const reasoningDelta = calculateDeltaContent(previousReasoning, currentReasoning);
                if (reasoningDelta.trim()) {
                  stream.push(createStreamChunk(streamId, createdTime, model, { reasoning_content: reasoningDelta }));
                }
              }
            }
            
            if (!reasoningPhase && currentAnswer) {
              const answerDelta = calculateDeltaContent(previousAnswer, currentAnswer);
              if (answerDelta.trim()) {
                stream.push(createStreamChunk(streamId, createdTime, model, { content: answerDelta }));
                previousAnswer = currentAnswer;
              }
            }
          }
        }
      });

      response.body.on('end', () => {
        // End stream
        stream.push(createStreamChunk(streamId, createdTime, model, {}, "stop"));
        stream.push("data: [DONE]\n\n");
        stream.push(null);
      });

      response.body.on('error', (error) => {
        console.error("Stream error:", error);
        stream.destroy(error);
      });
      
    } catch (error) {
      console.error("Error creating K2 stream:", error);
      stream.destroy(error);
    }
  })();

  return stream;
}

// Aggregate stream response
async function aggregateStream(response) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const pieces = [];
    
    response.body.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        
        const dataStr = line.substring(5).trim();
        if (!dataStr || ["-1", "[DONE]", "DONE", "done"].includes(dataStr)) {
          continue;
        }
        
        try {
          const obj = JSON.parse(dataStr);
          const [piece, isDone] = extractContentFromJson(obj);
          if (isDone) continue;
          if (piece) pieces.push(piece);
        } catch {
          pieces.push(dataStr);
        }
      }
    });
    
    response.body.on('end', () => {
      const accumulatedContent = pieces.join("");
      const [, answerContent] = extractReasoningAndAnswer(accumulatedContent);
      resolve(answerContent.replace(/\\n/g, "\n"));
    });
    
    response.body.on('error', reject);
  });
}

// Get models list
function getModelsList() {
  return {
    object: "list",
    data: [{
      id: "MBZUAI-IFM/K2-Think",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "talkai"
    }]
  };
}

// Authentication middleware
function authenticateApiKey(req, res, next) {
  if (!CLIENT_API_KEY) {
    return next();
  }
  
  const validKeys = new Set(parseApiKeys(CLIENT_API_KEY));
  const authHeader = req.headers.authorization;
  let apiKey = authHeader;
  
  if (authHeader?.startsWith("Bearer ")) {
    apiKey = authHeader.substring(7);
  }
  
  if (!authHeader && validKeys.size > 0) {
    return createErrorResponse(res, "API key required", 401);
  }
  
  if (validKeys.size > 0 && (!apiKey || !validKeys.has(apiKey))) {
    return createErrorResponse(res, "Invalid API key", 401);
  }
  
  next();
}

// Routes
app.get('/v1/models', authenticateApiKey, (req, res) => {
  res.json(getModelsList());
});

app.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  const { body } = req;
  
  if (!body.messages || body.messages.length === 0) {
    return createErrorResponse(res, "Messages required", 400);
  }
  
  // Build K2Think compatible message list
  const k2Messages = [];
  let systemPrompt = "";
  
  for (const msg of body.messages) {
    if (msg.role === "system") {
      systemPrompt = msg.content;
    } else if (msg.role === "user" || msg.role === "assistant") {
      k2Messages.push({ role: msg.role, content: msg.content });
    }
  }
  
  if (systemPrompt) {
    const userMsg = k2Messages.find(m => m.role === "user");
    if (userMsg) {
      userMsg.content = `${systemPrompt}\n\n${userMsg.content}`;
    } else {
      k2Messages.unshift({ role: "user", content: systemPrompt });
    }
  }
  
  const payload = {
    stream: true, // Always request stream, aggregate if client asks non-stream
    model: body.model,
    messages: k2Messages,
    params: {}
  };
  
  try {
    if (body.stream) {
      // Streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      
      const stream = createK2Stream(payload, body.model);
      stream.pipe(res);
      
      req.on('close', () => {
        stream.destroy();
      });
      
    } else {
      // Non-streaming response
      const response = await fetch(K2THINK_API_URL, {
        method: "POST",
        headers: DEFAULT_HEADERS,
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`K2Think API error: ${response.status} ${response.statusText}`);
      }
      
      const content = await aggregateStream(response);
      const chatResponse = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          message: { role: "assistant", content },
          index: 0,
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(chatResponse);
    }
  } catch (error) {
    console.error("Error handling chat completion:", error);
    return createErrorResponse(res, "Internal server error", 500);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'k2think-2api',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 K2Think-2API server is running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 Models endpoint: http://localhost:${PORT}/v1/models`);
  console.log(`💬 Chat endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`🔑 API Key auth: ${CLIENT_API_KEY ? 'Enabled' : 'Disabled'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});
