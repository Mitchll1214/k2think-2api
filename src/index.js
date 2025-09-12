const http = require('http');
const url = require('url');
const querystring = require('querystring');
const { createServer: createHttpServer } = require('http');

// K2Think API配置
const K2THINK_API_URL = 'https://www.k2think.ai/api/guest/chat/completions';

// 请求头配置
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'k2think-2api/1.0.0'
};

// 解析SSE数据流
async function aggregateStream(response) {
  // 检查 response.body 是否存在
  if (!response.body) {
    throw new Error('Response body is missing');
  }

  // 在 Node.js 环境中，response.body 是一个 Readable 流
  if (typeof response.body.on === 'function') {
    // Node.js 环境
    return new Promise((resolve, reject) => {
      let data = '';
      
      response.body.on('data', (chunk) => {
        data += chunk.toString();
      });
      
      response.body.on('end', () => {
        try {
          // 移除 "data: " 前缀和最后的 "[DONE]"
          const jsonStrings = data
            .split('\n')
            .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
            .map(line => line.substring(6)); // 移除 "data: " 前缀
          
          const jsonObjects = jsonStrings.map(str => JSON.parse(str));
          resolve(jsonObjects);
        } catch (error) {
          reject(error);
        }
      });
      
      response.body.on('error', (error) => {
        reject(error);
      });
    });
  } else {
    // 浏览器环境或其他支持 ReadableStream 的环境
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = [];
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const jsonStr = line.substring(6); // 移除 "data: " 前缀
            result.push(JSON.parse(jsonStr));
          } catch (error) {
            console.error('Error parsing JSON:', error);
          }
        }
      }
    }
    
    return result;
  }
}

// 创建请求处理函数
function createRequestHandler(env) {
  return async function (req, res) {
    // 处理CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url);
    const pathname = parsedUrl.pathname;
    
    try {
      if (pathname === '/v1/models') {
        handleModels(req, res);
      } else if (pathname === '/v1/chat/completions') {
        await handleChatCompletion(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Not Found',
            type: 'not_found_error',
            code: 404
          }
        }));
      }
    } catch (error) {
      console.error('Error handling request:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Internal Server Error',
          type: 'internal_server_error',
          code: 500
        }
      }));
    }
  };
}

// 处理模型列表
function handleModels(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list',
    data: [
      {
        id: 'MBZUAI-IFM/K2-Think',
        object: 'model',
        created: 1677610602,
        owned_by: 'MBZUAI-IFM'
      }
    ]
  }));
}

// 处理聊天完成请求
async function handleChatCompletion(req, res) {
  try {
    const payload = req.body;
    
    // 转发请求到 K2Think API
    const response = await fetch(K2THINK_API_URL, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('K2Think API error:', response.status, errorText);
      return res.status(response.status).json({
        error: {
          message: `K2Think API error: ${response.status}`,
          type: 'api_error',
          code: response.status
        }
      });
    }
    
    // 检查是否是流式响应
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      // 设置响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // 在 Node.js 环境中，使用 pipe 方法直接转发流
      if (typeof response.body.pipe === 'function') {
        // Node.js 环境
        response.body.pipe(res);
      } else {
        // 其他环境
        const reader = response.body.getReader();
        const encoder = new TextEncoder();
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              res.write('data: [DONE]\n\n');
              res.end();
              break;
            }
            
            res.write(value);
          }
        } catch (error) {
          console.error('Error streaming response:', error);
          res.status(500).json({
            error: {
              message: 'Error streaming response',
              type: 'streaming_error',
              code: 500
            }
          });
        }
      }
    } else {
      // 非流式响应
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Error handling chat completion:', error);
    res.status(500).json({
      error: {
        message: error.message,
        type: 'internal_server_error',
        code: 500
      }
    });
  }
}

// 解析请求体
async function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    
    req.on('error', (error) => {
      reject(error);
    });
  });
}

// 创建服务器
function createApiServer(env) {
  const requestHandler = createRequestHandler(env);
  
  const server = createHttpServer(async (req, res) => {
    try {
      // 解析请求体
      if (req.method === 'POST') {
        req.body = await parseRequestBody(req);
      }
      
      requestHandler(req, res);
    } catch (error) {
      console.error('Error handling request:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Internal Server Error',
          type: 'internal_server_error',
          code: 500
        }
      }));
    }
  });
  
  return server;
}

// 启动服务器
function startServer(port = 2004) {
  const env = {
    CLIENT_API_KEY: process.env.CLIENT_API_KEY || ''
  };
  
  const server = createApiServer(env);
  server.listen(port, () => {
    console.log(`k2think-2api server running at http://localhost:${port}`);
  });
  
  // 添加错误处理
  server.on('error', (err) => {
    console.error('Server error:', err);
  });
  
  // 添加未捕获的异常处理
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
  
  // 添加未处理的 Promise 拒绝处理
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });
}

// 导出启动函数
module.exports = { startServer };

// 如果直接运行此文件，则启动服务器
if (require.main === module) {
  startServer();
}
