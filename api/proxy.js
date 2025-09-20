// api/proxy.js
import cheerio from "cheerio";

/**
 * Simple Vercel serverless proxy:
 *  - expects ?u=<BASE64-ENCODED-FULL-URL>
 *  - fetches target, if content-type is text/html it rewrites links to pass through this proxy
 *  - injects the Ultraviolet toolbar
 *
 * NOTE: This is for demo/dev. Add auth & rate-limits before public use.
 */

function b64Decode(s) {
  try { return Buffer.from(s, "base64").toString("utf8"); }
  catch (e) { return null; }
}

export default async function handler(req, res) {
  // Basic CORS for development; lock this down for production.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Quick health check
  if (!req.query.u) {
    return res.status(200).send("Proxy ready — provide ?u=<base64(url)>");
  }

  const target = b64Decode(req.query.u);
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("Invalid target. Use ?u=<base64 of full https:// URL>");
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UltravioletProxy/0.1)",
        "Accept": req.headers["accept"] || "*/*"
      },
      redirect: "follow"
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();

    // If HTML, parse & rewrite links then inject toolbar
    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      const $ = cheerio.load(html, { decodeEntities: false });

      // rewrite helper - convert relative -> absolute and wrap through proxy
      function proxifyAttr(selector, attr) {
        $(selector).each((i, el) => {
          const raw = $(el).attr(attr);
          if (!raw) return;
          if (raw.startsWith("data:") || raw.startsWith("javascript:") || raw.startsWith("#")) return;
          try {
            const abs = new URL(raw, target).toString();
            const enc = Buffer.from(abs).toString("base64");
            $(el).attr(attr, `/api/proxy?u=${enc}`);
          } catch (e) {
            // ignore invalid urls
          }
        });
      }

      proxifyAttr("a", "href");
      proxifyAttr("img", "src");
      proxifyAttr("script", "src");
      proxifyAttr('link[rel="stylesheet"]', "href");
      proxifyAttr("iframe", "src");

      // Ultraviolet toolbar HTML + styles (inlined to avoid needing external CSS)
      const toolbar = `
        <style id="ultra-toolbar-styles">
        #uv-toolbar{position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;
          display:flex;gap:8px;align-items:center;backdrop-filter: blur(6px);
          border-radius:12px;padding:8px 12px;border:1px solid rgba(255,255,255,0.06);
          background: linear-gradient(90deg, rgba(86,0,255,0.12), rgba(255,0,200,0.06));
          box-shadow: 0 6px 24px rgba(48,16,96,0.45);font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;}
        #uv-toolbar input[type="text"]{flex:1;padding:8px 10px;border-radius:8px;border:0;background:rgba(0,0,0,0.35);color:#fff;}
        #uv-toolbar button{padding:8px 10px;border-radius:8px;border:0;background:transparent;color:#fff;cursor:pointer}
        #uv-toolbar .uv-brand{font-weight:700;margin-right:6px;color:#fff;letter-spacing:0.6px}
        @media (max-width:640px){#uv-toolbar{flex-direction:column;gap:6px;align-items:stretch}}
        </style>

        <div id="uv-toolbar" aria-hidden="false">
          <div class="uv-brand">ULTRAVIOLET</div>
          <form id="uv-nav" style="display:flex;gap:8px;flex:1">
            <input id="uv-url" type="text" value="${target}" />
            <button id="uv-go" type="submit">Go</button>
          </form>
          <button id="uv-theme">Theme</button>
          <button id="uv-close">Hide</button>
        </div>
        <div style="height:64px"></div>

        <script>
          (function(){
            const form = document.getElementById('uv-nav');
            const input = document.getElementById('uv-url');
            form.addEventListener('submit', e=>{
              e.preventDefault();
              try {
                const url = new URL(input.value).toString();
                const enc = btoa(url);
                window.location.href = '/api/proxy?u=' + enc;
              } catch(err) { alert('Please enter a full URL (including https://)'); }
            });
            document.getElementById('uv-close').addEventListener('click', ()=> {
              document.getElementById('uv-toolbar').style.display = 'none';
            });
            document.getElementById('uv-theme').addEventListener('click', ()=> {
              const cur = document.documentElement.style.filter;
              document.documentElement.style.filter = cur ? '' : 'invert(1) hue-rotate(180deg)';
            });
            // avoid letting the proxied page break our toolbar's clicks
            document.getElementById('uv-toolbar').addEventListener('click', e => e.stopPropagation());
          })();
        </script>
      `;

      $("body").prepend(toolbar);
      const out = $.html();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(upstream.status).send(out);
    }

    // Non-HTML: pipe bytes through with content-type and caching headers
    const buffer = await upstream.arrayBuffer();
    const nodeBuffer = Buffer.from(buffer);
    const cType = upstream.headers.get("content-type");
    if (cType) res.setHeader("Content-Type", cType);
    const cache = upstream.headers.get("cache-control");
    if (cache) res.setHeader("Cache-Control", cache);
    return res.status(upstream.status).send(nodeBuffer);

  } catch (err) {
    console.error("proxy error:", err);
    return res.status(502).send("Upstream fetch error: " + String(err.message || err));
  }
}
