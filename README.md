# ozkandemir.net V2
V2: 6 özel yazılım tanıtımı, TCMB canlı gösterge kurları, TradingView piyasa görünümü ve GİB/SGK/Resmî Gazete canlı içerik akışı.

Cloudflare Workers Static Assets + Worker API kullanır.
Deploy: `npx wrangler deploy`

Dizinler:
- public/: web sitesi
- src/index.js: canlı veri API katmanı
- wrangler.jsonc: Cloudflare yapılandırması

Piyasa verileri sağlayıcı ve borsaya göre gecikmeli olabilir.