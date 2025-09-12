// src/index.js

// Define interfaces (using JSDoc comments for better IDE support in plain JS)
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

/**
 * @typedef {Object} ModelInfo
 * @property {string} id
 * @property {string} object
 * @property {number} created
 * @property {string} owned_by
 */

/**
 * @typedef {Object} ModelList
 * @property {"list"} object
 * @property {ModelInfo[]} data
 */

/**
 * @typedef {Object} ChatCompletionChoice
 * @property {ChatMessage} message
 * @property {number} index
 * @property {string} finish_reason
 */

/**
 * @typedef {Object} ChatCompletionResponse
 * @property {string} id
 * @property {"chat.completion"} object
 * @property {number} created
 * @property {string} model
 * @property {ChatCompletionChoice[]} choices
 * @property {{prompt_tokens: number, completion_tokens: number, total_tokens: number}} usage
 */

/**
 * @typedef {Object} StreamChoice
 * @property {Record<string, unknown>} delta
 * @property {number} index
 * @property {string} [finish_reason]
 */

/**
 * @typedef {Object} StreamResponse
 * @property {string} id
 * @property {"chat.completion.chunk"} object
 * @property {number} created
 * @property {string} model
 * @property {StreamChoice[]} choices
 */

/**
 * @typedef {Object} ApiResponse
 * @property {unknown} [usage]
 * @property {boolean} [done]
 * @property {Array<{delta?: {role?: string, content?: string}}>} [choices]
 * @property {string} [content]
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

// Add Node.js required modules
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const { Readable } = require('stream');
const fetch = require('node-fetch');

// Utility functions
function parseApiKeys(keysString) {
  if (!keysString) return [];
  return keysString.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

function createErrorResponse(message, status) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message })
  };
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

// Stream generator - converted to a function that returns a ReadableStream
function createK2Stream(payload, headers, model) {
  const streamId = `chatcmpl-${crypto.randomUUID()}`;
  const createdTime = Math.floor(Date.now() / 1000);
  let accumulatedContent = "";
  let previousReasoning = "";
  let previousAnswer = "";
  let reasoningPhase = true;

  return new Readable({
    async read() {
      // Send initial role
      this.push(createStreamChunk(streamId, createdTime, model, { role: "assistant" }));

      let response;
      try {
        response = await fetch(K2THINK_API_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(payload)
        });
      } catch (error) {
        console.error("Error fetching from K2Think API:", error);
        this.destroy(error);
        return;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`K2Think API error: ${response.status} ${response.statusText}`, errorBody);
        this.destroy(new Error(`K2Think API error: ${response.status} ${response.statusText}`));
        return;
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
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
              if (isDone) break;
            } catch {
              contentPiece = dataStr;
            }
            
            if (contentPiece) {
              accumulatedContent = contentPiece;
              const [currentReasoning, currentAnswer] = extractReasoningAndAnswer(accumulatedContent);
              
              if (reasoningPhase && currentReasoning) {
                const reasoningDelta = calculateDeltaContent(previousReasoning, currentReasoning);
                if (reasoningDelta.trim()) {
                  this.push(createStreamChunk(streamId, createdTime, model, { reasoning_content: reasoningDelta }));
                  previousReasoning = currentReasoning;
                }
              }
              
              if (currentAnswer && reasoningPhase) {
                reasoningPhase = false;
                if (currentReasoning && currentReasoning !== previousReasoning) {
                  const reasoningDelta = calculateDeltaContent(previousReasoning, currentReasoning);
                  if (reasoningDelta.trim()) {
                    this.push(createStreamChunk(streamId, createdTime, model, { reasoning_content: reasoningDelta }));
                  }
                }
              }
              
              if (!reasoningPhase && currentAnswer) {
                const answerDelta = calculateDeltaContent(previousAnswer, currentAnswer);
                if (answerDelta.trim()) {
                  this.push(createStreamChunk(streamId, createdTime, model, { content: answerDelta }));
                  previousAnswer = currentAnswer;
                }
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // End stream
      this.push(createStreamChunk(streamId, createdTime, model, {}, "stop"));
      this.push("data: [DONE]\n\n");
      this.push(null); // Signal end of stream
    },
    destroy(error, callback) {
      console.log("Stream was destroyed:", error);
      if (callback) callback();
    }
  });
}

// Aggregate stream response
async function aggregateStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pieces = [];
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
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
    }
  } finally {
    reader.releaseLock();
  }
  
  const accumulatedContent = pieces.join("");
  const [, answerContent] = extractReasoningAndAnswer(accumulatedContent);
  return answerContent.replace(/\\n/g, "\n");
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

// Handle chat completion request
async function handleChatCompletion(req, env) {
  // Authentication middleware
  const clientApiKeys = env.CLIENT_API_KEY;
  if (clientApiKeys) {
    const validKeys = new Set(parseApiKeys(clientApiKeys));
    const authHeader = req.headers.authorization;
    let apiKey = authHeader;
    if (authHeader?.startsWith("Bearer ")) {
      apiKey = authHeader.substring(7);
    }
    if (!authHeader && validKeys.size > 0) {
      return createErrorResponse("API key required", 401);
    }
    if (validKeys.size > 0 && (!apiKey || !validKeys.has(apiKey))) {
      return createErrorResponse("Invalid API key", 401);
    }
  }

  let body;
  try {
    body = JSON.parse(req.body);
  } catch (error) {
    return createErrorResponse("Invalid JSON", 400);
  }
  
  if (!body.messages || body.messages.length === 0) {
    return createErrorResponse("Messages required", 400);
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
      const stream = createK2Stream(payload, DEFAULT_HEADERS, body.model);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        },
        body: stream
      };
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
      
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chatResponse)
      };
    }
  } catch (error) {
    console.error("Error handling chat completion:", error);
    return createErrorResponse("Internal server error", 500);
  }
}

// Create Node.js HTTP server
function createServer(env) {
  return http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Collect request body data
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      req.body = body;
      
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      if (req.method === "GET" && pathname === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getModelsList()));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        const result = await handleChatCompletion(req, env);
        
        // Handle streaming response
        if (result.body && typeof result.body.pipe === 'function') {
          res.writeHead(result.statusCode, result.headers);
          result.body.pipe(res);
          return;
        }
        
        // Handle regular response
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });
  });
}

// Start server
function startServer(port = 2004) {
  const env = {
    CLIENT_API_KEY: process.env.CLIENT_API_KEY || ''
  };
  
  const server = createServer(env);
  server.listen(port, () => {
    console.log(`k2think-2api server running at http://localhost:${port}`);
  });
}

// If this file is run directly, start the server
if (require.main === module) {
  startServer();
}

module.exports = { startServer };
