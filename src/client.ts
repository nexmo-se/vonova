import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import axios from "axios";
import https from "https";
import {
  NodeHttp2Handler,
  NodeHttp2HandlerOptions,
} from "@smithy/node-http-handler";
import { Provider } from "@smithy/types";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { InferenceConfig } from "./types";
import { Subject } from "rxjs";
import { take } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  DefaultTextConfiguration,
  dTools,
} from "./consts";
import { BedrockKnowledgeBaseClient, RetrieveOptions, RetrievalResult } from "./bedrock-kb-client";
/**
 * Public config for the NovaSonic client.
 */
export interface NovaSonicBidirectionalStreamClientConfig {
  requestHandlerConfig?: NodeHttp2HandlerOptions | Provider<NodeHttp2HandlerOptions | void>;
  clientConfig: Partial<BedrockRuntimeClientConfig>;
  inferenceConfig?: InferenceConfig;
}

/**
 * StreamSession: per-session convenience wrapper.
 */
export class StreamSession {
  private audioBufferQueue: Buffer[] = [];
  private maxQueueSize = 200; // Maximum number of audio chunks to queue
  private isProcessingAudio = false;
  private isActive = true;

  constructor(
    private sessionId: string,
    private client: NovaSonicBidirectionalStreamClient
  ) {}

  public onEvent(eventType: string, handler: (data: unknown) => void): StreamSession {
    this.client.registerEventHandler(this.sessionId, eventType, handler as any);
    return this;
  }

  public async setupPromptStart(
    audioConfig: typeof DefaultAudioOutputConfiguration = DefaultAudioOutputConfiguration
  ): Promise<void> {
    this.client.setupPromptStartEvent(this.sessionId, audioConfig);
  }

  public async setupSystemPrompt(
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): Promise<void> {
    this.client.setupSystemPromptEvent(this.sessionId, textConfig, systemPromptContent);
  }

  public async setupStartAudio(
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    this.client.setupStartAudioEvent(this.sessionId, audioConfig);
  }

  public async streamAudio(audioData: Buffer): Promise<void> {
    if (!this.isActive || !this.client.isSessionReady(this.sessionId)) {
      console.log("Inactive stream, dropping audio");
      return;
    }
    if (this.audioBufferQueue.length >= this.maxQueueSize) {
      this.audioBufferQueue.shift();
      console.log("Audio queue full, dropping oldest chunk: ", this.audioBufferQueue.length, this.maxQueueSize);
    }
    this.audioBufferQueue.push(audioData);
    this.processAudioQueue().catch((err) => {
      console.error("Error processing audio queue:", err);
    });
  }

  private async processAudioQueue(): Promise<void> {
    if (this.isProcessingAudio || this.audioBufferQueue.length === 0 || !this.isActive) return;

    this.isProcessingAudio = true;
    try {
      let processedChunks = 0;
      const maxChunksPerBatch = 5;
      while (this.audioBufferQueue.length > 0 && processedChunks < maxChunksPerBatch && this.isActive) {
        const audioChunk = this.audioBufferQueue.shift();
        if (audioChunk && this.isActive) {
          await this.client.streamAudioChunk(this.sessionId, audioChunk);
          processedChunks++;
        }
      }
    } finally {
      this.isProcessingAudio = false;
      if (this.audioBufferQueue.length > 0 && this.isActive) {
        setTimeout(() => this.processAudioQueue().catch(console.error), 0);
      }
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async endAudioContent(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    if (!this.isActive) return;
    this.isActive = false;
    this.audioBufferQueue = [];
    await this.client.sendSessionEnd(this.sessionId);
    console.log(`Session ${this.sessionId} close completed`);
  }
}

/**
 * Session data shape used by NovaSonicBidirectionalStreamClient.
 */
interface SessionData {
  queue: Array<any>;
  queueSignal: Subject<void>;
  closeSignal: Subject<void>;
  responseSubject: Subject<any>;
  toolUseContent: any | null;
  toolUseId: string;
  toolName: string;
  responseHandlers: Map<string, (data: any) => void>;
  promptName: string;
  inferenceConfig: InferenceConfig;
  isActive: boolean;
  isPromptStartSent: boolean;
  isAudioContentStartSent: boolean;
  audioContentId: string;
  needsHangup: boolean;
  tools: Array<any> | undefined;
  isReady: boolean;
}

/**
 * NovaSonicBidirectionalStreamClient - core class
 */
export class NovaSonicBidirectionalStreamClient {
  private bedrockRuntimeClient: BedrockRuntimeClient;
  private inferenceConfig: InferenceConfig;
  private activeSessions: Map<string, SessionData> = new Map();
  private sessionLastActivity: Map<string, number> = new Map();
  private sessionCleanupInProgress = new Set<string>();

  constructor(config: NovaSonicBidirectionalStreamClientConfig) {
    const nodeHttp2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
      ...config.requestHandlerConfig,
    });

    if (!config.clientConfig.credentials) {
      throw new Error("No credentials provided");
    }

    this.bedrockRuntimeClient = new BedrockRuntimeClient({
      ...config.clientConfig,
      credentials: config.clientConfig.credentials,
      region: config.clientConfig.region || "us-east-1",
      requestHandler: nodeHttp2Handler,
    });

    this.inferenceConfig = config.inferenceConfig ?? {
      maxTokens: 3000,
      topK: 5,
      temperature: 0.01,
    };
  }

  public isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }

  public isSessionReady(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isReady;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  public getLastActivityTime(sessionId: string): number {
    return this.sessionLastActivity.get(sessionId) ?? 0;
  }

  private updateSessionActivity(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  public isCleanupInProgress(sessionId: string): boolean {
    return this.sessionCleanupInProgress.has(sessionId);
  }

  public createStreamSession(
    sessionId: string = randomUUID(),
    tools?: Array<any>,
    temp?: number,
    config?: NovaSonicBidirectionalStreamClientConfig
  ): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Stream session with ID ${sessionId} already exists`);
    }
    if (temp !== undefined && !Number.isNaN(temp)) {
      this.inferenceConfig.temperature = temp;
    }
    console.log("Using inferenceConfig: ", this.inferenceConfig);
    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      responseSubject: new Subject<any>(),
      toolUseContent: null,
      toolUseId: "",
      toolName: "",
      responseHandlers: new Map(),
      promptName: randomUUID(),
      inferenceConfig: config?.inferenceConfig ?? this.inferenceConfig,
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: randomUUID(),
      needsHangup: false,
      tools,
      isReady: false,
    };

    this.activeSessions.set(sessionId, session);
    return new StreamSession(sessionId, this);
  }

  private async processToolUse(
    toolName: string,
    toolUseContent: any,
    tools: Array<any> = []
  ): Promise<Record<string, any>> {
    const tool = String(toolName).toLowerCase();

    switch (tool) {
      case "getdateandtimetool": {
        const date = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
        const pstDate = new Date(date);
        return {
          date: pstDate.toISOString().split("T")[0],
          year: pstDate.getFullYear(),
          month: pstDate.getMonth() + 1,
          day: pstDate.getDate(),
          dayOfWeek: pstDate.toLocaleString("en-US", { weekday: "long" }).toUpperCase(),
          timezone: "PST",
          formattedTime: pstDate.toLocaleTimeString("en-US", { hour12: true, hour: "2-digit", minute: "2-digit" }),
        };
      }
      case "getnyc": {
        const kbContent = await this.parseToolUseContent(toolUseContent);
        if (!kbContent) throw new Error("NYC parsedContent is undefined");
        return this.queryKB(kbContent.query, kbContent.maxResults ?? 3, "OWELQLIRZB");
      }
      case "getalphatech": {
        const alContent = await this.parseToolUseContent(toolUseContent);
        if (!alContent) throw new Error("AlphaTech parsedContent is undefined");
        return this.queryKB(alContent.query, alContent.maxResults ?? 3, "FHTBJIUFCV");
      }
      case "getbrandedcalling": {
        return {
          latitude: 28.429512,
          longitude: -81.462511,
        };
      }
      case "getweathertool": {
        const parsedContent = await this.parseToolUseContentForWeather(toolUseContent);
        if (!parsedContent) throw new Error("parsedContent is undefined");
        return this.fetchWeatherData(parsedContent.latitude, parsedContent.longitude);
      }
      default: {
        console.log(`Tool ${tool} not natively supported, check for dynamic `, toolUseContent);
        console.log("My Tools: ", tools);
        const cur = (tools || []).find((atool: any) => atool?.toolSpec?.name?.toLowerCase() === tool);
        if (cur && cur.toolSpec?.url && cur.toolSpec.url.length > 4) {
          const results = await this.getURL(cur.toolSpec.url, toolUseContent);
          return results;
        } else if (cur && typeof cur.toolSpec?.key === "string" && cur.toolSpec.key.toLowerCase().startsWith("kb:")) {
          const kbid = cur.toolSpec.key.substring(3).trim();
          const kbContent = await this.parseToolUseContent(toolUseContent);
          if (!kbContent) throw new Error("Dynamic KB parsedContent is undefined");
          return this.queryKB(kbContent.query, kbContent.maxResults ?? 3, kbid);
        }
        throw new Error(`Tool ${tool} not supported`);
      }
    }
  }

  private async parseToolUseContent(toolUseContent: any): Promise<{ query: string; maxResults?: number } | null> {
    try {
      if (toolUseContent && typeof toolUseContent.content === "string") {
        const parsedContent = JSON.parse(toolUseContent.content);
        return { query: parsedContent.query, maxResults: parsedContent?.maxResults };
      }
      return null;
    } catch (error) {
      console.error("Failed to parse tool use content:", error);
      return null;
    }
  }

private async queryKB(query: string, numberOfResults = 3, kbId: string): Promise<{ results?: RetrievalResult[] }> {
    const kbClient = new BedrockKnowledgeBaseClient();
    const KNOWLEDGE_BASE_ID = kbId;
    try {
      console.log(`Searching for: "${query}"`);
      const rawResults = await kbClient.retrieveFromKnowledgeBase({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        query,
        numberOfResults,
    });
      console.log(`Results: ${JSON.stringify(rawResults)}`);
      // Ensure we return the expected typed shape even if the KB client returned a loose Object
      const results: RetrievalResult[] = Array.isArray(rawResults) ? (rawResults as RetrievalResult[]) : [];
      return { results };
    } catch (error) {
      console.error("Query Error:", error);
      return {};
    }
  }

  private async parseToolUseContentForWeather(toolUseContent: any): Promise<{ latitude: number; longitude: number } | null> {
    try {
      if (toolUseContent && typeof toolUseContent.content === "string") {
        const parsedContent = JSON.parse(toolUseContent.content);
        return { latitude: parsedContent.latitude, longitude: parsedContent.longitude };
      }
      return null;
    } catch (error) {
      console.error("Failed to parse tool use content:", error);
      return null;
    }
  }

  private async getURL(url: string, toolUseContent: any): Promise<Record<string, any>> {
    try {
      const parsedContent = JSON.parse(toolUseContent.content);
      console.log("Getting remote data, url= ", url, parsedContent);
      const response = await axios.post(url, parsedContent);
      return { response: response.data };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`Error fetching remote data: ${error.message}`, error);
      } else {
        console.error(`Unexpected remote data error: ${error instanceof Error ? error.message : String(error)}`, error);
      }
      throw error;
    }
  }

  private async fetchWeatherData(latitude: number, longitude: number): Promise<Record<string, any>> {
    const ipv4Agent = new https.Agent({ family: 4 });
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
    try {
      const response = await axios.get(url, {
        httpsAgent: ipv4Agent,
        timeout: 5000,
        headers: { "User-Agent": "MyApp/1.0", Accept: "application/json" },
      });
      return { weather_data: response.data };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`Error fetching weather data: ${error.message}`, error);
      } else {
        console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, error);
      }
      throw error;
    }
  }

  public async initiateSession(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Stream session ${sessionId} not found`);
    try {
      this.setupSessionStartEvent(sessionId);
      const asyncIterable = this.createSessionAsyncIterable(sessionId);
      console.log(`Starting bidirectional stream for session ${sessionId}...`);

      let response: any;
      try {
        response = await this.bedrockRuntimeClient.send(
          new InvokeModelWithBidirectionalStreamCommand({
            modelId: "amazon.nova-2-sonic-v1:0",
            body: asyncIterable,
          })
        );
      } catch (err) {
        console.log("InvokeModelWithBidirectionalStreamCommand error! ", err);
        if (session.isActive) {
          session.isActive = false;
          this.activeSessions.delete(sessionId);
          this.sessionLastActivity.delete(sessionId);
        }
        return false;
      }

      console.log(`Stream established for session ${sessionId}, processing responses...`);
      await this.processResponseStream(sessionId, response);
      return true;
    } catch (error) {
      console.error(`Error in initiateSession ${sessionId}: `, session?.isActive, error);
      this.dispatchEventForSession(sessionId, "error", { source: "bidirectionalStream", error });
      if (session?.isActive) {
        await this.closeSession(sessionId);
      }
      return false;
    }
  }

  private dispatchEventForSession(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try { handler(data); } catch (e) { console.error(`Error in ${eventType} handler for session ${sessionId}: `, e); }
    }
    const anyHandler = session.responseHandlers.get("any");
    if (anyHandler) {
      try { anyHandler({ type: eventType, data }); } catch (e) { console.error(`Error in 'any' handler for session ${sessionId}: `, e); }
    }
  }

  private createSessionAsyncIterable(sessionId: string): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
    if (!this.isSessionActive(sessionId)) {
      console.log(`Cannot create async iterable: Session ${sessionId} not active`);
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined as any, done: true }) }) };
    }

    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Cannot create async iterable: Session ${sessionId} not found`);

    return {
      [Symbol.asyncIterator]: () => {
        return {
          next: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            try {
              if (!session.isActive || !this.activeSessions.has(sessionId)) return { value: undefined as any, done: true };
              if (session.queue.length === 0) {
                try {
                  await Promise.race([
                    firstValueFrom(session.queueSignal.pipe(take(1))),
                    firstValueFrom(session.closeSignal.pipe(take(1))).then(() => { throw new Error("Stream closed"); }),
                  ]);
                } catch (error: unknown) {
                  if (error instanceof Error && (error.message === "Stream closed" || !session.isActive)) {
                    return { value: undefined as any, done: true };
                  }
                }
              }
              if (session.queue.length === 0 || !session.isActive) return { value: undefined as any, done: true };
              const nextEvent = session.queue.shift();
              return { value: { chunk: { bytes: new TextEncoder().encode(JSON.stringify(nextEvent)) } }, done: false };
            } catch (error) {
              console.error(`Error in session ${sessionId} iterator: `, error);
              session.isActive = false;
              return { value: undefined as any, done: true };
            }
          },

          return: async (): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            session.isActive = false;
            return { value: undefined as any, done: true };
          },

          throw: async (error: any): Promise<IteratorResult<InvokeModelWithBidirectionalStreamInput>> => {
            session.isActive = false;
            throw error;
          },
        };
      },
    };
  }

  private async processResponseStream(sessionId: string, response: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) { console.log("No active session yet...", sessionId); return; }
    try {
      for await (const event of response.body) {
        if (!session.isActive) break;
        if (event.chunk?.bytes) {
          try {
            this.updateSessionActivity(sessionId);
            const textResponse = new TextDecoder().decode(event.chunk.bytes);
            session.isReady = true;
            try {
              const jsonResponse = JSON.parse(textResponse);
              if (jsonResponse.event?.contentStart) this.dispatchEvent(sessionId, "contentStart", jsonResponse.event.contentStart);
              else if (jsonResponse.event?.textOutput) this.dispatchEvent(sessionId, "textOutput", jsonResponse.event.textOutput);
              else if (jsonResponse.event?.audioOutput) this.dispatchEvent(sessionId, "audioOutput", jsonResponse.event.audioOutput);
              else if (jsonResponse.event?.toolUse) {
                this.dispatchEvent(sessionId, "toolUse", jsonResponse.event.toolUse);
                session.toolUseContent = jsonResponse.event.toolUse;
                session.toolUseId = jsonResponse.event.toolUse.toolUseId;
                session.toolName = jsonResponse.event.toolUse.toolName;
              } else if (jsonResponse.event?.contentEnd && jsonResponse.event.contentEnd?.type === "TOOL") {
                this.dispatchEvent(sessionId, "toolEnd", { toolUseContent: session.toolUseContent, toolUseId: session.toolUseId, toolName: session.toolName });
                const toolResult = await this.processToolUse(session.toolName, session.toolUseContent, session.tools ?? []);
                await this.sendToolResult(sessionId, session.toolUseId, toolResult);
                this.dispatchEvent(sessionId, "toolResult", { toolUseId: session.toolUseId, result: toolResult });
              } else if (jsonResponse.event?.contentEnd) {
                this.dispatchEvent(sessionId, "contentEnd", jsonResponse.event.contentEnd);
              }
            } catch (e) {
              console.log(`Raw text response for session ${sessionId}(parse error): `, textResponse);
            }
          } catch (e) {
            console.error(`Error processing response chunk for session ${sessionId}: `, e);
          }
        } else if (event.modelStreamErrorException) {
          console.error(`Model stream error for session ${sessionId}: `, event.modelStreamErrorException);
          this.dispatchEvent(sessionId, "error", { type: "modelStreamErrorException", details: event.modelStreamErrorException });
        } else if (event.internalServerException) {
          console.error(`Internal server error for session ${sessionId}: `, event.internalServerException);
          this.dispatchEvent(sessionId, "error", { type: "internalServerException", details: event.internalServerException });
        }
      }

      console.log(`Response stream processing complete for session ${sessionId}`);
      this.dispatchEvent(sessionId, "streamComplete", { timestamp: new Date().toISOString() });
    } catch (error) {
      console.error(`Error processing response stream for session ${sessionId} `);
      this.dispatchEvent(sessionId, "error", { source: "responseStream", message: "Error processing response stream", details: error instanceof Error ? error.message : String(error) });
    }
  }

  private addEventToSessionQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;
    this.updateSessionActivity(sessionId);
    session.queue.push(event);
    session.queueSignal.next();
  }

  private setupSessionStartEvent(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.addEventToSessionQueue(sessionId, { event: { sessionStart: { inferenceConfiguration: session.inferenceConfig } } });
  }

  public setupPromptStartEvent(sessionId: string, audioConfig: typeof DefaultAudioOutputConfiguration = DefaultAudioOutputConfiguration): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const tools = session.tools;
    this.addEventToSessionQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: { mediaType: "text/plain" },
          audioOutputConfiguration: audioConfig,
          toolUseOutputConfiguration: { mediaType: "application/json" },
          toolConfiguration: { tools },
        },
      },
    });
    session.isPromptStartSent = true;
  }

  public setupSystemPromptEvent(sessionId: string, textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration, systemPromptContent: string = DefaultSystemPrompt): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const textPromptID = randomUUID();
    this.addEventToSessionQueue(sessionId, { event: { contentStart: { promptName: session.promptName, contentName: textPromptID, type: "TEXT", interactive: true, role: "SYSTEM", textInputConfiguration: textConfig } } });
    this.addEventToSessionQueue(sessionId, { event: { textInput: { promptName: session.promptName, contentName: textPromptID, content: systemPromptContent } } });
    this.addEventToSessionQueue(sessionId, { event: { contentEnd: { promptName: session.promptName, contentName: textPromptID } } });
  }

  public setupStartAudioEvent(sessionId: string, audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.addEventToSessionQueue(sessionId, { event: { contentStart: { promptName: session.promptName, contentName: session.audioContentId, type: "AUDIO", interactive: true, role: "USER", audioInputConfiguration: audioConfig } } });
    session.isAudioContentStartSent = true;
  }

  public async streamAudioChunk(sessionId: string, audioData: Buffer): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive || !session.audioContentId) throw new Error(`Invalid session ${sessionId} for audio streaming`);
    const base64Data = audioData.toString("base64");
    this.addEventToSessionQueue(sessionId, { event: { audioInput: { promptName: session.promptName, contentName: session.audioContentId, content: base64Data } } });
  }

  private async sendToolResult(sessionId: string, toolUseId: string, result: any): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;
    const contentId = randomUUID();
    this.addEventToSessionQueue(sessionId, { event: { contentStart: { promptName: session.promptName, contentName: contentId, interactive: false, type: "TOOL", role: "TOOL", toolResultInputConfiguration: { toolUseId, type: "TEXT", textInputConfiguration: { mediaType: "text/plain" } } } } });
    const resultContent = typeof result === "string" ? result : JSON.stringify(result);
    this.addEventToSessionQueue(sessionId, { event: { toolResult: { promptName: session.promptName, contentName: contentId, content: resultContent } } });
    this.addEventToSessionQueue(sessionId, { event: { contentEnd: { promptName: session.promptName, contentName: contentId } } });
  }

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isAudioContentStartSent) return;
    this.addEventToSessionQueue(sessionId, { event: { contentEnd: { promptName: session.promptName, contentName: session.audioContentId } } });
    await new Promise((r) => setTimeout(r, 500));
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isPromptStartSent) return;
    this.addEventToSessionQueue(sessionId, { event: { promptEnd: { promptName: session.promptName } } });
    await new Promise((r) => setTimeout(r, 300));
  }

  public async sendSessionEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.addEventToSessionQueue(sessionId, { event: { sessionEnd: {} } });
    await new Promise((r) => setTimeout(r, 300));
    session.isActive = false;
    session.closeSignal.next();
    session.closeSignal.complete();
    this.activeSessions.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
    console.log(`Session ${sessionId} closed and removed from active sessions`);
  }

  public registerEventHandler(sessionId: string, eventType: string, handler: (data: any) => void): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.responseHandlers.set(eventType, handler);
  }

  private dispatchEvent(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try { handler(data); } catch (e) { console.error(`Error in ${eventType} handler for session ${sessionId}:`, e); }
    }
    const anyHandler = session.responseHandlers.get("any");
    if (anyHandler) {
      try { anyHandler({ type: eventType, data }); } catch (e) { console.error(`Error in 'any' handler for session ${sessionId}:`, e); }
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (this.sessionCleanupInProgress.has(sessionId)) return;
    this.sessionCleanupInProgress.add(sessionId);
    try {
      await this.sendContentEnd(sessionId);
      await this.sendPromptEnd(sessionId);
      await this.sendSessionEnd(sessionId);
    } catch (error) {
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.isActive = false;
        this.activeSessions.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
      }
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

  public forceCloseSession(sessionId: string): void {
    if (this.sessionCleanupInProgress.has(sessionId) || !this.activeSessions.has(sessionId)) return;
    this.sessionCleanupInProgress.add(sessionId);
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) return;
      session.isActive = false;
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }
}