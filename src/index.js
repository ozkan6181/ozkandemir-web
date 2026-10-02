const H = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*"
};

function clean(s = "") {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function abs(base, href = "") {
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}

async function txt(url) {
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 ozkandemir.net/2.1" }
  });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return await r.text();
}

function parseTcmb(xml) {
  const wanted = new Set(["USD", "EUR", "GBP", "CHF"]);
  const rates = [];
  const blocks = xml.match(/<Currency\b[\s\S]*?<\/Currency>/g) || [];

  for (const block of blocks) {
    const codeMatch = block.match(/CurrencyCode="([^"]+)"/);
    const code = codeMatch ? codeMatch[1] : "";
    if (!wanted.has(code)) continue;

    const getTag = (tag) => {
      const re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">");
      const m = block.match(re);
      return clean(m ? m[1] : "");
    };

    rates.push({
      code,
      name: getTag("Isim") || getTag("CurrencyName"),
      buy: getTag("ForexBuying"),
      sell: getTag("ForexSelling")
    });
  }

  const dateMatch = xml.match(/Tarih="([^"]+)"/);
  return {
    date: dateMatch ? dateMatch[1] : "",
    rates
  };
}

function parseSgk(html) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html)) && out.length < 8) {
    const text = clean(m[2]);
    const hit = text.match(/^(\d{1,2}\s+\S+\s+20\d{2})\s+(.{18,})$/);
    if (!hit) continue;

    out.push({
      source: "SGK",
      sourceKey: "sgk",
      date: hit[1],
      title: hit[2].replace(/\s+[A-ZÇĞİÖŞÜ ]{8,}$/, "").trim(),
      summary: "Sosyal Güvenlik Kurumu güncel duyurusu.",
      url: abs("https://www.sgk.gov.tr/duyuru", m[1])
    });
  }
  return out;
}

function parseGib(html) {
  const out = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html)) && out.length < 8) {
    const text = clean(m[2]);
    if (text.length < 35 || text.length > 260) continue;
    if (!/(tebliğ|vergi|beyan|rehber|duyuru|karar|mevzuat|defter|fatura|ödeme|başvuru)/i.test(text)) continue;
    if (out.some(x => x.title === text)) continue;

    out.push({
      source: "GİB",
      sourceKey: "gib",
      date: "",
      title: text,
      summary: "Gelir İdaresi Başkanlığı güncel içerik ve mevzuat duyurusu.",
      url: abs("https://www.gib.gov.tr/", m[1])
    });
  }
  return out;
}

function parseResmiGazete(html) {
  const out = [];
  const headingMatch = html.match(/<h6[^>]*>([\s\S]*?)<\/h6>/i);
  const heading = clean(headingMatch ? headingMatch[1] : "");

  if (heading) {
    out.push({
      source: "Resmî Gazete",
      sourceKey: "resmigazete",
      date: "Bugün",
      title: heading,
      summary: "Günün Resmî Gazete sayısı ve yayımlanan düzenlemeler.",
      url: "https://www.resmigazete.gov.tr/"
    });
  }

  const re = /(?:––|&ndash;&ndash;)\s*([^<\n]{20,260})/g;
  let m;
  let count = 0;

  while ((m = re.exec(html)) && count < 7) {
    const title = clean(m[1]);
    if (!title) continue;

    out.push({
      source: "Resmî Gazete",
      sourceKey: "resmigazete",
      date: "",
      title,
      summary: "Resmî Gazete'de yayımlanan güncel düzenleme.",
      url: "https://www.resmigazete.gov.tr/"
    });
    count++;
  }

  return out;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => {
    const key = `${x.sourceKey}|${x.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/tcmb") {
      try {
        const xml = await txt("https://www.tcmb.gov.tr/kurlar/today.xml");
        return new Response(JSON.stringify(parseTcmb(xml)), { headers: H });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "TCMB verisi alınamadı" }),
          { status: 502, headers: H }
        );
      }
    }

    if (url.pathname === "/api/news") {
      try {
        const results = await Promise.allSettled([
          txt("https://www.gib.gov.tr/mevzuat"),
          txt("https://www.sgk.gov.tr/duyuru"),
          txt("https://www.resmigazete.gov.tr/")
        ]);

        let items = [];
        if (results[0].status === "fulfilled") items.push(...parseGib(results[0].value));
        if (results[1].status === "fulfilled") items.push(...parseSgk(results[1].value));
        if (results[2].status === "fulfilled") items.push(...parseResmiGazete(results[2].value));

        items = dedupe(items);

        return new Response(
          JSON.stringify({
            updatedAt: new Date().toISOString(),
            items
          }),
          { headers: H }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Güncel içerikler alınamadı" }),
          { status: 502, headers: H }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
