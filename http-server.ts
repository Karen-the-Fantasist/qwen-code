/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { URL } from 'node:url';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Config } from '@qwen-code/qwen-code-core/dist/src/config/config.js';
import { GeminiClient } from '@qwen-code/qwen-code-core/dist/src/core/client.js';
import { AuthType, createContentGeneratorConfig } from '@qwen-code/qwen-code-core/dist/src/core/contentGenerator.js';
import { executeToolCall } from '@qwen-code/qwen-code-core/dist/src/core/nonInteractiveToolExecutor.js';
import { v4 as uuidv4 } from 'uuid';
import { hostname } from 'node:os';

// SSE stream helper
function writeSSE(res: ServerResponse, data: string) {
  res.write(`data: ${data}\\n\\n`);
}

// Error handling helper
function writeError(res: ServerResponse, error: any) {
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
}

// Create HTTP server
const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.statusCode = 204;
    res.end();
    return;
  }

  // Handle POST requests to /v1/chat/completions
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    try {
      // Collect request body
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const requestBody = JSON.parse(body);
          
          // Extract prompt from messages (simple implementation)
          const messages = requestBody.messages || [];
          const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop();
          const prompt = lastUserMessage?.content || '';
          
          // Check if streaming is requested
          const stream = requestBody.stream !== false; // Default to true if not specified
          
          if (!prompt) {
            if (stream) {
              writeSSE(res, JSON.stringify({ error: 'No prompt provided' }));
              res.end();
            } else {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'No prompt provided' }));
            }
            return;
          }
          
          // Determine auth type based on environment variables
          let authType = AuthType.QWEN_OAUTH; // Default to Qwen OAuth
          if (process.env.OPENAI_API_KEY) {
            authType = AuthType.USE_OPENAI;
          } else if (process.env.GEMINI_API_KEY) {
            authType = AuthType.USE_GEMINI;
          }
          
          console.log('Environment variables:');
          console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET');
          console.log('GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET');
          console.log('QWEN_API_KEY:', process.env.QWEN_API_KEY ? 'SET' : 'NOT SET');
          console.log('Using auth type:', authType);
          console.log('Streaming:', stream);
          
          // Initialize Qwen Code configuration with required parameters
          const config = new Config({
            sessionId: uuidv4(),
            targetDir: process.cwd(),
            authType: authType,
            // Add required parameters with default values
            debugMode: false,
            cwd: process.cwd(),
            model: 'qwen3-coder-plus', // Default model
          });
          
          // Initialize the config to set up tool registry
          await config.initialize();
          
          // Use Qwen Code's built-in content generator config creation
          const contentGeneratorConfig = createContentGeneratorConfig(config, authType);
          
          // Initialize Gemini client
          const geminiClient = new GeminiClient(config);
          await geminiClient.initialize(contentGeneratorConfig);
          
          // Get tool registry
          const toolRegistry = await config.getToolRegistry();
          
          // Send request and stream response
          try {
            if (stream) {
              // Set CORS headers for streaming
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              
              const responseStream = await geminiClient.sendMessageStream(
                [{ text: prompt }],
                undefined, // abortSignal
                'sse-request' // prompt_id
              );
              
              // Process stream and send SSE events
              for await (const event of responseStream) {
                switch (event.type) {
                  case 'content':
                    writeSSE(res, JSON.stringify({
                      id: 'chatcmpl-' + Date.now(),
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: 'qwen-code',
                      choices: [{
                        index: 0,
                        delta: { content: event.value },
                        finish_reason: null
                      }]
                    }));
                    break;
                    
                  case 'tool_call_request':
                    // Execute the tool call
                    const toolCallRequest = event.value;
                    const toolResponse = await executeToolCall(
                      config,
                      toolCallRequest,
                      toolRegistry,
                      undefined // abortSignal
                    );
                    
                    // Send tool call request
                    writeSSE(res, JSON.stringify({
                      id: 'chatcmpl-' + Date.now(),
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: 'qwen-code',
                      choices: [{
                        index: 0,
                        delta: { 
                          tool_calls: [{
                            id: toolCallRequest.callId,
                            type: "function",
                            function: {
                              name: toolCallRequest.name,
                              arguments: JSON.stringify(toolCallRequest.args)
                            }
                          }]
                        },
                        finish_reason: null
                      }]
                    }));
                    
                    // Send tool call response
                    writeSSE(res, JSON.stringify({
                      id: 'chatcmpl-' + Date.now(),
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: 'qwen-code',
                      choices: [{
                        index: 0,
                        delta: { 
                          content: `[Tool Response: ${toolResponse.resultDisplay || 'Tool executed successfully'}]`
                        },
                        finish_reason: null
                      }]
                    }));
                    break;
                    
                  case 'error':
                    writeSSE(res, JSON.stringify({
                      id: 'chatcmpl-' + Date.now(),
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: 'qwen-code',
                      choices: [{
                        index: 0,
                        delta: { content: `[Error: ${event.value.error.message}]` },
                        finish_reason: null
                      }]
                    }));
                    break;
                }
              }
              
              // Send final message with finish_reason
              writeSSE(res, JSON.stringify({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'qwen-code',
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }]
              }));
              
              res.end();
            } else {
              // Non-streaming response
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json');
              
              // Collect the full response
              let fullResponse = '';
              let toolCalls: any[] = [];
              const responseStream = await geminiClient.sendMessageStream(
                [{ text: prompt }],
                undefined, // abortSignal
                'sse-request' // prompt_id
              );
              
              for await (const event of responseStream) {
                switch (event.type) {
                  case 'content':
                    fullResponse += event.value;
                    break;
                    
                  case 'tool_call_request':
                    // Execute the tool call
                    const toolCallRequest = event.value;
                    const toolResponse = await executeToolCall(
                      config,
                      toolCallRequest,
                      toolRegistry,
                      undefined // abortSignal
                    );
                    
                    toolCalls.push({
                      id: toolCallRequest.callId,
                      type: "function",
                      function: {
                        name: toolCallRequest.name,
                        arguments: JSON.stringify(toolCallRequest.args)
                      }
                    });
                    
                    // Add tool response to the full response
                    fullResponse += `[Tool Response: ${toolResponse.resultDisplay || 'Tool executed successfully'}]`;
                    break;
                    
                  case 'error':
                    fullResponse += `[Error: ${event.value.error.message}]`;
                    break;
                }
              }
              
              // Send the complete response
              const response = {
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'qwen-code',
                choices: [{
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: fullResponse,
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                  },
                  finish_reason: 'stop'
                }]
              };
              
              res.end(JSON.stringify(response));
            }
          } catch (error) {
            if (stream) {
              writeError(res, error);
            } else {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
            }
          }
        } catch (parseError) {
          writeError(res, parseError);
        }
      });
    } catch (error) {
      writeError(res, error);
    }
    return;
  }
  
  // Handle 404 for other routes
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// Start server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Qwen Code SSE HTTP Server running on port ${PORT}`);
  console.log(`Test with: curl -N http://localhost:${PORT}/v1/chat/completions -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}]}'`);
});