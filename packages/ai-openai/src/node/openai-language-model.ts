// *****************************************************************************
// Copyright (C) 2024 EclipseSource GmbH.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import {
    LanguageModel,
    LanguageModelParsedResponse,
    LanguageModelRequest,
    LanguageModelRequestMessage,
    LanguageModelResponse,
    LanguageModelTextResponse
} from '@theia/ai-core';
import { CancellationToken } from '@theia/core';
import { OpenAI, AzureOpenAI } from 'openai';
import { ChatCompletionStream } from 'openai/lib/ChatCompletionStream';
import { RunnableToolFunctionWithoutParse } from 'openai/lib/RunnableFunction';
import { ChatCompletionMessageParam } from 'openai/resources';
import { StreamingAsyncIterator } from './openai-streaming-iterator';

export const OpenAiModelIdentifier = Symbol('OpenAiModelIdentifier');

export class OpenAiModel implements LanguageModel {

    /**
     * @param id the unique id for this language model. It will be used to identify the model in the UI.
     * @param model the model id as it is used by the OpenAI API
     * @param enableStreaming whether the streaming API shall be used
     * @param apiKey a function that returns the API key to use for this model, called on each request
     * @param apiVersion a function that returns the OpenAPI version to use for this model, called on each request
     * @param supportsDeveloperMessage whether the model supports the `developer` role
     * @param url the OpenAI API compatible endpoint where the model is hosted. If not provided the default OpenAI endpoint will be used.
     * @param defaultRequestSettings optional default settings for requests made using this model.
     */
    constructor(
        public readonly id: string,
        public model: string,
        public enableStreaming: boolean,
        public apiKey: () => string | undefined,
        public apiVersion: () => string | undefined,
        public supportsDeveloperMessage: boolean,
        public supportsStructuredOutput: boolean,
        public url: string | undefined,
        public defaultRequestSettings?: { [key: string]: unknown }
    ) { }

    protected getSettings(request: LanguageModelRequest): Record<string, unknown> {
        const settings = request.settings ? request.settings : this.defaultRequestSettings;
        if (!settings) {
            return {};
        }
        return settings;
    }

    async request(request: LanguageModelRequest, cancellationToken?: CancellationToken): Promise<LanguageModelResponse> {
        const settings = this.getSettings(request);
        const openai = this.initializeOpenAi();

        if (request.response_format?.type === 'json_schema' && this.supportsStructuredOutput) {
            return this.handleStructuredOutputRequest(openai, request);
        }

        if (this.isNonStreamingModel(this.model) || (typeof settings.stream === 'boolean' && !settings.stream)) {
            return this.handleNonStreamingRequest(openai, request);
        }

        if (cancellationToken?.isCancellationRequested) {
            return { text: '' };
        }

        let runner: ChatCompletionStream;
        const tools = this.createTools(request);
        if (tools) {
            runner = openai.beta.chat.completions.runTools({
                model: this.model,
                messages: request.messages.map(this.toOpenAIMessage.bind(this)),
                stream: true,
                tools: tools,
                tool_choice: 'auto',
                ...settings
            });
        } else {
            runner = openai.beta.chat.completions.stream({
                model: this.model,
                messages: request.messages.map(this.toOpenAIMessage.bind(this)),
                stream: true,
                ...settings
            });
        }

        return { stream: new StreamingAsyncIterator(runner, cancellationToken) };
    }

    protected async handleNonStreamingRequest(openai: OpenAI, request: LanguageModelRequest): Promise<LanguageModelTextResponse> {
        const settings = this.getSettings(request);
        const response = await openai.chat.completions.create({
            model: this.model,
            messages: request.messages.map(this.toOpenAIMessage.bind(this)),
            ...settings
        });

        const message = response.choices[0].message;

        return {
            text: message.content ?? ''
        };
    }

    protected toOpenAIMessage(message: LanguageModelRequestMessage): ChatCompletionMessageParam {
        return {
            role: this.toOpenAiRole(message),
            content: message.query || ''
        };
    }

    protected toOpenAiRole(message: LanguageModelRequestMessage): 'developer' | 'user' | 'assistant' {
        switch (message.actor) {
            case 'system':
                return this.supportsDeveloperMessage ? 'developer' : 'user';
            case 'ai':
                return 'assistant';
            default:
                return 'user';
        }
    }

    protected isNonStreamingModel(_model: string): boolean {
        return !this.enableStreaming;
    }

    protected async handleStructuredOutputRequest(openai: OpenAI, request: LanguageModelRequest): Promise<LanguageModelParsedResponse> {
        const settings = this.getSettings(request);
        // TODO implement tool support for structured output (parse() seems to require different tool format)
        const result = await openai.beta.chat.completions.parse({
            model: this.model,
            messages: request.messages.map(this.toOpenAIMessage.bind(this)),
            response_format: request.response_format,
            ...settings
        });
        const message = result.choices[0].message;
        if (message.refusal || message.parsed === undefined) {
            console.error('Error in OpenAI chat completion stream:', JSON.stringify(message));
        }
        return {
            content: message.content ?? '',
            parsed: message.parsed
        };
    }

    protected createTools(request: LanguageModelRequest): RunnableToolFunctionWithoutParse[] | undefined {
        return request.tools?.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                function: (args_string: string) => tool.handler(args_string)
            }
        } as RunnableToolFunctionWithoutParse));
    }

    protected initializeOpenAi(): OpenAI {
        const apiKey = this.apiKey();
        if (!apiKey && !(this.url)) {
            throw new Error('Please provide OPENAI_API_KEY in preferences or via environment variable');
        }

        const apiVersion = this.apiVersion();
        if (apiVersion) {
            // We need to hand over "some" key, even if a custom url is not key protected as otherwise the OpenAI client will throw an error
            return new AzureOpenAI({ apiKey: apiKey ?? 'no-key', baseURL: this.url, apiVersion: apiVersion });
        } else {
            // We need to hand over "some" key, even if a custom url is not key protected as otherwise the OpenAI client will throw an error
            return new OpenAI({ apiKey: apiKey ?? 'no-key', baseURL: this.url });
        }
    }
}
