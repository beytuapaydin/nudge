# Nudge Cloud

E-posta hatırlatmalı Nudge: tarayıcı uygulaması + Supabase (AB bölgesi) + Resend.

```
web/
  nudge.html            uygulama (CLOUD boşsa tamamen yerel çalışır)
  reminder-action.html  e-postadaki Done/Snooze onay sayfası (statik)
  nudge-landing.html    bekleme listesi sayfası
  nudge-eval.html       çıkarma doğruluk testi (15 sahte doküman)
supabase/
  schema.sql            tablolar, RLS, kota, satır sınırı, saatlik cron
  config.toml
  functions/            extract-nudge, send-reminders, handle-reminder-action, delete-account
```

## Kurulum (sırayla)

1. **Supabase projesi:** supabase.com → yeni proje, bölge Frankfurt veya Ireland. Settings → API'den Project URL, anon key ve service_role key'i not et. service_role key'i asla tarayıcı koduna koyma.
2. **Resend:** resend.com → alan adını doğrula (Domains). Doğrulanmamış `onboarding@resend.dev` yalnızca kendi adresine gönderir. API key oluştur.
3. **Giriş e-postası için özel SMTP:** Supabase → Authentication → SMTP ayarlarına Resend SMTP bilgilerini gir. Yerleşik e-posta servisi gerçek kullanıcılar için çok sınırlı.
4. **Gizli anahtarlar** (rastgele metin için: `openssl rand -hex 32`):
   ```
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase secrets set GEMINI_API_KEY="..." RESEND_API_KEY="re_..." \
     RESEND_FROM_EMAIL="Nudge <hello@senin-domainin.com>" \
     CRON_SECRET="..." ACTION_SIGNING_SECRET="..." \
     ACTION_PAGE_URL="https://SENIN-ADRESIN/reminder-action.html"
   ```
5. **Fonksiyonları yayınla:**
   ```
   supabase functions deploy extract-nudge
   supabase functions deploy send-reminders
   supabase functions deploy handle-reminder-action
   supabase functions deploy delete-account
   ```
6. **Veritabanı:** SQL Editor'a `supabase/schema.sql` içeriğini yapıştır. Önce en alttaki `YOUR_PROJECT_REF` ve `YOUR_CRON_SECRET` değerlerini değiştir, sonra çalıştır. Betik tekrar çalıştırılabilir.
7. **Web dosyalarını yayınla** (Cloudflare Pages, Netlify veya GitHub Pages). Sihirli bağlantı `file://` ile çalışmaz, bir adres gerekir.
   - `nudge.html` içinde `const CLOUD = { url: '', anonKey: '' }` satırını doldur (URL ve **anon** key).
   - `reminder-action.html` içinde `FUNCTION_URL` değerini doldur.
   - Supabase → Authentication → URL Configuration: Site URL ve Redirect URLs'e `nudge.html` adresini ekle.
8. **Gemini anahtarı ücretsiz katmanda mı?** Google'ın güncel şartlarını oku: ücretsiz katmanda gönderilen içerik ürün geliştirmede kullanılabiliyor olabilir. Gerçek kullanıcı belgeleri almadan önce kontrol et.

## İlk uçtan uca test

1. Yayınlanan `nudge.html`'i aç, "Sign in for email reminders" ile e-postanla giriş yap.
2. Yarın biten bir öğe ekle (örneğin "Try an example" + tarihi değiştir).
3. Hatırlatmayı elle tetikle (normalde her kullanıcının yerel saatiyle 08:00'de çalışır):
   ```
   curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-reminders \
     -H "x-cron-secret: CRON_SECRET" -H "Content-Type: application/json" \
     -d '{"force":true}'
   ```
4. Gelen e-postada Done'a tıkla, onay sayfasında onayla, `nudge_items` tablosunda durumun `done` olduğunu doğrula.

## Davranış notları

- Giriş yapılmışken tarayıcı bildirimleri kapalıdır (hatırlatmalar e-postayla gelir, çift hatırlatma olmaz).
- Giriş yapılmamışsa uygulama eskisi gibi yerel çalışır (kendi Gemini anahtarınla).
- E-posta alıcısı her zaman giriş kaydındaki doğrulanmış adrestir, istemciden gelen bir alan değildir.
- "Delete all my data" girişliyken hesabı ve sunucudaki tüm kayıtları siler.
- Sistem istemi üç yerde aynı olmalı: `nudge.html`, `nudge-eval.html`, `extract-nudge/index.ts`.

---
## v2: yeni arayüz (bu sürümde değişenler)
- `web/nudge.html` yeniden tasarlandı: tek büyük "+ Ekle", sıradaki en fazla 3 kayıt, Türkçe/English (Ayarlar), karanlık tema, Ertele (yarın / 3 gün / gelecek hafta), 8 sn Geri al, 3+ gün sonra "Seni tekrar görmek güzel" kartı, kayıt detayı + 7/3/1/0 zaman çizelgesi, "Yanıt bekliyorum".
- Veri modeli, localStorage anahtarları (`nudge.html.*`), test edilmiş Gemini prompt'u, Supabase oturumu, sunucu çıkarımı, hesap silme ve hatırlatma mantığı **aynen korundu**; eski kayıtlar ve anahtar çalışmaya devam eder.
- Kurulum adımları yukarıdakiyle aynı (CLOUD alanlarını doldur).
- `tests/`: Playwright duman testleri (`python3 tests/test_ui.py`, `test_cloud.py`; yollar bu makineye göre yazıldı, kendi yoluna göre düzenle).

---
## v3: tam arayüz tasarımı
Gece (parıltılı mor) ve Gün temaları (Sen sekmesinden: Otomatik/Gece/Gün), hafta şeridi, "Şimdi önemli" kartı, zaman çizelgesi, altta yakalama çubuğu (yaz / fotoğraf / ses), halkalı odak ekranı, Bugün-Tümü-Sen sekmeleri, aylık "unutmadan hallettin" özeti (seri yok). Mantık, bulut ve anahtarlar v2 ile aynı.
