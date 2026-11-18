# Astralena AI - Telegram bot (JavaScript)

An AI that talks like a person, with a deep love for outer space, technology and innovation, mechatronics, robotics and software engineering.
Chat, images, stickers, videos, voice notes (female voices), websites, a big toolbox, inline mode, guest mode and secretary mode. Powered by Groq. No emojis anywhere.

## What's new in 5.0
- **Agent**: Astralena now picks and chains tools herself (web search, reading links, weather and space data, reminders, screenshots, files, images, QR codes, calculator, memory). Messages that need no tools use the fast streaming path.
- **Documents**: send a PDF, Word, Excel, PowerPoint, text, CSV, JSON, HTML or code file and ask about it (up to 20 MB). Reply to a document with a question and she loads it.
- **Long-term memory**: she remembers useful facts about each person. `/memory`, `/remember`, `/forget`, `/memory off`.
- **Owner controls**: `/broadcast`, `/ban`, `/unban`, `/banned`, `/usage`, error alerts sent to you, daily message limit and hourly heavy-tool limit per person.
- **Group moderation**: `/warn` `/unwarn` `/warns` `/mute` `/unmute` `/kick` `/antilink` `/antiflood` `/welcome` `/rules` (make the bot a group admin).
- **Real web search**: `/search`, and the agent uses it for anything current. Better results with a free `TAVILY_API_KEY` or `BRAVE_API_KEY`.

## Deploy (Pterodactyl or any Node host)
1. Upload the zip and extract it into the server's root folder.
2. Open `.env` and fill in `GROQ_API_KEY` (required) and `OWNER_ID`. Replace `TELEGRAM_BOT_TOKEN` if Astralena is a new bot.
3. Startup command: `npm install && node index.js` (Node 18+, Node 20 or 22 recommended).
4. Turn on the modes you want in BotFather (see below), then send `/modes` to the bot to check them.

## The three special modes
- **Inline mode**: BotFather chat, `/setinline`, pick the bot, give it a placeholder. Then type `@botusername question` in any chat.
- **Guest mode**: only in the BotFather **Mini App**. Open the BotFather profile, tap Open App (or Menu), pick the bot, Settings, Guest Mode. Then tag the bot in a chat it is not in; it answers once and appears as "bot for you".
- **Secretary mode** (the new name for Business Mode): BotFather, `/mybots`, the bot, Bot Settings, Secretary Mode, Turn on. Then in your own Telegram: Settings, Chat automation (or Telegram Business, Chatbots), enter the bot's username and allow replies. Send the bot `/secretary on`. It stays off until you do. It only answers other people, stays quiet while you are typing in a chat, and introduces itself as your AI assistant. `/secretary brief <text>` tells it how to handle people.

### Pterodactyl notes
- Use the **Node.js egg**, Node 20 or newer. Set the main file to `index.js`. The egg runs `npm install` on start when it finds `package.json`.
- No ports are needed, the bot uses polling. Give the server at least 512 MB RAM (1 GB if people scrape big sites).
- Everything is pure JavaScript, no root, no apt, no system packages. `data/` (settings, memory, bans) and `temp/` live inside the server folder, so back up `data/` before reinstalling.
- `ffmpeg-static` and `sharp` ship their own binaries. If your host blocks that download, voice notes still work and only GIFs and video tools are affected.
- Puppeteer/Chromium usually does not run on shared panels (missing system libraries), so `/record` stays off there. Everything else works without it.
- Code running is off unless you point `PISTON_URL` at a Piston server. I did not add local code execution because it is unsafe on a shared panel.

## How people use it
- DM: just talk. Replies stream live. Groups: say "astralena", tag the bot, or reply to it.
- Image: numbered menu. Sticker: sticker reply (if `STICKER_PACKS` is set) then a menu. Voice notes work both ways, `/voice` picks the voice.
- Websites, in plain language: reply to a link with "astralena screenshot this page for me", "explore this", "scrape this into a zip", "record this site" or "download this". Or use `/screenshot`, `/explore`, `/scrape`, `/record`, `/fetch`.
- `/tools` lists everything: ISS, crew, launches, NASA picture, weather, wiki, define, translate, calc, convert, remind, QR, colour, image generation, text to speech, IP, DNS, headers, short links, password, hash, base64, free open-source apps (`/app`), `/ping`, `/id`, `/stats`.

## Notes
- `ffmpeg` is needed for GIFs, video tools and nicer voice notes. `ffmpeg-static` installs automatically; voice notes still work without it.
- Voice test: send `/voicetest` to see what works on your server.
- `/record` and sharper screenshots of JavaScript-heavy sites need a real browser: run `npm install puppeteer` (it downloads Chromium) or install `puppeteer-core` and set `CHROME_PATH`. Without it, screenshots use free online services and `/record` explains it is unavailable.
- `/scrape` makes a static offline copy (HTML, CSS, JS, images, fonts). Content a site builds with JavaScript after loading may be missing.
- `/app` searches free and open-source apps on F-Droid and sends the APK. It does not fetch paid or cracked apps.
- Data lives in `data/astralena.json` (created automatically).
