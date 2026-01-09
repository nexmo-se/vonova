import express from "express";
import bodyParser from "body-parser";
import { fromEnv } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient } from "./client";
import { Buffer } from "node:buffer";
import WebSocket, { RawData } from "ws";
import http, { IncomingMessage } from "http";
import { parse, UrlWithParsedQuery } from "url";
import { MCPClient } from "mcp-client";
import axios from "axios";
import fs from "fs";

import {
  Session,
  ActiveSession,
  SessionEventData,
} from "./types";
import {
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  dTools,
} from "./consts";

import dotenv from "dotenv";
dotenv.config();

require("events").EventEmitter.defaultMaxListeners = 0;
const os = require('os');
const podName = os.hostname();

console.log(`Pod Name (Identifier): ${podName}`);
// Local session state type
interface SessionState {
  needsHangup: boolean;
  needsFlush: boolean;
  block: boolean;
  ws: WebSocket;
  tools: any[];
  deads?: number;
  deadtimer?: NodeJS.Timeout | null;
  // any other runtime fields used in file
  [key: string]: any;
}

const server_url = process.env.VCR_INSTANCE_PUBLIC_URL ?? "";
const server_wss = server_url ? server_url.replace("https:", "wss:") : "";
console.log("URLs: ", server_url, server_wss);

const app = express();
const port: number = parseInt(process.env.VCR_PORT || "8010", 10);

let brain = process.env.brain;
let currentPrompt = DefaultSystemPrompt;

app.use(bodyParser.json());
app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "OPTIONS,GET,POST,PUT,DELETE"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With"
  );
  next();
});

const bedrockClient = new NovaSonicBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: fromEnv(),
  },
});

const sessions: Record<string, SessionState> = {};
const finals: Record<string, boolean> = {};

/* Periodically check for and close inactive sessions (every minute). */
setInterval(() => {
  const now = Date.now();
  const sess = bedrockClient.getActiveSessions();
  if (sess?.length) {
    console.log("Active sessions: ", sess.length);
    sess.forEach((sessionId: string) => {
      const lastActivity = bedrockClient.getLastActivityTime(sessionId);
      const fiveMinsInMs = 5 * 60 * 1000;
      if (now - lastActivity > fiveMinsInMs) {
        console.log(`Closing inactive session ${sessionId} due to inactivity.`);
        try {
          bedrockClient.forceCloseSession(sessionId);
        } catch (error: unknown) {
          console.error(`Error force closing inactive session ${sessionId}:`, error);
        }
      }
    });
  }
}, 60000);

// Track active websocket connections with their session IDs
const activeSessions = new Map<WebSocket, ActiveSession>();

app.get("/_/health", async (_req, res) => {
  res.sendStatus(200);
});
app.get("/_/metrics", async (_req, res) => {
  res.sendStatus(200);
});
app.get("/keepalive", (_req, res) => {
  res.sendStatus(200);
});

async function getClient(url: string) {
  console.log("Getting mcp server...");
  const client = new MCPClient({
    name: "Test",
    version: "1.0.0",
  });
  await client.connect({
    type: "httpStream",
    url,
  });
  console.log("Established MCP client connection to: ", url);
  return client;
}

// Create HTTP server and attach ws server to it
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/socket" });

wss.on("connection", async (ws: WebSocket, req: IncomingMessage | undefined) => {
  console.log("Websocket connection is open");

  // Parse query params from the socket request URL
  const parsed: UrlWithParsedQuery = parse(req?.url ?? "", true);
  const q = parsed.query as Record<string, string | undefined>;

  const sessionId = String(q.sessionId ?? "");
  const resultsUrl = String(q.results ?? "");
  const streamId = String(q.streamid ?? "");
  console.log("New client parameters:", q);

  const source_num = String(q.phone ?? "");
  let Uinterval: NodeJS.Timeout | null = null;
  let myPrompt = currentPrompt;
  let stopSending = false;
  const lang = String(q.lang ?? "en");
  let voice = "tiffany";
  const temp = parseFloat(String(q.temp ?? "0.01"));
  const promptId = String(q.promptId ?? "");
  console.log("Using passed in promptId: ", promptId);
  // At this point, you can use promptId to fetch a specific prompt from a database or service 
  if (promptId) {
    // For demonstration, we'll just append the promptId to the default prompt
    myPrompt = `This is a custom prompt for promptId: ${promptId}. ` + currentPrompt;
  }

  const utterances: any[] = [];

  switch (lang.toLowerCase()) {
    case "gb":
      voice = "amy";
      break;
    case "pt":
      voice = "camila";
      break;
    case "hi":
      voice = "aditi";
      break;
    default:
      voice = "tiffany";
      break;
  }

  const tools: any[] = [];
  dTools.forEach((tool) => {
    if (
      tool.toolSpec.name === "getDateAndTimeTool" ||
      tool.toolSpec.name === "getWeatherTool"
    ) {
      tools.push(tool);
      console.log("Pushing tool: ", tool);
    }
  });

  console.log("Pushed tools: ", tools);

  sessions[sessionId] = {
    needsHangup: false,
    needsFlush: false,
    block: true,
    ws,
    tools,
    deads: 0,
    deadtimer: null,
  };

  const sendError = (message: string, details: string) => {
    console.error("sendError, Error:", details);
    try {
      ws.send(JSON.stringify({ event: "error", data: { message, details } }));
    } catch (e) {
      console.error("failed sending error to client", e);
    }
  };

  async function endFlow() {
    if (!resultsUrl) return;
    console.log("Sending hangup and utterances.");
    try {
      await axios.post(resultsUrl, {
        hangup: true,
        sessionId,
        utterances,
      });
    } catch (e) {
      console.log("Error sending to resultsUrl ", resultsUrl, (e as any)?.status);
    }
  }

  async function sendResults(results: any, sid: string) {
    results.sessionId = sid;
    results.time = Date.now();

    console.log("Sending hangup final disposition. ", results);
    try {
      await axios.post(resultsUrl, results);
    } catch (e) {
      console.log("Error sendResults to resultsUrl ", resultsUrl, (e as any)?.status);
    }
    sessions[sid].needsHangup = true;
  }

  function setUpEventHandlers(session: Session, ws: WebSocket, sid: string): void {
    function handleSessionEvent(
      sessionInst: Session,
      wsInst: WebSocket,
      eventName: string,
      isError: boolean = false
    ) {
      sessionInst.onEvent(eventName, (data: SessionEventData) => {
        console[isError ? "error" : "debug"](`Server received event: ${eventName}`, data);
        try {
          wsInst.send(JSON.stringify({ event: { [eventName]: { ...data } } }));
        } catch (err) {
          console.log("Caught error trying to write to WS: ", err);
        }

        if (eventName === "toolResult") {
          if (data.result?.latitude) {
            sessions[sid].location = {
              longitude: String(data.result?.longitude),
              latitude: String(data.result?.latitude),
            };
          }
          if (data.result?.response?.outcome) {
            sessions[sid].needsHangup = true;
            sendResults(data.result.response, sid);
          }
        }

        if (eventName === "textOutput") {
          if (data.role === "USER") {
            sessions[sid].deads = 0;
            if (sessions[sid].deadtimer) {
              clearInterval(sessions[sid].deadtimer as NodeJS.Timeout);
              sessions[sid].deadtimer = null;
            }
          }

          if (data.role === "ASSISTANT") {
            if (sessions[sid].deadtimer) {
              clearInterval(sessions[sid].deadtimer as NodeJS.Timeout);
              sessions[sid].deadtimer = null;
            }
            sessions[sid].deadtimer = setInterval(async () => {
              sessions[sid].deads = (sessions[sid].deads ?? 0) + 1;
              console.log("Deadman timer hit...", sessions[sid].deads);
              if ((sessions[sid].deads ?? 0) > 2) {
                try {
                  if (resultsUrl) {
                    await endFlow();
                  }
                  sessions[sid]?.ws?.close();
                } catch (e) {
                  console.log("Unable to hang up deadman call ", sid);
                }
                clearInterval(sessions[sid].deadtimer as NodeJS.Timeout);
                sessions[sid].deadtimer = null;
              }
            }, 20000);
          }

          if (
            typeof data.content === "string" &&
            (data.content.toLowerCase().includes("goodbye") ||
              data.content.toLowerCase().includes("have a great day") ||
              data.content.toLowerCase().includes("let me transfer you") ||
              data.content.toLowerCase().includes("let me connect you with"))
          ) {
            sessions[sid].needsHangup = true;
            console.log("Got a goodbye... shut it down! ");
          }

          try {
            if (finals[data.contentId] || data.role === "USER") {
              console.log("Pushing data upstream...", data);
              data.streamId = streamId;
              data.phone_to = source_num;
              data.NSsessionId = data.sessionId;
              data.sessionId = sid;
              if (resultsUrl) {
                data.time = Date.now();
                axios.post(resultsUrl, data).catch(() => {});
                utterances.push(data);
              }
              delete finals[data.contentId];
            }
          } catch (e) {
            console.log("Error with pusher");
          }

          if (typeof data.content === "string" && data.content.startsWith('{ "interrupted"') && !sessions[sid].block) {
            console.log("Detecting textOutput barge in...");
            wsInst.send(JSON.stringify({ action: "clear" }));
            sessions[sid].needsFlush = true;
          }
        }

        if (sessions[sid].needsHangup && eventName === "contentEnd" && data.type === "AUDIO" && data.stopReason === "END_TURN") {
          console.log("Ok. shut this down NOW!");
          setTimeout(() => {
            if (!sessions[sid]) {
              return;
            }
            try {
              if (resultsUrl) {
                endFlow();
              }
              sessions[sid]?.ws?.close();
            } catch (e) {
              console.log("Unable to hang up call ", sid);
            }
          }, 10000);
        }

        if (eventName === "contentStart" && data.role === "ASSISTANT" && data.type === "TEXT" && Array.isArray(data.additionalModelFields) && data.additionalModelFields.includes("FINAL")) {
          finals[data.contentId] = true;
        }

        if (!sessions[sid].block && eventName === "contentStart" && data.role === "USER" && data.type === "TEXT") {
          console.log("Detecting barge in...");
          wsInst.send(JSON.stringify({ action: "clear" }));
          sessions[sid].needsFlush = true;
        }
      });
    }

    handleSessionEvent(session, ws, "contentStart");
    handleSessionEvent(session, ws, "textOutput");
    handleSessionEvent(session, ws, "error", true);
    handleSessionEvent(session, ws, "toolUse");
    handleSessionEvent(session, ws, "toolResult");
    handleSessionEvent(session, ws, "contentEnd");

    session.onEvent("streamComplete", () => {
      console.log("Stream completed for client:", sessionId);
      ws.send(JSON.stringify({ event: "streamComplete" }));
    });

    const CHUNK_SIZE_BYTES = 640;
    const SAMPLES_PER_CHUNK = CHUNK_SIZE_BYTES / 2;

    let audioBuffer: Int16Array | null = null;
    let sndcnt = 0;
    const interval = setInterval(() => {
      if (sessions[sessionId].needsFlush) {
        sessions[sessionId].needsFlush = false;
        console.log("Flushing input buffer for barge-in!!!!");
        ws.send(JSON.stringify({ action: "clear" }));
        audioBuffer = new Int16Array(0);
      } else if (audioBuffer && audioBuffer.length) {
        const chunk = audioBuffer.slice(0, SAMPLES_PER_CHUNK);
        try {
          ws.send(chunk);
        } catch (e) {
          console.error("Error sending audio chunk to client", e);
        }
        audioBuffer = audioBuffer.slice(SAMPLES_PER_CHUNK);
        if (!(sndcnt++ % 50)) {
          // console.log("Sent up the socket: ", sndcnt);
        }
      }
    }, 18);
    setTimeout(() => {
      console.log("Freeing up barge-in block");
      sessions[sessionId].block = false;
    }, 5000);

    session.onEvent("audioOutput", (data: SessionEventData) => {
      const buffer = Buffer.from(data["content"], "base64");
      const newPcmSamples = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / Int16Array.BYTES_PER_ELEMENT
      );

      if (audioBuffer && audioBuffer.length && (buffer.length / Int16Array.BYTES_PER_ELEMENT > 640)) {
        //console.log(  "New audio sample: ", buffer.length / Int16Array.BYTES_PER_ELEMENT, audioBuffer.length  );
      }
      let combinedSamples: Int16Array;
      if (audioBuffer) {
        combinedSamples = new Int16Array(audioBuffer.length + newPcmSamples.length);
        combinedSamples.set(audioBuffer);
        combinedSamples.set(newPcmSamples, audioBuffer.length);
      } else {
        combinedSamples = newPcmSamples;
      }
      audioBuffer = combinedSamples;
    });
  }

  const initializeSession = async () => {
    try {
      const session = bedrockClient.createStreamSession(sessionId, tools, temp);
      bedrockClient
        .initiateSession(sessionId)
        .then((success) => {
          console.log("InitializeSession success? ", success);
          if (!success) {
            stopSending = true;
            if (Uinterval) {
              clearInterval(Uinterval);
              Uinterval = null;
            }
            console.log("Playing busy message");
            setTimeout(() => {
              if (!sessions[sessionId]) {
                return;
              }
              try {
                if (resultsUrl) {
                  endFlow();
                }
                sessions[sessionId]?.ws?.close();
              } catch (e) {
                console.log("Unable to hang up call on initiateSession", sessionId);
              }
            }, 23000);
          }
          return;
        })
        .catch((error) => {
          console.error("Error initializing the session and waiting: ", error);
          return;
        });

      activeSessions.set(ws, { sessionId, session });
      setUpEventHandlers(session, ws, sessionId);

      const currentAudio = { ...DefaultAudioOutputConfiguration };
      (currentAudio as any).voiceId = voice;
      await session.setupPromptStart(currentAudio);
      await session.setupSystemPrompt(undefined, myPrompt);
      await session.setupStartAudio();

      console.log(`Session ${sessionId} fully initialized and ready for audio`);
      ws.send(JSON.stringify({ event: "sessionReady", message: "Session initialized and ready for audio" }));

      if (!Uinterval) {
        Uinterval = setInterval(async () => {
          if (bedrockClient.isSessionReady(sessionId)) {
            if (Uinterval) {
              clearInterval(Uinterval);
              Uinterval = null;
            }
            let file = "hellot.pcm";
            if (lang === "es") file = "hablame.wav";
            if (lang === "fr") file = "parlemoi.pcm";
            if (lang === "de") file = "deutsch.pcm";
            if (lang === "it") file = "italiano.pcm";
            console.log("Using file: ", file);
            fs.readFile("public/" + file, async (err: NodeJS.ErrnoException | null, buffer: Buffer) => {
              if (err) {
                console.error("Error reading audio file:", err);
                return;
              }
              console.log("Audio file loaded into Buffer, sending :", buffer.length);
              await session.streamAudio(buffer);
            });
          }
        }, 500);
      }
    } catch (error) {
      console.log("Failed to initialize session", error);
      sendError("Failed to initialize session", String(error));
      try { ws.close(); } catch (e) {}
    }
  };

  const handleMessage = async (msg: RawData) => {
    const sessionData = activeSessions.get(ws);
    if (!sessionData) {
      sendError("Session not found", "No active session for this connection");
      return;
    }
    const { session } = sessionData;
    try {
      let audioBuf: Buffer | undefined;
      try {
        // attempt to parse JSON events
        if (typeof msg === "string") {
          const json = JSON.parse(msg);
          if (json.event?.audioInput) {
            throw new Error("Received audioInput during initialization");
          }
          console.log("Event received of type:", json);
          switch (json.type) {
            case "promptStart":
              await session.setupPromptStart();
              break;
            case "systemPrompt":
              console.log("Setting up system prompt from JSON: ", json.data);
              await session.setupSystemPrompt(undefined, json.data);
              break;
            case "audioStart":
              await session.setupStartAudio();
              break;
            case "stopAudio":
              await session.endAudioContent();
              await session.endPrompt();
              console.log("Session cleanup complete");
              break;
            case "barge":
              console.log("Clearing ws buffer on barge in");
              ws.send(JSON.stringify({ action: "clear" }));
              break;
            default:
              break;
          }
        } else {
          // binary audio data expected
          audioBuf = Buffer.from(msg as Buffer);
        }
      } catch (e) {
        // treat incoming message as audio if JSON parse fails or earlier threw
        audioBuf = Buffer.from(msg as Buffer);
      }

      if (audioBuf && !stopSending) {
        await session.streamAudio(audioBuf);
      }
    } catch (error) {
      sendError("Error processing message", String(error));
    }
  };

  // register message and close handlers
  ws.on("message", handleMessage as any);
  ws.on("close", async () => {
    console.log("Client disconnected:", sessionId);
    if (Uinterval) {
      clearInterval(Uinterval);
      Uinterval = null;
    }
    if (!sessions[sessionId]) return;
    if (sessions[sessionId]?.deadtimer) {
      clearInterval(sessions[sessionId].deadtimer as NodeJS.Timeout);
    }
    if (resultsUrl) {
      await endFlow();
    }
    const sessionData = activeSessions.get(ws);
    if (!sessionData) {
      console.log(`No session to clean up for: ${sessionId}`);
      activeSessions.delete(ws);
      return;
    }
    const { session } = sessionData;
    if (!bedrockClient.isSessionActive(sessionId)) {
      activeSessions.delete(ws);
      return;
    }
    try {
      await Promise.race([
        (async () => {
          await session.endAudioContent();
          await session.endPrompt();
          await session.close();
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Session cleanup timeout")), 3000)
        ),
      ]);
      console.log(`Successfully cleaned up session: ${sessionId}`);
      if (sessions[sessionId]?.ws) {
        console.log("Terminating!");
        sessions[sessionId]?.ws?.terminate();
      }
    } catch (error) {
      console.error(`Error cleaning up session ${sessionId}:`, error);
      try {
        bedrockClient.forceCloseSession(sessionId);
        console.log(`Force closed session: ${sessionId}`);
      } catch (e) {
        console.error(`Failed to force close session ${sessionId}:`, e);
      }
    } finally {
      activeSessions.delete(ws);
    }
  });

  // start session after handlers are registered
  initializeSession();
}); // end wss.on connection

/* SERVER LOGIC */
setInterval(() => {
  wss.clients.forEach(function each(client: any) {
    if (client.readyState === client.CLOSING) {
    console.log("GOT OPEN SOCKET in CLOSING state!!! ", client.readyState);
      client.terminate();
    }
  });
}, 1000);

const server = httpServer.listen(port, () =>
  console.log(`Original Vonic server listening on port ${port}`)
);

// Gracefully shut down.
process.on("SIGINT", async () => {
  console.log("Shutting down servers...");

  const forceExitTimer = setTimeout(() => {
    console.error("Forcing server shutdown after timeout");
    process.exit(1);
  }, 5000);

  try {
    const sessionPromises: Promise<void>[] = [];
    activeSessions.forEach(({ sessionId }, ws) => {
      console.log(`Closing session ${sessionId} during shutdown`);
      sessionPromises.push(
        bedrockClient.closeSession(sessionId).catch((error: unknown) => {
          console.error(`Error closing session ${sessionId} during shutdown:`, error);
          bedrockClient.forceCloseSession(sessionId);
        })
      );
      try { ws.close(); } catch (e) {}
    });

    await Promise.all(sessionPromises);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    clearTimeout(forceExitTimer);
    console.log("Servers shut down");
    process.exit(0);
  } catch (error: unknown) {
    console.error("Error during server shutdown:", error);
    process.exit(1);
  }
});