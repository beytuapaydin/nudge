import asyncio
from playwright.async_api import async_playwright
URL='file:///home/claude/v3/nudge.html'
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); ctx=await b.new_context(viewport={'width':390,'height':844},color_scheme='dark'); pg=await ctx.new_page()
        errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
        items=lambda: pg.evaluate("JSON.parse(localStorage.getItem('nudge.html.items')||'[]')")
        await pg.goto(URL); await pg.screenshot(path='f_empty.png')
        await pg.click('[data-a=example]'); await pg.wait_for_timeout(300); await pg.screenshot(path='f_confirm.png')
        await pg.click('[data-a=save-draft]'); await pg.wait_for_timeout(300)
        print('saved',len(await items()))
        # fake gemini success via composer
        await pg.evaluate("localStorage.setItem('nudge.html.key','x')")
        async def ok(route): 
            await asyncio.sleep(1.2)
            await route.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body='{"candidates":[{"content":{"parts":[{"text":"{\\"title\\":\\"Strom\\",\\"type\\":\\"bill\\",\\"amount\\":58.4,\\"currency\\":\\"EUR\\",\\"deadline\\":\\"2026-11-30\\",\\"next_action\\":\\"Pay it.\\",\\"confidence\\":\\"high\\",\\"language\\":\\"en\\"}"}]}}]}')
        await pg.route('**generativelanguage.googleapis.com/**', ok)
        await pg.fill('#cx','Stromrechnung 58,40 EUR bis 30.11.'); await pg.press('#cx','Enter'); await pg.wait_for_timeout(500); await pg.screenshot(path='f_reading.png')
        await pg.wait_for_selector('[data-a=save-draft]'); await pg.click('[data-a=save-draft]'); await pg.wait_for_timeout(300)
        print('after composer',len(await items()))
        # day filter
        await pg.click('.day >> nth=6'); await pg.wait_for_timeout(200); await pg.screenshot(path='f_day.png'); await pg.click('.day.sel')
        # snooze + undo
        await pg.click('.now [data-a=snooze]'); await pg.click('[data-a=snz][data-d="3"]'); await pg.wait_for_timeout(500); await pg.screenshot(path='f_toast.png')
        await pg.click('[data-a=undo]'); await pg.wait_for_timeout(200)
        print('snooze undone', [i['rem']['snoozedUntil'] for i in await items()])
        # done -> you tab insight
        await pg.click('.now [data-a=done]'); await pg.wait_for_timeout(500)
        await pg.click('[data-a=tab][data-t=you]'); await pg.wait_for_timeout(200); await pg.screenshot(path='f_you.png')
        # wait-reply through focus
        await pg.click('[data-a=tab][data-t=today]'); await pg.click('.now h2'); await pg.click('[data-a=wait-reply]'); await pg.wait_for_timeout(400)
        print('statuses',[i['status'] for i in await items()])
        # 503 path
        await pg.unroute('**generativelanguage.googleapis.com/**'); await pg.route('**generativelanguage.googleapis.com/**', lambda r: r.fulfill(status=503,body='{}'))
        await pg.fill('#cx','hello'); await pg.press('#cx','Enter'); await pg.wait_for_selector('[data-a=retry]',timeout=20000); await pg.screenshot(path='f_err.png')
        await pg.click('[data-a=manual]'); await pg.fill('#cf [name=title]','Manual'); await pg.fill('#cf [name=next]','Do'); await pg.click('#cf button[type=submit]')
        print('after manual',len(await items()))
        await pg.reload(); await pg.evaluate("localStorage.setItem('nudge.html.lastOpen', String(Date.now()-5*864e5))"); await pg.reload()
        print('welcome',await pg.locator('.insight').count()); await pg.screenshot(path='f_welcome.png')
        print('errors',errs); await b.close()
asyncio.run(main())
