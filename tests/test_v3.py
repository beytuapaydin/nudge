import asyncio
from playwright.async_api import async_playwright
URL='file:///home/claude/v3/nudge.html'
SEED='''[{"id":"a1","title":"Netflix Premium Testphase","type":"subscription_trial","amount":17.99,"currency":"EUR","deadline":"%s","next_action":"Vor Ablauf kündigen, sonst werden 17,99 EUR abgebucht.","confidence":"high","status":"active","reason":null,"rem":{"steps":[3,1,0],"triggered":[],"notified":[],"unresponded":0,"snoozedUntil":null,"pending":null},"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"},
{"id":"a2","title":"Stromrechnung November","type":"bill","amount":86.4,"currency":"EUR","deadline":"%s","next_action":"Überweise den Betrag bis zum Fälligkeitsdatum.","confidence":"high","status":"active","reason":null,"rem":{"steps":[7,3,1,0],"triggered":[],"notified":[],"unresponded":0,"snoozedUntil":null,"pending":null},"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"},
{"id":"a3","title":"Zalando Retoure","type":"return_window","amount":59.9,"currency":"EUR","deadline":"%s","next_action":"Paket bis zum Stichtag zurücksenden.","confidence":"high","status":"active","reason":null,"rem":{"steps":[7,3,1,0],"triggered":[],"notified":[],"unresponded":0,"snoozedUntil":null,"pending":null},"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"},
{"id":"a4","title":"Finanzamt Schreiben","type":"official_letter","amount":null,"currency":null,"deadline":"%s","next_action":"Formular ausfüllen und zurückschicken.","confidence":"medium","status":"active","reason":null,"rem":{"steps":[7,3,1,0],"triggered":[],"notified":[],"unresponded":0,"snoozedUntil":null,"pending":null},"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"},
{"id":"a5","title":"Mietvertrag prüfen","type":"other","amount":null,"currency":null,"deadline":null,"next_action":"Kündigungsfrist nachlesen.","confidence":"low","status":"active","reason":null,"rem":{"steps":[],"triggered":[],"notified":[],"unresponded":0,"snoozedUntil":null,"pending":null},"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"}]'''
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch()
        for theme in ['dark','light']:
            ctx=await b.new_context(viewport={'width':390,'height':844},color_scheme=theme,device_scale_factor=2); pg=await ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
            await pg.goto(URL)
            from datetime import date,timedelta
            d=lambda n:(date(2026,11,24)+timedelta(days=n)).isoformat()
            await pg.evaluate("s=>localStorage.setItem('nudge.html.items',s)", SEED%(d(2),d(3),d(5),d(12)))
            await pg.reload(); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'{theme}_home.png')
            await pg.evaluate("window.scrollTo(0,700)"); await pg.screenshot(path=f'{theme}_home2.png'); await pg.evaluate("window.scrollTo(0,0)")
            await pg.click('[data-a=focus] >> nth=0'); await pg.wait_for_timeout(500); await pg.screenshot(path=f'{theme}_focus.png')
            await pg.click('button[data-a=close] >> nth=0'); 
            await pg.click('[data-a=tab][data-t=all]'); await pg.screenshot(path=f'{theme}_all.png')
            await pg.click('[data-a=tab][data-t=you]'); await pg.screenshot(path=f'{theme}_you.png')
            await pg.click('[data-a=tab][data-t=today]')
            await pg.click('[data-a=example]') if await pg.locator('[data-a=example]').count() else None
            print(theme,'errors',errs)
            await ctx.close()
        await b.close()
asyncio.run(main())
