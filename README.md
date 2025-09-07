# Realtime Voice Summary

## Overview
This project is a minimal web app that lets you **talk to a realtime ChatGPT voice assistant** while simultaneously maintaining a **clean, running text summary** of the conversation.

- You interact with the assistant entirely by voice.  
- The assistant replies back in voice (WebRTC audio stream).  
- The UI displays only an evolving summary of the discussion — **never raw voice text**.  
- Summaries update live as you speak, and get re-written definitively right after each assistant reply.  

This architecture makes it possible to both chat naturally with a voice assistant *and* build contextual state (like summaries or function calls) as you go.

---

## Features
- 🔊 **Realtime voice chat** using OpenAI’s Realtime API with server-side voice activity detection (VAD).  
- 📝 **Running summary** using a separate summarizer endpoint — independent of voice to avoid conflicts.  
- ⏱ **Live updates** during speech (via interim transcript).  
- ✅ **Final authoritative summary** after each assistant reply.  
- 🔒 **Strict routing** so the UI never shows voice TTS text.  
- 🌍 **English-only voice** configured at session level to avoid language drift.  

---

## Project Structure
```

realtime-voice-summary/
.git/               # Git version control metadata
README.md           # Project documentation
package.json        # Project metadata and start script
package-lock.json   # Lockfile for Node
server.mjs          # Node server: /session (Realtime voice) + /summary (REST summarizer)
public/
index.html        # Barebones page + React via ESM CDN
app.js            # Client logic: voice engine + summary engine
styles.css        # Optional styling

````

---

## Requirements
- Node.js **18+**  
- Modern Chromium browser (tested in Chrome)  
- An OpenAI API key with access to **Realtime** and **Responses** models  

---

## Getting Started

### 1. Set your API key
```bash
# macOS/Linux
export OPENAI_API_KEY="sk-..."

# Windows PowerShell
setx OPENAI_API_KEY "sk-..."
# then open a new terminal
````

### 2. Run the server

```bash
node server.mjs
```

The app runs at: [http://localhost:8080](http://localhost:8080)

### 3. Use the app

* Open the app in Chrome.
* Click **Connect + Mic** and allow microphone permissions.
* You’ll hear a short greeting.
* Speak naturally and pause:

  * You’ll hear the assistant’s spoken reply.
  * The summary box updates live while you speak and then refreshes after the assistant finishes.

---

## How It Works

### Two-Engine Architecture

**Voice Engine**

* WebRTC session (`/session`) to the `gpt-realtime` model.
* Streams mic audio → gets assistant voice back.
* Provides text too, but UI ignores it; only used for transcript logging.

**Summary Engine**

* Independent REST endpoint (`/summary`) that uses `gpt-4o-mini`.
* Summarizes transcript + optional partial user utterance.
* Returns one concise, updated summary each call.

### Flow

* **While speaking**

  * Browser SpeechRecognition generates interim text.
  * Client POSTs to `/summary` with `{ mode: "live", partial, transcript }`.
  * UI updates with a live guess (not parroting raw words).

* **When you pause**

  * Client explicitly asks the voice engine to reply.
  * Assistant speaks and outputs text → logged to transcript.

* **When assistant finishes**

  * Client POSTs to `/summary` with `{ mode: "final", transcript }`.
  * UI updates with an authoritative summary of the entire conversation.

---

## API Contracts

### `/session`

* **Method**: GET
* **Response**:

```json
{
  "client_secret": "<ephemeral>",
  "base_url": "https://api.openai.com/v1/realtime",
  "model": "gpt-realtime"
}
```

### `/summary`

* **Method**: POST
* **Body**:

```json
{
  "transcript": [{ "role": "user"|"assistant", "text": "..." }],
  "partial": "optional user text",
  "mode": "live"|"final"
}
```

* **Response**:

```json
{ "summary": "one or two sentences" }
```

---

## Common Issues

* **404 /summary**
  Restart the server with the updated `server.mjs` that includes the `/summary` endpoint.

* **No voice reply after greeting**
  Check mic permissions. Verify `input_audio_buffer.speech_stopped` events fire when you pause.

* **Text box echoes my words**
  Expected briefly in *live* mode if the partial input is too short. The *final* summary will replace it.

* **favicon.ico 404**
  Harmless. Add a favicon or ignore.

---

## Next Steps

* Persist transcript + summaries with timestamps.
* Add function calling support (trigger actions from context).
* Add TURN servers for networks that block WebRTC.

---

## License

MIT — free to use and adapt.

