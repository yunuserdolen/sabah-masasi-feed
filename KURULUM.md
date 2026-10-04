# Sabah Masası akışı — kurulum

Mimari:
```
GitHub Actions (2 saatte bir, ücretsiz)        Cloudflare Worker (ücretsiz)        Claude
  collect.py: RSS + Google News + GDELT   →    MCP: sabah_digest, feed_search,  →  Sabah Masası
  → "data" dalına günlük JSON parçalar         gdelt_search, feed_health            görevi
```

## 1. GitHub
1. `sabah-masasi-feed` adında bir repo aç ve bu klasördeki her şeyi yükle (`.github` klasörü dahil).
2. **Public önerilir**: içerik yalnızca kamuya açık başlık ve linklerden oluşur; public repoda Actions dakikası sınırsızdır. Private seçersen ayda 2.000 dakikalık ücretsiz kotanın yaklaşık yarısı kullanılır ve Worker için salt-okunur bir token gerekir (4. adım).
3. Actions sekmesi → `sabah-masasi-collect` → **Run workflow**. Birkaç dakika sonra repoda `data` adlı bir dal oluşur.
4. `data` dalındaki `health.json`'u aç: `failing` listesindeki kaynakların adresleri değişmiş olabilir. `sources.yaml`'da düzelt ya da `type: gnews` + `q: "site:alanadi when:1d"` biçimine çevir.

## 2. Cloudflare Worker
Bilgisayarında Node.js kurulu olmalı.
```bash
cd worker
npx wrangler login
# wrangler.toml içinde DATA_BASE satırındaki KULLANICI'yı GitHub kullanıcı adınla değiştir
openssl rand -hex 24                   # çıkan dizeyi kopyala
npx wrangler secret put ACCESS_KEY     # yapıştır
npx wrangler secret put GITHUB_TOKEN   # yalnızca repo private ise
npx wrangler deploy
```
Deploy sonunda `https://sabah-masasi-feed.<hesabın>.workers.dev` adresi verilir.

Test:
```bash
curl -s -X POST https://sabah-masasi-feed.<hesabın>.workers.dev/mcp/<ACCESS_KEY> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"feed_health","arguments":{}}}'
```

## 3. Claude'a bağlama
1. Claude ayarlarındaki Connectors bölümünden özel (custom) connector ekle; URL: `https://sabah-masasi-feed.<hesabın>.workers.dev/mcp/<ACCESS_KEY>`. Kimlik doğrulama yok; anahtar URL'nin içinde.
2. Sabah Masası zamanlanmış görevinin bu connector'a erişimi olduğundan emin ol.
3. `KATMAN-2-PROMPT-EKI.md` içindeki bloğu promptun sonuna ekle.

## Bakım
- **Takvim:** `sources.yaml` → `schedule` promptundaki gün düzenini aynalar. Prompt değişirse burayı da güncelle. Seçim masaları `until: 2026-11-30` ile kendiliğinden kapanır.
- **Denge:** her kaynağın `leaning` etiketi kaba bir sınıflandırmadır; digest sonundaki dağılım bu etiketlere göre hesaplanır.
- **Maliyet ayarı:** `sabah_digest` çıktısı bölüm başına 20 öğe ve 110 karakter özetle gelir. Daha ucuzu için promptta `summary_chars: 0` ya da `max_per_section` düşürülebilir.
- **Ücretsiz katman sınırı:** Workers Free istek başına 10 ms CPU verir. "Exceeded CPU" hatası görürsen `max_items_per_feed_per_day` değerini düşür ya da Workers Paid (5 $/ay) planına geç.
- **GDELT** yavaş ya da hız sınırlı olabilir. Toplayıcıda istekler arasında 6 sn bekleniyor; hata `health.json`'a düşer, akışı durdurmaz.
