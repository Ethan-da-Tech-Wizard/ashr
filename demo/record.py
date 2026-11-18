#!/usr/bin/env python3
"""Record the 60-second animation: plays demo/stage.html scene by scene and writes docs/demo-60s.mp4.

Needs Python with Playwright and ffmpeg on the laptop. Nothing here ships with the app.
    python3 demo/record.py            # record
    python3 demo/record.py --dry      # run the timeline without writing a video
"""
import asyncio, base64, functools, glob, http.server, os, shutil, subprocess, sys, tempfile, threading, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "demo-60s.mp4")
PORT = 7801
LENGTH = 60.0
W, H = 1920, 1080
TOP = '.card[data-depth="0"]'
DRY = "--dry" in sys.argv


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def browser_path():
    found = glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell"))
    return sorted(found)[-1] if found else None


class Show:
    """The running animation: a clock, the stage page, and the phone app inside it."""

    def __init__(self, page):
        self.page = page
        self.app = page.frame_locator("#app")
        self.t0 = time.monotonic()
        self.notes = []

    async def at(self, second):
        wait = self.t0 + second - time.monotonic()
        if wait < -0.4:
            self.notes.append(f"late by {-wait:.1f}s at {second}s")
        if wait > 0:
            await asyncio.sleep(wait)

    async def js(self, code):
        await self.page.evaluate(code)

    async def center(self, selector):
        box = await self.app.locator(selector).first.bounding_box()
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    async def ring(self, selector, pad=8, radius=30):
        box = await self.app.locator(selector).first.bounding_box()
        left = max(box["x"] - pad, 1220)
        right = min(box["x"] + box["width"] + pad, 1646)
        await self.js(f"spotAt({left}, {box['y'] - pad}, {right - left}, {box['height'] + 2 * pad}, {radius})")

    async def tap(self, selector, hold=0.25):
        x, y = await self.center(selector)
        await self.js(f"touch({x}, {y})")
        await asyncio.sleep(0.55)
        await self.js(f"touch({x}, {y}, true)")
        await self.page.mouse.move(x, y)
        await self.page.mouse.down()
        await asyncio.sleep(hold)
        await self.page.mouse.up()
        await self.js(f"touch({x}, {y})")

    async def swipe(self, selector, dx):
        box = await self.app.locator(selector).first.bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + 150
        await self.js(f"touch({x}, {y})")
        await asyncio.sleep(0.6)
        await self.js(f"touch({x}, {y}, true)")
        await self.page.mouse.move(x, y)
        await self.page.mouse.down()
        steps = 26
        for i in range(1, steps + 1):
            ease = 1 - (1 - i / steps) ** 2
            px = x + dx * ease
            await self.page.mouse.move(px, y + 4 * ease)
            await self.js(f"touch({px}, {y + 4 * ease}, true, true)")
            await asyncio.sleep(0.028)
        await asyncio.sleep(0.25)
        await self.page.mouse.up()
        await self.js("lift()")


async def play(show):
    s = show
    await s.js("startBar()")
    # 0-5.500: title
    await s.at(2.0); await s.js("loadApp()")
    await s.at(4.6); await s.js("openCover(false); showPhone()")
    # 5.500-13: the problem
    await s.at(5.5); await s.js("scene(1)")
    await s.at(7.5); await s.ring(".herd", 4, 26)
    # 13-18: the card in plain English
    await s.at(13.0); await s.js("scene(2)"); await s.ring(TOP, 6, 42)
    # 18-25: what is this?
    await s.at(18.0); await s.js("scene(3); spotAt(0,0,0,0,0)")
    await s.at(18.8); await s.tap(f'{TOP} [data-act="why"]')
    await s.at(21.0); await s.tap(f'{TOP} .ai-pill[data-ai="gemini"]')
    await s.at(24.2); await s.tap(f'{TOP} [data-act="why"]'); await s.js("lift()")
    # 25-34: deny
    await s.at(25.3); await s.js("scene(4)")
    await s.at(26.4); await s.swipe(TOP, -190)
    await s.at(29.0); await s.tap("#deny-chips .chip >> nth=1")
    await s.at(30.4); await s.tap("#deny-send"); await s.js("lift()")
    # 34-41: allow
    await s.at(34.0); await s.js("scene(5)")
    await s.at(35.6); await s.swipe(TOP, 190)
    # 41-50: redirect
    await s.at(41.0); await s.js("scene(6)"); await s.ring("#decide", 10, 54)
    await s.at(42.6); await s.js("spotAt(0,0,0,0,0)"); await s.tap("#btn-redo")
    await s.at(44.6); await s.tap("#redo-chips .chip >> nth=0")
    await s.at(46.0); await s.tap("#redo-send"); await s.js("lift()")
    # 50-55.500: owners
    await s.at(50.0); await s.js("scene(7)"); await s.ring(".herd", 4, 26)
    # 55.500-60: end card
    await s.at(55.5); await s.js("spotAt(0,0,0,0,0); endCover(true)")
    await s.at(LENGTH)


async def main():
    server = serve()
    frames = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=browser_path())
        page = await browser.new_page(viewport={"width": W, "height": H})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(f"http://127.0.0.1:{PORT}/demo/stage.html")
        await page.wait_for_timeout(500)

        cdp = await page.context.new_cdp_session(page)

        def on_frame(ev):
            frames.append((ev["metadata"]["timestamp"], ev["data"]))
            asyncio.ensure_future(cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]}))

        cdp.on("Page.screencastFrame", on_frame)
        if not DRY:
            await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 80, "everyNthFrame": 2, "maxWidth": W, "maxHeight": H})
        show = Show(page)
        await play(show)
        if not DRY:
            await cdp.send("Page.stopScreencast")
        cards_left = await show.app.locator(".card").count()
        log = await show.app.locator(".entry .verdict").all_inner_texts()
        await browser.close()
    server.shutdown()
    print({"frames": len(frames), "cards_left": cards_left, "last_verdicts": log[:3], "late": show.notes, "errors": errors})
    assert not errors, errors
    assert cards_left == 0, "the three cards should all be answered"
    if DRY:
        return

    tmp = tempfile.mkdtemp(prefix="ashr-anim-")
    start = frames[0][0]
    lines = []
    for i, (ts, data) in enumerate(frames):
        name = os.path.join(tmp, f"f{i:05d}.jpg")
        with open(name, "wb") as f:
            f.write(base64.b64decode(data))
        end = frames[i + 1][0] if i + 1 < len(frames) else start + LENGTH
        lines += [f"file '{name}'", f"duration {max(end - ts, 0.001):.4f}"]
    lines.append(f"file '{name}'")
    listing = os.path.join(tmp, "list.txt")
    with open(listing, "w") as f:
        f.write("\n".join(lines))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-t", str(LENGTH),
                    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", OUT], check=True)
    shutil.rmtree(tmp)
    print("wrote", OUT, f"{os.path.getsize(OUT) / 1e6:.1f} MB")


asyncio.run(main())
