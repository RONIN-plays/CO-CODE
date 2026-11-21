# CoCode

A browser IDE where friends edit code together in real time, talk over voice, and run code.

## Features

- **Editing together:** live editing in the same files, with each person's cursor and name shown in their colour (Monaco + Yjs)
- **Files:** create, rename and delete files; dots show who is in which file
- **Run code** (Ctrl+Enter): JavaScript, TypeScript and Python (via Pyodide) run sandboxed in the browser. Output is shared with the whole room.
- **HTML preview:** linked CSS and JS from the room's files are inlined
- **Voice chat** with mute and a speaking indicator; **screen sharing** while in voice
- **Text chat**, kept with the room
- **Room passwords:** set one when joining a new room, or later with **Lock**
- **Shared terminal** (optional, see the security note below)
- Rooms are saved in `data/`, and the app reconnects by itself

## Run it

```sh
npm install
npm run dev        # http://localhost:5173  (auto-reloads server + client)
```

Production:

```sh
npm run build
npm start          # http://localhost:3001  (set PORT to change)
```

## Inviting friends

Click **Invite** to copy the room link. Friends on other machines need to reach your server over
**https**, because browsers only allow the microphone and screen sharing on https or localhost.
The quickest option is a tunnel:

```sh
npx cloudflared tunnel --url http://localhost:3001
```

## Shared terminal (off by default)

```sh
ENABLE_TERMINAL=1 npm start            # macOS/Linux
$env:ENABLE_TERMINAL=1; npm start      # Windows PowerShell
```

> **Security:** the terminal runs real commands **on the machine hosting the server**. Anyone
> who knows the room password can do anything your user account can. It only works in
> password-protected rooms. Only enable it with people you trust.

The shell starts in `data/workspaces/<room>/`, which mirrors the room's files, so `node main.js`
or `python main.py` just work. It has no TTY: interactive full-screen programs won't work, and
**Kill** is the way to stop a stuck program.

## How it works

| Piece | File |
| --- | --- |
| Server: static files, per-room doc sync, presence, voice signaling | `server/index.js` |
| Room passwords (scrypt) and brute-force limiting | `server/auth.js` |
| Shared terminal and workspace mirroring | `server/terminal.js` |
| WebSocket client with reconnect | `src/connection.ts` |
| Voice, screen sharing, speaking detection (WebRTC) | `src/voice.ts` |
| Running code in a sandbox (JS/TS/Python) and HTML preview | `src/runner.ts` |
| Bottom panel: Output / Terminal / Preview | `src/panels.ts` |
| Ties everything together | `src/main.ts` |

## Known limits

- Rooms without a password are open to anyone with the link.
- Voice uses STUN only. Some strict networks need a TURN server. Add one to `ICE_SERVERS` in `src/voice.ts`.
- Since everyone connects to everyone, voice and screen sharing work best with about 6 people or fewer.
- A synchronous infinite loop in JS (`while(true){}`) can freeze the tab. Python loops can always be stopped.
- Python `input()` isn't supported. npm imports in JS load from esm.sh and need internet.
