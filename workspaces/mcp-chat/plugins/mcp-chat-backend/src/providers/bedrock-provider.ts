/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { LLMProvider } from './base-provider';
import { ChatMessage, Tool, ChatResponse, ToolCall } from '../types';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { DefaultAwsCredentialsManager } from '@backstage/integration-aws-node';
import { RootConfigService } from '@backstage/backend-plugin-api';

export class BedrockProvider extends LLMProvider {
  private region: string;
  private rootConfig: RootConfigService;
  constructor(config: any) {
    super(config);
    this.region = config.baseUrl || 'us-east-1';
    this.rootConfig = config.options.rootConfig;
  }

  async getClient(): Promise<BedrockRuntimeClient> {
    const awsCredentialsManager = DefaultAwsCredentialsManager.fromConfig(
      this.rootConfig,
    );
    const credProvider = await awsCredentialsManager.getCredentialProvider();
    return new BedrockRuntimeClient({
      region: this.region,
      credentials: credProvider.sdkCredentialProvider,
    });
  }

  async sendMessage(
    messages: ChatMessage[],
    tools?: Tool[],
  ): Promise<ChatResponse> {
    const client = await this.getClient();
    const requestBody = this.formatRequest(messages, tools);
    const command = new InvokeModelCommand({
      modelId: this.model,
      contentType: 'application/json',
      body: JSON.stringify(requestBody),
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return this.parseResponse(responseBody);
  }

  async testConnection(): Promise<{
    connected: boolean;
    models?: string[];
    error?: string;
  }> {
    try {
      await this.sendMessage([{ role: 'user', content: 'Hello' }]);
      return { connected: true, models: [this.model] };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  protected getHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  protected formatRequest(messages: ChatMessage[], tools?: Tool[]): any {
    const request: any = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      messages: messages.map(msg => ({
        role: msg.role === 'system' ? 'user' : msg.role,
        content: msg.content || '',
      })),
    };

    if (tools?.length) {
      request.tools = tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
    }

    return request;
  }

  protected parseResponse(response: any): ChatResponse {
    const content = response.content || [];
    const textContent = content.find((c: any) => c.type === 'text')?.text || '';
    const toolCalls: ToolCall[] = content
      .filter((c: any) => c.type === 'tool_use')
      .map((c: any) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      }));

    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
        },
      ],
      usage: response.usage
        ? {
            prompt_tokens: response.usage.input_tokens || 0,
            completion_tokens: response.usage.output_tokens || 0,
            total_tokens:
              (response.usage.input_tokens || 0) +
              (response.usage.output_tokens || 0),
          }
        : undefined,
    };
  }
}
