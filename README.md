# Vonova

Vonage WebSocket to NovaSonic connections for voice and video applications.

### Prerequisites for Debug and Deployment

- AWS configured with appropriate credentials
- Node.js and npm installed
- [VCR (Vonage Cloud Runtime) CLI](https://developer.vonage.com/en/vcr)

## Setup

1. **Install dependencies:**
   ```
   npm install
   ```
2. **Create a Vonage Application:**

   - Sign up at [Vonage Dashboard](https://dashboard.nexmo.com/)
   - Create a new application
   - Note your Application ID (VCR will automatically provide credentials)

3. **Configure VCR files** using the provided samples as reference:
   - vcr-sample.yml (rename to vcr.yml)

4. **Launch local debug**
   - vcr debug

5. **To deploy to VCR**
   - run the ./deploy script

### How it works

This code provides a connector between Vonage websockets (both Voice/VAPI and Video AudioConnector) and Amazon NovaSonic
The actual code to connect TO this connector would be from a separate application - this allows this connector to be modular and independent of the original Vonage source.

To connect from Voice/VAPI. you would add a websocket leg to the call, either through a vonage.createOutboundCall() or though an NCCO, depending on your application.  The specific websocket JSON for either would be:

      endpoint: [
         {
            type: "websocket",
            uri: URL_OF_YOUR_CONNECTOR_WEBSOCKET+'/optional_uri_parameters',
            "content-type": "audio/l16;rate=16000",
         },
      ],

It is important that the content type is set to the above specifications

For Video AudioConnector, to connect use the following

      vonage.video.connectToWebsocket(
         sessionId,
         token,
         {
            uri: URL_OF_YOUR_CONNECTOR_WEBSOCKET+'/optional_uri_parameters',
            audioRate: 16000,
            bidirectional: true,
            headers: { sessionid: sessionId, type: "AudioConnector" },
         })

## URI Parameters
The URI parameters allow you to pass information into the connector, informing it how to behave.  These are optional, and some will require implementation inside the connector to meet your own requirements

#### Parameters:

  sessionId=xxxxx : A unique identifier (REQUIRED)

  results=url : A url where the results/utterances/transcriptions can be posted (OPTIONAL)

  streamid=xxxx : The video StreamId.  This gets passed back in the "results" post, to help identify the stream for the video AudioConnector (OPTIONAL)

  phone=xxxxx : For Voice/VAPI, the originating phone number of the caller.  This gets passed back in the "results" post, to help identify the caller (OPTIONAL) 

  lang=en|es|fr|de|it|hi|pt : The default starting language for the agent.  Default is en (english) (OPTIONAL)

  temp=0.xx : Temperature, to adjust the NovaSonic AI Temperature (controlling the randomness or creativity of generated text) Default 0.01 (OPTIONAL)

  promptId=xxxxx : You can implement a way of controlling the system prompt, and you can specify which prompt to use with this parameter.  For example, if you have a database of prompts, you can indicate which one you would like to use for this connection by passing in a promptId, then looking up that id in your database.  If nothing specified, the conector will use the DefaultSystemPrompt from constants.ts (OPTIONAL)


